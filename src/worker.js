import { unzipSync } from 'fflate';
import { XMLParser } from 'fast-xml-parser';

const OWNER      = 'Consensys';
const REPO       = 'teku';
const KV_KEY     = 'state';
const BATCH_SIZE = 12; // PRs checked per cron invocation (3 req each → 36 + 1 list = 37 ≤ 50)

// ── XML parser ───────────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  isArray: (t) => ['testsuite', 'testcase'].includes(t),
  parseAttributeValue: false,
});

// ── GitHub helpers ───────────────────────────────────────────────────────────

function ghHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'teku-ci',
  };
}

async function ghFetch(path, token) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  return fetch(url, { headers: ghHeaders(token) });
}

async function ghJson(path, token) {
  const res = await ghFetch(path, token);
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`), { status: res.status });
  }
  return res.json();
}

async function ghGraphQL(query, token) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'teku-ci' },
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

function parseXml(xml) {
  let parsed;
  try { parsed = xmlParser.parse(xml); } catch { return []; }
  const suites = parsed.testsuites?.testsuite || parsed.testsuite || [];
  return suites.filter(Boolean).map((suite) => {
    const testcases = (suite.testcase || []).map((tc) => {
      let status = 'passed', failure = null;
      if (tc.failure !== undefined) { status = 'failed';  failure = extractFailure(tc.failure); }
      else if (tc.error !== undefined) { status = 'error'; failure = extractFailure(tc.error); }
      else if (tc.skipped !== undefined) { status = 'skipped'; }
      return { classname: tc.classname || '', name: tc.name || '', time: parseFloat(tc.time) || 0, status, failure };
    });
    return { name: suite.name || 'Unknown', time: parseFloat(suite.time) || 0, testcases };
  });
}

async function downloadAndParseArtifact(artifactId, artifactName, token) {
  const res = await ghFetch(
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/artifacts/${artifactId}/zip`,
    token
  );
  if (!res.ok) return { artifactName, suites: [], error: `HTTP ${res.status}` };

  const buffer = await res.arrayBuffer();
  let files;
  try { files = unzipSync(new Uint8Array(buffer)); }
  catch (e) { return { artifactName, suites: [], error: `ZIP error: ${e.message}` }; }

  const rawSuites = [];
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith('.xml')) continue;
    try { rawSuites.push(...parseXml(new TextDecoder().decode(data))); }
    catch (e) { console.error(`Parse error ${name}: ${e.message}`); }
  }

  // Compact: only failed/skipped stored individually; passing as counts only
  const suites = rawSuites.map(s => ({
    name:     s.name,
    time:     s.time,
    total:    s.testcases.length,
    passed:   s.testcases.filter(tc => tc.status === 'passed').length,
    skipped:  s.testcases.filter(tc => tc.status === 'skipped').length,
    testcases: s.testcases.filter(tc => tc.status !== 'passed'),
  }));

  return { artifactName, suites };
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
  return { name, time: 0, total, passed: Math.max(0, total - testcases.length), skipped: 0, testcases, fromCheckRun: true };
}

async function fetchCheckRunSummaries(sha, token) {
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
  }`, token);
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

async function getLatestCIRun(sha, token) {
  const data = await ghJson(`/repos/${OWNER}/${REPO}/actions/runs?head_sha=${sha}&per_page=20`, token);
  const runs = data.workflow_runs || [];
  return runs.find(r => r.name === 'ci' || r.path?.includes('ci.yml')) || runs[0] || null;
}

function fmtRun(run) {
  if (!run) return null;
  return { id: run.id, status: run.status, conclusion: run.conclusion,
           html_url: run.html_url, run_number: run.run_number, created_at: run.created_at };
}

function prBase(pr) {
  return {
    number:       pr.number,
    title:        pr.title,
    url:          pr.html_url,
    author:       pr.user.login,
    authorAvatar: pr.user.avatar_url,
    branch:       pr.head.ref,
    headSha:      pr.head.sha,        // full SHA — sliced to 7 chars in the UI
    updatedAt:    pr.updated_at,
    isDraft:      pr.draft,
    labels:       (pr.labels || []).map(l => ({ name: l.name, color: l.color })),
    processedAt:  new Date().toISOString(),
  };
}

// ── Process a single PR (status only, no artifact downloads) ─────────────────
// Budget: 1 (CI run) + 2 (artifacts + jobs) + 1 (check-run summaries, failing only) = 4 req max
// 12 failing PRs × 4 + 1 list = 49 ≤ 50 subrequest limit

async function processPR(prMeta, existingState, token) {
  const run = await getLatestCIRun(prMeta.head.sha, token);

  // Same completed run as cached — just refresh metadata
  if (existingState?.runId === run?.id && run?.status === 'completed' &&
      existingState.status !== 'building') {
    return { ...existingState, ...prBase(prMeta) };
  }

  const base = { ...prBase(prMeta), runId: run?.id || null, run: fmtRun(run) };

  if (!run || run.status === 'queued') return { ...base, status: 'pending' };

  if (run.status === 'in_progress') {
    const { jobs = [] } = await ghJson(
      `/repos/${OWNER}/${REPO}/actions/runs/${run.id}/jobs?per_page=100`, token
    );
    return {
      ...base,
      status: 'building',
      inProgressJobs: jobs.filter(j => j.status === 'in_progress').map(j => j.name),
      jobs: { failed: jobs.filter(j => j.conclusion === 'failure').map(j => j.name) },
    };
  }

  // Completed — check artifact list + jobs (metadata only, no ZIP downloads)
  const [{ artifacts = [] }, { jobs = [] }] = await Promise.all([
    ghJson(`/repos/${OWNER}/${REPO}/actions/runs/${run.id}/artifacts?per_page=100`, token),
    ghJson(`/repos/${OWNER}/${REPO}/actions/runs/${run.id}/jobs?per_page=100`, token),
  ]);

  const testArtifacts  = artifacts.filter(a => /^(unit|integration|acceptance|property|reference)-reports-/.test(a.name));
  const failedJobs     = jobs.filter(j => j.conclusion === 'failure').map(j => j.name);
  const skippedTests   = jobs.filter(j => j.conclusion === 'skipped' && /unit|integration|acceptance|property|reference/i.test(j.name)).map(j => j.name);
  const nonTestFailed  = failedJobs.filter(n => !/Report|Result/i.test(n));

  if (testArtifacts.length === 0 && nonTestFailed.length > 0) {
    return { ...base, status: 'build_failed',
             jobs: { failed: failedJobs, failedNonTest: nonTestFailed, skippedTests } };
  }

  if (testArtifacts.length === 0) {
    return { ...base, status: 'pending', jobs: { failed: failedJobs, skippedTests } };
  }

  const downloadable = testArtifacts.filter(a => !a.expired);
  const expiredCount  = testArtifacts.filter(a => a.expired).length;

  // All expired — fall back to check-run summaries (1 GraphQL req)
  if (downloadable.length === 0 && expiredCount > 0) {
    const checkRunSuites = await fetchCheckRunSummaries(prMeta.head.sha, token);
    const hasFails = checkRunSuites.some(s => s.testcases.some(tc => tc.status === 'failed'));
    return { ...base, status: hasFails ? 'failing' : 'passing',
             expiredArtifacts: expiredCount, checkRunSuites,
             jobs: { failed: failedJobs, skippedTests } };
  }

  // Fetch check-run summaries for failing runs:
  //  (a) show test counts on the dashboard card
  //  (b) accurately detect whether tests failed or only a non-test job failed
  //      e.g. windowsBuild fails but all test suites pass → build_failed, not failing
  // Budget: +1 req per failing PR → max 4 req; 12 × 4 + 1 = 49 ≤ 50
  let checkRunSuites = [];
  if (run.conclusion !== 'success') {
    checkRunSuites = await fetchCheckRunSummaries(prMeta.head.sha, token);
  }

  let status;
  if (run.conclusion === 'success') {
    status = 'passing';
  } else if (checkRunSuites.length > 0) {
    const anyTestFailed = checkRunSuites.some(s =>
      (s.testcases || []).some(tc => tc.status === 'failed' || tc.status === 'error'));
    status = anyTestFailed ? 'failing' : 'build_failed';
  } else {
    // Summaries not yet available — fall back: if only non-test jobs failed → build_failed
    status = nonTestFailed.length > 0 && nonTestFailed.length === failedJobs.length
      ? 'build_failed' : 'failing';
  }

  return { ...base,
    status,
    expiredArtifacts: expiredCount,
    checkRunSuites,
    jobs: { failed: failedJobs, failedNonTest: nonTestFailed, skippedTests },
  };
}

// ── Background refresh (batched to stay within 50-subrequest limit) ──────────

async function doRefresh(env) {
  const token = env.GITHUB_TOKEN;
  if (!token) { console.error('GITHUB_TOKEN not set'); return; }

  console.log(`[${new Date().toISOString()}] Refreshing...`);

  let existingPRMap = {}, currentState = null;
  try {
    const raw = await env.CI_STATE.get(KV_KEY);
    if (raw) {
      currentState = JSON.parse(raw);
      existingPRMap = Object.fromEntries((currentState.prs || []).map(p => [p.number, p]));
    }
  } catch {}

  await env.CI_STATE.put(KV_KEY, JSON.stringify({
    prs: currentState?.prs || [],
    lastRefresh: currentState?.lastRefresh || null,
    refreshing: true,
    initialized: currentState?.initialized || false,
  }));

  try {
    const prs = await ghJson(
      `/repos/${OWNER}/${REPO}/pulls?state=open&per_page=50&sort=updated&direction=desc`,
      token
    );
    if (!Array.isArray(prs)) throw new Error(`Unexpected response: ${JSON.stringify(prs).slice(0, 200)}`);
    console.log(`Fetched ${prs.length} open PRs`);

    const results = [];
    let freshChecks = 0;

    for (const pr of prs) {
      const existing = existingPRMap[pr.number];

      // Fast path: same commit, already in a terminal state — zero subrequests
      if (existing &&
          existing.headSha === pr.head.sha &&
          existing.status !== 'building' &&
          existing.status !== 'pending') {
        results.push({ ...existing, ...prBase(pr) });
        continue;
      }

      // Batch cap: defer remaining slow-path PRs to the next cron invocation
      if (freshChecks >= BATCH_SIZE) {
        if (existing) results.push({ ...existing, ...prBase(pr) });
        // else: brand-new PR, will appear once the next cron batch reaches it
        continue;
      }

      try {
        results.push(await processPR(pr, existing, token));
        freshChecks++;
      } catch (e) {
        console.error(`PR #${pr.number}: ${e.message}`);
        if (existing) results.push(existing);
      }
    }

    // Drop PRs that are no longer open
    const live = new Set(prs.map(p => p.number));
    const finalResults = results.filter(r => live.has(r.number));

    await env.CI_STATE.put(KV_KEY, JSON.stringify({
      prs: finalResults,
      lastRefresh: new Date().toISOString(),
      refreshing: false,
      initialized: true,
    }));

    console.log(`Done. ${finalResults.length} PRs (${freshChecks} checked, ${prs.length - freshChecks - finalResults.filter(r => {
      const pr = prs.find(p => p.number === r.number);
      return pr && existingPRMap[r.number]?.headSha === pr.head.sha;
    }).length} deferred).`);
  } catch (e) {
    console.error('Refresh error:', e.message);
    const raw = await env.CI_STATE.get(KV_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      s.refreshing = false;
      await env.CI_STATE.put(KV_KEY, JSON.stringify(s));
    }
  }
}

// ── On-demand test result fetcher ────────────────────────────────────────────
// Called when user clicks a PR. Has its own 50-subrequest budget.
// Budget: 1 (artifacts list) + up to 44 (ZIP downloads) = 45 req max.

async function fetchPRTests(prNumber, env, token) {
  const stateRaw = await env.CI_STATE.get(KV_KEY);
  if (!stateRaw) return { error: 'No state available yet' };

  const state = JSON.parse(stateRaw);
  const pr = state.prs.find(p => p.number === prNumber);
  if (!pr) return { error: 'PR not found' };

  // Expired artifacts already resolved by cron — return cached check-run data
  if (pr.checkRunSuites?.length > 0) {
    return { artifacts: [], checkRunSuites: pr.checkRunSuites, expiredArtifacts: pr.expiredArtifacts || 0 };
  }

  if (!pr.run?.id) {
    return { artifacts: [], checkRunSuites: [], expiredArtifacts: 0 };
  }

  // Check KV cache keyed by run ID (runs are immutable once complete)
  const cacheKey = `tests:${pr.run.id}`;
  const cached = await env.CI_STATE.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // ── Strategy: check-run summaries first (1 subrequest via GraphQL) ──────
  // Each artifact ZIP download costs 2 subrequests (GitHub API + CDN redirect),
  // so on the free plan (50 limit) we can only download ~23 ZIPs.
  // Check-run summaries give failure details + counts in a single GraphQL call.
  const checkRunSuites = await fetchCheckRunSummaries(pr.headSha, token);
  if (checkRunSuites.length > 0) {
    const result = { artifacts: [], checkRunSuites, expiredArtifacts: 0 };
    const ttl = pr.run.status === 'completed' ? 7200 : 60;
    await env.CI_STATE.put(cacheKey, JSON.stringify(result), { expirationTtl: ttl });
    return result;
  }

  // ── Fallback: download ZIPs (summaries not yet generated for recent runs) ─
  // Budget: 1 (artifact list) + 23 × 2 (download + redirect each) = 47 ≤ 50
  const { artifacts = [] } = await ghJson(
    `/repos/${OWNER}/${REPO}/actions/runs/${pr.run.id}/artifacts?per_page=100`,
    token
  );

  const testArtifacts = artifacts.filter(a => /^(unit|integration|acceptance|property|reference)-reports-/.test(a.name));
  const expiredCount  = testArtifacts.filter(a => a.expired).length;
  const downloadable  = testArtifacts.filter(a => !a.expired);

  if (downloadable.length === 0) {
    return { artifacts: [], checkRunSuites: [], expiredArtifacts: expiredCount };
  }

  const toDownload = downloadable.slice(0, 23);
  const artifactResults = await Promise.all(
    toDownload.map(a => downloadAndParseArtifact(a.id, a.name, token))
  );

  const truncated = downloadable.length > 23;
  const result = {
    artifacts: artifactResults,
    checkRunSuites: [],
    expiredArtifacts: expiredCount,
    truncated: truncated ? `${downloadable.length - 23} artifact shards not loaded (free plan limit)` : null,
  };
  const ttl = pr.run.status === 'completed' ? 7200 : 60;
  await env.CI_STATE.put(cacheKey, JSON.stringify(result), { expirationTtl: ttl });
  return result;
}

// ── Worker entry point ───────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/state' && request.method === 'GET') {
      const raw = await env.CI_STATE.get(KV_KEY);
      if (!raw) {
        return Response.json({ prs: [], lastRefresh: null, refreshing: false, initialized: false });
      }
      return new Response(raw, {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/api/refresh' && request.method === 'POST') {
      ctx.waitUntil(doRefresh(env));
      return Response.json({ ok: true });
    }

    const prMatch = url.pathname.match(/^\/api\/pr\/(\d+)$/);
    if (prMatch && request.method === 'GET') {
      const token = env.GITHUB_TOKEN;
      if (!token) return Response.json({ error: 'GITHUB_TOKEN not set' }, { status: 500 });
      try {
        const result = await fetchPRTests(parseInt(prMatch[1]), env, token);
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    if (url.pathname.startsWith('/api')) {
      return Response.json({ error: `No route: ${request.method} ${url.pathname}` }, { status: 404 });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(doRefresh(env));
  },
};
