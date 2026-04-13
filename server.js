import express from 'express';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('ERROR: GITHUB_TOKEN environment variable must be set.');
  process.exit(1);
}

const OWNER = 'Consensys';
const REPO  = 'teku';
const PORT  = process.env.PORT || 3000;

// Refresh every 1 min normally; every 30s when any PR is still building
const SLOW_INTERVAL = 60 * 1000;
const FAST_INTERVAL = 30 * 1000;

// ── XML parser ───────────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  isArray: (t) => ['testsuite', 'testcase'].includes(t),
  parseAttributeValue: false,
});

// ── GitHub helpers ───────────────────────────────────────────────────────────

async function ghFetch(path) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'teku-ci',
    },
  });
  return res;
}

async function ghJson(path) {
  const res = await ghFetch(path);
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`), { status: res.status });
  }
  return res.json();
}

async function ghGraphQL(query) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'teku-ci',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.errors) { console.error('GraphQL errors:', JSON.stringify(data.errors)); return null; }
  return data.data;
}

// ── JUnit XML parsing ────────────────────────────────────────────────────────

function extractFailure(node) {
  if (!node) return null;
  if (typeof node === 'string') return { message: node.split('\n')[0], detail: node };
  return {
    message: node.message || node['#text']?.split('\n')[0] || '',
    detail:  node['#text'] || node.message || '',
    type:    node.type || '',
  };
}

// If the same test appears multiple times (Gradle retry plugin), resolve to final outcome:
// any passing attempt → flaky pass; all failed → genuine failure.
function deduplicateRetries(testcases) {
  const groups = new Map();
  for (const tc of testcases) {
    const key = `${tc.classname}\0${tc.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tc);
  }
  const result = [];
  for (const [, attempts] of groups) {
    if (attempts.length === 1) { result.push(attempts[0]); continue; }
    const passed = attempts.find(tc => tc.status === 'passed');
    result.push(passed ?? attempts[attempts.length - 1]);
  }
  return result;
}

function parseXml(xml) {
  let parsed;
  try { parsed = xmlParser.parse(xml); } catch { return []; }
  const suites = parsed.testsuites?.testsuite || parsed.testsuite || [];
  return suites.filter(Boolean).map((suite) => {
    const raw = (suite.testcase || []).map((tc) => {
      let status = 'passed', failure = null;
      if (tc.failure !== undefined) { failure = extractFailure(tc.failure); if (failure) status = 'failed'; }
      else if (tc.error !== undefined) { failure = extractFailure(tc.error); if (failure) status = 'error'; }
      else if (tc.skipped !== undefined) { status = 'skipped'; }
      return { classname: tc.classname || '', name: tc.name || '', time: parseFloat(tc.time) || 0, status, failure };
    });
    const testcases = deduplicateRetries(raw);
    return { name: suite.name || 'Unknown', time: parseFloat(suite.time) || 0, testcases };
  });
}

// Keep failures + skipped cases + aggregate counts; passing test objects are discarded.
// The frontend already handles this compact format (suite.total / suite.passed / suite.skipped).
function compactSuites(suites) {
  return suites.map(({ name, time, testcases }) => {
    const passed  = testcases.filter(t => t.status === 'passed').length;
    const skipped = testcases.filter(t => t.status === 'skipped');
    const failures = testcases.filter(t => t.status === 'failed' || t.status === 'error');
    return { name, time, total: testcases.length, passed, skipped: skipped.length, testcases: [...failures, ...skipped] };
  });
}

// Precompute counts from already-compacted artifacts/checkRunSuites for the state endpoint.
function computeTestCounts(artifacts, checkRunSuites) {
  let total = 0, fail = 0, pass = 0, skip = 0;
  for (const art of (artifacts || []))
    for (const s of (art.suites || [])) {
      fail  += s.testcases.length; // compact: only failures stored
      total += s.total  || 0;
      pass  += s.passed  || 0;
      skip  += s.skipped || 0;
    }
  for (const s of (checkRunSuites || [])) {
    fail  += (s.testcases || []).filter(t => t.status === 'failed' || t.status === 'error').length;
    total += s.total  || 0;
    pass  += s.passed  || 0;
    skip  += s.skipped || 0;
  }
  return { total, fail, pass, skip };
}

async function downloadAndParseArtifact(artifactId, artifactName) {
  const res = await ghFetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts/${artifactId}/zip`
  );
  if (!res.ok) return { artifactName, suites: [], error: `HTTP ${res.status}` };
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const suites = [];
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.endsWith('.xml')) continue;
    try { suites.push(...parseXml(entry.getData().toString('utf8'))); }
    catch (e) { console.error(`Parse error ${entry.entryName}: ${e.message}`); }
  }
  // Deduplicate suite names within this ZIP (handles ZIPs that contain both
  // individual TEST-*.xml and an aggregate XML for the same suites).
  // Prefer the suite with more test cases (more granular data).
  const bySuiteName = new Map();
  for (const s of suites) {
    const existing = bySuiteName.get(s.name);
    if (!existing || s.testcases.length > existing.testcases.length)
      bySuiteName.set(s.name, s);
  }
  return { artifactName, suites: compactSuites([...bySuiteName.values()]) };
}

// Deduplicate suite names across artifacts — prevents inflated counts when each
// parallel CI artifact contains the full test report instead of just its own partition.
function deduplicateSuites(artifactResults) {
  const seen = new Set();
  for (const art of artifactResults) {
    art.suites = (art.suites || []).filter(s => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
  }
}

// ── Check-run summary fallback (expired artifacts) ───────────────────────────

const TEST_REPORT_RE = /^(unit|integration|acceptance|property|reference)TestsReport$/i;

function htmlDecode(s) {
  return s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
          .replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
function stripTags(s) { return s.replace(/<[^>]+>/g, '').trim(); }

function parseReportHtml(name, html) {
  if (!html) return null;
  const statsMatch = html.match(/<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>/);
  const total = statsMatch ? parseInt(statsMatch[1]) : 0;

  const testcases = [];
  const detailsRe = /<details[^>]*>([\s\S]*?)<\/details>/gi;
  let m;
  while ((m = detailsRe.exec(html)) !== null) {
    const inner = m[1];
    const sumM = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
    if (!sumM) continue;
    const rawName = htmlDecode(stripTags(sumM[1])).replace(/^[❌✅⚠️\s]+/, '').trim();
    if (!rawName || rawName.length < 3) continue;
    const preM = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(inner);
    const raw = preM ? htmlDecode(preM[1]).trim() : '';
    testcases.push({
      classname: name, name: rawName, time: 0, status: 'failed',
      failure: { message: raw.split('\n')[0]?.trim() || rawName, detail: raw, type: '' },
    });
  }
  return { name, time: 0, total, testcases, fromCheckRun: true };
}

async function fetchCheckRunSummaries(sha) {
  const data = await ghGraphQL(`{
    repository(owner: "${OWNER}", name: "${REPO}") {
      object(expression: "${sha}") {
        ... on Commit {
          checkSuites(first: 20) {
            nodes {
              checkRuns(first: 100) {
                nodes { name conclusion summary }
              }
            }
          }
        }
      }
    }
  }`);
  if (!data) return [];
  const seen = new Set();
  return (data.repository?.object?.checkSuites?.nodes || [])
    .flatMap(s => s.checkRuns?.nodes || [])
    .filter(cr => {
      if (!TEST_REPORT_RE.test(cr.name) || seen.has(cr.name)) return false;
      seen.add(cr.name); return true;
    })
    .map(cr => parseReportHtml(cr.name, cr.summary))
    .filter(Boolean);
}

// ── CI run helpers ───────────────────────────────────────────────────────────

async function getLatestCIRun(sha) {
  const data = await ghJson(`/repos/${OWNER}/${REPO}/actions/runs?head_sha=${sha}&per_page=20`);
  const runs = data.workflow_runs || [];
  return runs.find(r => r.name === 'ci' || r.path?.includes('ci.yml')) || runs[0] || null;
}

function fmtRun(run) {
  if (!run) return null;
  return { id: run.id, status: run.status, conclusion: run.conclusion,
           html_url: run.html_url, run_number: run.run_number, created_at: run.created_at };
}

// ── Process a single PR → determine status + fetch test data ─────────────────

async function processPR(prMeta, existingState) {
  const run = await getLatestCIRun(prMeta.head.sha);

  // Nothing changed for a completed run — preserve test data, update metadata only
  // But re-process if GitHub now says success while we cached a failure (race condition on partial artifacts)
  const cachedStale = existingState?.status === 'failing' && run?.conclusion === 'success';
  if (existingState?.runId === run?.id && run?.status === 'completed' &&
      existingState.status !== 'building' && !cachedStale) {
    return { ...existingState, ...prBase(prMeta) };
  }

  const base = { ...prBase(prMeta), runId: run?.id || null, run: fmtRun(run) };

  if (!run || run.status === 'queued') {
    return { ...base, status: 'pending' };
  }

  const [{ artifacts = [] }, { jobs = [] }] = await Promise.all([
    ghJson(`/repos/${OWNER}/${REPO}/actions/runs/${run.id}/artifacts?per_page=100`),
    ghJson(`/repos/${OWNER}/${REPO}/actions/runs/${run.id}/jobs?per_page=100`),
  ]);

  // Re-runs leave stale artifacts behind with the same name but a lower id.
  // Keep only the highest-id artifact per name (most recent upload = latest attempt).
  const allTestArtifacts = artifacts.filter(a => /^(unit|integration|acceptance|property|reference)-reports-/.test(a.name));
  const byName = new Map();
  for (const a of allTestArtifacts) {
    if (!byName.has(a.name) || a.id > byName.get(a.name).id) byName.set(a.name, a);
  }
  const testArtifacts = [...byName.values()];
  const expiredCount   = testArtifacts.filter(a => a.expired).length;
  const downloadable   = testArtifacts.filter(a => !a.expired);
  const failedJobs     = jobs.filter(j => j.conclusion === 'failure').map(j => j.name);
  const skippedTests   = jobs.filter(j => j.conclusion === 'skipped' && /unit|integration|acceptance|property|reference/i.test(j.name)).map(j => j.name);
  const inProgressJobs = jobs.filter(j => j.status === 'in_progress').map(j => j.name);

  // Build in progress
  if (run.status === 'in_progress') {
    // Download whatever test artifacts are already available
    const partial = downloadable.length > 0
      ? await Promise.all(downloadable.map(a => downloadAndParseArtifact(a.id, a.name)))
      : [];
    deduplicateSuites(partial);
    return { ...base, status: 'building', inProgressJobs, artifacts: partial,
             jobs: { failed: failedJobs, skippedTests },
             testCounts: computeTestCounts(partial, []), hasArtifacts: partial.length > 0 };
  }

  // Build failed — check if tests actually ran (summaries tell us even without artifacts)
  const nonTestFailed = failedJobs.filter(n => !/Report|Result/i.test(n));
  if (testArtifacts.length === 0 && nonTestFailed.length > 0) {
    const checkRunSuites = await fetchCheckRunSummaries(prMeta.head.sha);
    return { ...base, status: 'build_failed', checkRunSuites,
             jobs: { failed: failedJobs, failedNonTest: nonTestFailed, skippedTests },
             testCounts: computeTestCounts([], checkRunSuites), hasArtifacts: false };
  }

  // All artifacts expired — try check-run summaries
  if (expiredCount > 0 && downloadable.length === 0) {
    const checkRunSuites = await fetchCheckRunSummaries(prMeta.head.sha);
    const hasFails = checkRunSuites.some(s => s.testcases.some(tc => tc.status === 'failed'));
    return { ...base, status: hasFails ? 'failing' : 'passing',
             expiredArtifacts: expiredCount, checkRunSuites,
             jobs: { failed: failedJobs, skippedTests },
             testCounts: computeTestCounts([], checkRunSuites), hasArtifacts: false };
  }

  // No test artifacts and no build failure (e.g. tests were skipped)
  if (testArtifacts.length === 0) {
    return { ...base, status: 'pending', jobs: { failed: failedJobs, skippedTests } };
  }

  // Download and parse
  const artifactResults = await Promise.all(
    downloadable.map(a => downloadAndParseArtifact(a.id, a.name))
  );
  deduplicateSuites(artifactResults);
  // After compaction, testcases only contains failures — any entry means a failure
  const hasFails = artifactResults.some(a => a.suites.some(s => s.testcases.length > 0));

  // Tests passed but a non-test job failed (e.g. windowsBuild) → build_failed, not failing
  const status = hasFails ? 'failing' : nonTestFailed.length > 0 ? 'build_failed' : 'passing';

  return { ...base,
    status,
    artifacts: artifactResults,
    expiredArtifacts: expiredCount,
    jobs: { failed: failedJobs, failedNonTest: nonTestFailed, skippedTests },
    testCounts: computeTestCounts(artifactResults, []), hasArtifacts: true,
  };
}

function prBase(pr) {
  return {
    number:      pr.number,
    title:       pr.title,
    url:         pr.html_url,
    author:      pr.user.login,
    authorAvatar:pr.user.avatar_url,
    branch:      pr.head.ref,
    headSha:     pr.head.sha.slice(0, 7),
    updatedAt:   pr.updated_at,
    isDraft:     pr.draft,
    labels:      pr.labels.map(l => ({ name: l.name, color: l.color })),
    processedAt: new Date().toISOString(),
  };
}

// ── Background refresh loop ──────────────────────────────────────────────────

const prState = new Map();
let lastRefresh   = null;
let isRefreshing  = false;
let initialized   = false;
let refreshTimer  = null;

async function refresh() {
  if (isRefreshing) return;
  isRefreshing = true;
  console.log(`[${new Date().toISOString()}] Refreshing…`);

  try {
    const prs = await ghJson(
      `/repos/${OWNER}/${REPO}/pulls?state=open&per_page=50&sort=updated&direction=desc`
    );

    // Process PRs sequentially to avoid rate-limit spikes
    for (const pr of prs) {
      try {
        const existing = prState.get(pr.number);
        const result   = await processPR(pr, existing);
        prState.set(pr.number, result);
      } catch (e) {
        console.error(`PR #${pr.number} error: ${e.message}`);
        // Keep existing state on error
      }
    }

    // Remove PRs that are no longer open
    const live = new Set(prs.map(p => p.number));
    for (const [num] of prState) if (!live.has(num)) prState.delete(num);

    lastRefresh = new Date();
    initialized = true;
    console.log(`[${new Date().toISOString()}] Done. ${prState.size} PRs.`);
  } catch (e) {
    console.error('Refresh error:', e.message);
  } finally {
    isRefreshing = false;
    scheduleNext();
  }
}

function scheduleNext() {
  clearTimeout(refreshTimer);
  const anyBuilding = [...prState.values()].some(p => p.status === 'building');
  refreshTimer = setTimeout(refresh, anyBuilding ? FAST_INTERVAL : SLOW_INTERVAL);
}

// ── Express routes ───────────────────────────────────────────────────────────

const app = express();
app.use(express.static('public'));

app.get('/api/state', (req, res) => {
  // Strip large artifact arrays — clients fetch per-PR detail on demand via /api/pr/:number.
  // checkRunSuites are kept because they're already compact (failures only, no individual XML parsing).
  const prs = [...prState.values()]
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(({ artifacts, ...rest }) => rest);
  res.json({ prs, lastRefresh: lastRefresh?.toISOString() || null, refreshing: isRefreshing, initialized });
});

// Per-PR artifact detail — called on demand when the user opens a PR in the UI.
app.get('/api/pr/:number', (req, res) => {
  const pr = prState.get(Number(req.params.number));
  if (!pr) return res.status(404).json({ error: 'PR not found' });
  res.json({ artifacts: pr.artifacts || [], expiredArtifacts: pr.expiredArtifacts || 0 });
});

// Trigger a manual refresh
app.post('/api/refresh', (req, res) => {
  res.json({ ok: true });
  refresh();
});

app.use('/api', (req, res) => res.status(404).json({ error: `No route: ${req.method} ${req.path}` }));

app.listen(PORT, () => {
  console.log(`Teku CI → http://localhost:${PORT}`);
  refresh(); // kick off immediately
});
