import express from 'express';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

const app = express();
const PORT = process.env.PORT || 3000;
const OWNER = 'Consensys';
const REPO = 'teku';

app.use(express.static('public'));

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  isArray: (tagName) => ['testsuite', 'testcase'].includes(tagName),
  parseAttributeValue: false,
});

const cache = new Map();

async function ghFetch(path, token) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'teku-ci' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { headers });
}

async function ghJson(path, token) {
  const res = await ghFetch(path, token);
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`), { status: res.status });
  }
  return res.json();
}

function extractFailure(node) {
  if (!node) return null;
  if (typeof node === 'string') return { message: node.split('\n')[0], detail: node };
  return { message: node.message || node['#text']?.split('\n')[0] || '', detail: node['#text'] || node.message || '', type: node.type || '' };
}

function parseXml(xml) {
  let parsed;
  try { parsed = xmlParser.parse(xml); } catch { return []; }
  const suites = parsed.testsuites?.testsuite || parsed.testsuite || [];
  return suites.filter(Boolean).map((suite) => {
    const testcases = (suite.testcase || []).map((tc) => {
      let status = 'passed', failure = null;
      if (tc.failure !== undefined) { status = 'failed'; failure = extractFailure(tc.failure); }
      else if (tc.error !== undefined) { status = 'error'; failure = extractFailure(tc.error); }
      else if (tc.skipped !== undefined) { status = 'skipped'; }
      return { classname: tc.classname || '', name: tc.name || '', time: parseFloat(tc.time) || 0, status, failure };
    });
    return { name: suite.name || 'Unknown', time: parseFloat(suite.time) || 0, testcases };
  });
}

async function downloadArtifact(artifactId, artifactName, token) {
  const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'teku-ci' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts/${artifactId}/zip`,
    { headers, redirect: 'follow' }
  );
  if (!res.ok) return { artifactName, suites: [], error: `HTTP ${res.status}` };
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const suites = [];
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.endsWith('.xml')) continue;
    try { suites.push(...parseXml(entry.getData().toString('utf8'))); }
    catch (e) { console.error(`Parse error ${entry.entryName}: ${e.message}`); }
  }
  return { artifactName, suites };
}

// ── Check run summary fallback (for expired artifacts) ───────────────────────

const TEST_REPORT_JOB_RE = /^(unit|integration|acceptance|property|reference)TestsReport$/i;

function htmlDecode(str) {
  return str.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, '').trim();
}

// Parse dorny/test-reporter HTML summary into structured suites
function parseReportHtml(name, html) {
  if (!html) return null;

  // Extract stats row: Tests | Passed | Failed | Skipped
  const statsMatch = html.match(/<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>/);
  const total    = statsMatch ? parseInt(statsMatch[1]) : 0;
  const passed   = statsMatch ? parseInt(statsMatch[2]) : 0;
  const failed   = statsMatch ? parseInt(statsMatch[3]) : 0;
  const skipped  = statsMatch ? parseInt(statsMatch[4]) : 0;

  // Extract individual failures from <details> blocks
  const testcases = [];

  // Add all non-failed tests as a single passed block so counts show correctly
  const passCount = passed + skipped;

  // Extract failures: dorny/test-reporter wraps each failure in <details>
  const detailsRe = /<details[^>]*>([\s\S]*?)<\/details>/gi;
  let m;
  while ((m = detailsRe.exec(html)) !== null) {
    const inner = m[1];
    const summaryMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
    if (!summaryMatch) continue;
    const rawName = htmlDecode(stripTags(summaryMatch[1])).replace(/^[❌✅⚠️\s]+/, '').trim();
    if (!rawName || rawName.length < 3) continue;

    // Stack trace is in <pre> or remaining text after <summary>
    const preMatch = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(inner);
    const raw = preMatch ? htmlDecode(preMatch[1]).trim() : '';

    // Skip non-test details (e.g. suite-level details with no stack trace)
    if (!raw && !preMatch) continue;

    const lines = raw.split('\n');
    testcases.push({
      classname: name,
      name: rawName,
      time: 0,
      status: 'failed',
      failure: {
        message: lines[0]?.trim() || rawName,
        detail: raw,
        type: '',
      },
    });
  }

  // If no <details> failures found, try to extract from table rows with ❌
  if (testcases.length === 0 && failed > 0) {
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    while ((m = rowRe.exec(html)) !== null) {
      const row = m[1];
      if (!row.includes('❌') && !row.includes('failure')) continue;
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => htmlDecode(stripTags(c[1])).trim());
      const testName = cells.find(c => c.length > 3 && !/^\d+$/.test(c) && !['❌','✅','⚠️'].includes(c));
      if (testName) {
        testcases.push({ classname: name, name: testName, time: 0, status: 'failed', failure: { message: testName, detail: '', type: '' } });
      }
    }
  }

  return {
    name,
    time: 0,
    total, passed, failed, skipped,
    testcases,
    fromCheckRun: true,
  };
}

async function fetchCheckRunSummaries(sha, token) {
  if (!token) return [];

  // Use GraphQL — REST API returns null for output.summary on public repos without specific scopes
  const query = `{
    repository(owner: "${OWNER}", name: "${REPO}") {
      object(expression: "${sha}") {
        ... on Commit {
          checkSuites(first: 20) {
            nodes {
              checkRuns(first: 100) {
                nodes { databaseId name conclusion summary }
              }
            }
          }
        }
      }
    }
  }`;

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'teku-ci',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) return [];
  const data = await res.json();
  if (data.errors) { console.error('GraphQL errors:', data.errors); return []; }

  const allRuns = (data.data?.repository?.object?.checkSuites?.nodes || [])
    .flatMap(s => s.checkRuns?.nodes || []);

  // Deduplicate by name (same check run can appear in multiple suites)
  const seen = new Set();
  const testReportRuns = allRuns.filter(cr => {
    if (!TEST_REPORT_JOB_RE.test(cr.name) || seen.has(cr.name)) return false;
    seen.add(cr.name);
    return true;
  });

  return testReportRuns
    .map(cr => parseReportHtml(cr.name, cr.summary))
    .filter(Boolean);
}

// GET /api/run/:runId
app.get('/api/run/:runId', async (req, res) => {
  const { runId } = req.params;
  const token = req.query.token || process.env.GITHUB_TOKEN || '';
  const cacheKey = `${runId}:${token.slice(-6)}`;

  if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

  try {
    const [runData, { artifacts = [] }, { jobs = [] }] = await Promise.all([
      ghJson(`/repos/${OWNER}/${REPO}/actions/runs/${runId}`, token),
      ghJson(`/repos/${OWNER}/${REPO}/actions/runs/${runId}/artifacts?per_page=100`, token),
      ghJson(`/repos/${OWNER}/${REPO}/actions/runs/${runId}/jobs?per_page=100`, token),
    ]);

    const testArtifacts = artifacts.filter((a) =>
      /^(unit|integration|acceptance|property|reference)-reports-/.test(a.name)
    );
    const expiredCount = testArtifacts.filter((a) => a.expired).length;
    const downloadableArtifacts = testArtifacts.filter((a) => !a.expired);

    // Summarise job outcomes for the UI
    const failedJobs = jobs.filter((j) => j.conclusion === 'failure').map((j) => j.name);
    const skippedTestJobs = jobs.filter((j) =>
      j.conclusion === 'skipped' && /unit|integration|acceptance|property|reference/i.test(j.name)
    ).map((j) => j.name);

    console.log(`Run ${runId}: ${downloadableArtifacts.length} downloadable, ${expiredCount} expired test artifacts…`);

    const artifactResults = await Promise.all(
      downloadableArtifacts.map((a) => downloadArtifact(a.id, a.name, token))
    );

    // Fall back to check run summaries when all artifacts are expired
    let checkRunSuites = [];
    if (expiredCount > 0 && downloadableArtifacts.length === 0) {
      console.log(`Run ${runId}: fetching check run summaries (artifacts expired)…`);
      checkRunSuites = await fetchCheckRunSummaries(runData.head_sha, token);
      console.log(`Run ${runId}: got ${checkRunSuites.length} check run summaries`);
    }

    const result = {
      run: {
        id: runData.id,
        name: runData.name,
        status: runData.status,
        conclusion: runData.conclusion,
        created_at: runData.created_at,
        head_branch: runData.head_branch,
        head_sha: runData.head_sha?.slice(0, 7),
        html_url: runData.html_url,
        actor: runData.actor?.login,
        run_number: runData.run_number,
      },
      jobs: { failed: failedJobs, skippedTests: skippedTestJobs },
      expiredArtifacts: expiredCount,
      artifacts: artifactResults,
      checkRunSuites,
    };

    if (runData.status === 'completed') cache.set(cacheKey, result);
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Catch-all: return JSON 404 instead of Express's default HTML error page
app.use('/api', (req, res) => res.status(404).json({ error: `No route: ${req.method} ${req.path}` }));

app.listen(PORT, () => console.log(`Teku CI → http://localhost:${PORT}`));
