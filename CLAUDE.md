# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the server

```bash
GITHUB_TOKEN=<pat> npm start        # production
GITHUB_TOKEN=<pat> npm run dev      # auto-restarts on file changes (node --watch)
```

The app runs on http://localhost:3000. A GitHub token is **required** even for public repos (needed to download artifacts). No build step — changes to `public/index.html` are served immediately.

To kill a stuck server on Windows:
```bash
netstat -ano | grep ":3000.*LISTENING"   # get PID
powershell -Command "Stop-Process -Id <PID> -Force"
```

No tests, no linter.

## Architecture

Two files do everything:

**`server.js`** — ESM Express backend. Maintains an in-memory `prState` Map (PR number → processed PR object) that is refreshed in a background loop every 60s (30s when any PR is building), completely independent of client activity. On each refresh it: fetches open PRs from GitHub REST API, calls `processPR` for each, which queries the CI run, downloads artifact ZIPs, and parses JUnit XML. All data is pre-cached so the UI gets instant responses.

**`public/index.html`** — Single-file SPA. Vanilla JS, no framework, no build. Polls `/api/state` every 60s (30s when building). Two views: PR list and PR detail, toggled by showing/hiding divs.

## Key design decisions to preserve

**Compact artifact format**: After parsing JUnit XML, `compactSuites()` discards all passing test objects, keeping only failures plus aggregate counts (`total`, `passed`, `skipped`) per suite. The frontend's rendering code (`buildSuite`, `getPRStats`, etc.) handles this compact format throughout — suites with `suite.total !== undefined` are in compact format.

**Lazy artifact loading**: `/api/state` strips the `artifacts` array from every PR before sending (artifacts can be huge). Instead it sends `testCounts` (precomputed fail/pass/skip/total) and a `hasArtifacts: boolean` flag. When a user opens a PR detail, the client fetches `/api/pr/:number` to get the actual compact artifact data.

**Client-side test cache** (`testCache` Map): keyed by `{ key, artifacts }` where `key = runId` for completed runs, and `key = "${runId}:${testCounts.total}"` for building runs. The total-based key means the cache auto-invalidates when new partial artifacts arrive during a build, without polling on every 30s tick.

**`checkRunSuites` stay in state**: These come from GitHub check-run HTML summaries (fallback when artifacts have expired). They're already compact (failures only) so they're kept in `/api/state` and rendered directly without a `/api/pr/:number` fetch.

## GitHub API specifics

- Artifact naming pattern: `(unit|integration|acceptance|property|reference)-reports-N`
- CI workflow matched by name `ci` or path containing `ci.yml`
- Re-runs produce duplicate artifact names — server keeps only the highest artifact ID per name
- Artifact downloads require auth even on public repos (`ghFetch` always sends Bearer token)
- `processPR` has a cache-hit short-circuit: if `runId` unchanged and run is completed and not stale, it skips all API calls and just refreshes PR metadata
