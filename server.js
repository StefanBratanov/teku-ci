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

    // Summarise job outcomes for the UI
    const failedJobs = jobs.filter((j) => j.conclusion === 'failure').map((j) => j.name);
    const skippedTestJobs = jobs.filter((j) =>
      j.conclusion === 'skipped' && /unit|integration|acceptance|property|reference/i.test(j.name)
    ).map((j) => j.name);

    console.log(`Run ${runId}: downloading ${testArtifacts.length} test artifacts…`);

    const artifactResults = await Promise.all(
      testArtifacts.map((a) => downloadArtifact(a.id, a.name, token))
    );

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
      artifacts: artifactResults,
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
