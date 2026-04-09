# Teku CI Dashboard

A local web dashboard for browsing [Teku](https://github.com/Consensys/teku) GitHub Actions test results — faster and easier to navigate than the default GitHub Actions UI.

## Features

- Enter a CI run number and instantly see all test results across unit, integration, acceptance, property and reference test suites
- Failures auto-expanded with the assertion message visible immediately; click to reveal the full stack trace
- Filter by Failed / All / Skipped, search by test name
- Detects when a build failed before tests ran (e.g. `assemble` failure) and explains why instead of showing an empty page
- GitHub token saved in `localStorage` — enter once, persists across sessions
- Run number saved in the URL hash (`#<runId>`) for bookmarking

## Requirements

- Node.js 18+
- A GitHub personal access token — required to download artifacts even from public repos (no special scopes needed)

## Setup

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Usage

1. Paste the run number from a Teku CI run URL:
   `https://github.com/Consensys/teku/actions/runs/`**`24181827923`**
2. Enter your GitHub token in the Token field (saved automatically)
3. Click **Load**

The token can also be set via environment variable to skip the UI field:

```bash
GITHUB_TOKEN=ghp_... npm start
```

## How it works

The Node.js backend fetches the artifact list for the run, downloads every `unit-reports-*`, `integration-reports-*`, `acceptance-reports-*`, `property-reports-*` and `reference-reports-*` ZIP artifact in parallel, extracts the JUnit XML files, and returns the parsed results. Completed runs are cached in memory so reloading is instant.

If the build failed before tests ran (e.g. compilation error), the dashboard shows which job failed and why instead of an empty results page.
