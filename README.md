# GHL Automation Scraper

Playwright-based auditor for **Go High Level (GHL)** sub-accounts. Captures every workflow's full JSON — triggers, actions, conditions, branches, step connections — by intercepting the internal API calls the GHL web app makes while you browse it.

## Why this exists

GHL's public REST API (`services.leadconnectorhq.com/workflows/`) only returns workflow names, IDs, and active/inactive status. It does **not** return trigger or action detail. If you want a real snapshot of what's live in a sub-account — for audits, drift detection, backups, or before designing a new automation — you have to intercept the web app's internal calls.

This tool does that: it drives a real logged-in browser through every folder and workflow, and captures the JSON responses as they come back.

## What it captures

For every workflow in the sub-account:

- Metadata: `id`, `name`, `status` (published/draft), `folder`, `version`
- Full `workflowData.templates[]` — every action, condition, and wait step with its config, plus `next` / `parentKey` / `children` for flow traversal
- `_triggers[]` — array of triggers with their conditions and filters (fetched from a separate endpoint that's easy to miss)
- One screenshot per workflow editor

Output is written to `audits/YYYY-MM-DD/` with a summary Markdown file, raw JSON, and screenshots.

## Install

```bash
git clone https://github.com/thejetmansam/ghl-automation-scraper.git
cd ghl-automation-scraper
npm install
npx playwright install chromium
```

## Configure

Set your GHL sub-account ID:

```bash
export GHL_LOCATION_ID=your_location_id_here
```

Or pass it with `--location your_location_id_here` on each run.

> Your location ID is the `xxxx` in URLs like `https://app.gohighlevel.com/v2/location/xxxx/...`.

## Run

```bash
node scripts/audit-ghl.js
```

**First run:** a browser window opens. Log into GHL manually. The session cookies save to `./browser-profile/` and persist across runs until GHL expires them (typically weeks).

**Subsequent runs:** the stored session is reused automatically. You can run headless once logged in:

```bash
node scripts/audit-ghl.js --headless
```

### Flags

| Flag | Default | Effect |
|---|---|---|
| `--output <path>` | `audits/YYYY-MM-DD/` | Write snapshot to a custom folder |
| `--headless` | off | Skip the browser UI (only works after initial login) |
| `--no-screenshots` | off | Skip per-workflow screenshots — faster |
| `--location <id>` | — | Override `GHL_LOCATION_ID` env var |

## Output layout

```
audits/2026-04-16/
├── AUDIT_SUMMARY.md                        stats + folder list
├── raw/
│   ├── workflows-with-triggers.json        primary output (actions + triggers merged)
│   ├── captured-apis.json                  raw network responses
│   └── triggers-by-id.json                 triggers keyed by workflow ID
└── screenshots/
    └── <folder>_<workflow>.png             one per workflow
```

## Use as a Claude Code skill

This repo is structured so you can drop it into a Claude Code project as a skill:

1. Copy this repo into `<your-project>/.claude/skills/ghl-workflow-audit/`
2. Change the `PROJECT_ROOT` line in `scripts/audit-ghl.js` from
   `path.resolve(__dirname, '..')` to `path.resolve(__dirname, '../../../..')` so audits land in the host repo's root.
3. Claude will pick up `SKILL.md` and invoke the script when you ask it to "audit GHL" or "capture current automation state".

## How it works (short version)

1. **Cross-origin iframe**: GHL's workflow list lives in a `client-app-automation-workflows.leadconnectorhq.com` iframe — Playwright can access it; Chrome MCP can't.
2. **Network interception**: `page.on('response')` captures both `backend.leadconnectorhq.com/workflow/{loc}/{wfId}` (the body) and `/workflow/{loc}/trigger?workflowId=...` (the triggers — stored separately, easy to miss).
3. **Folder + pagination traversal**: the script enumerates every folder, every workflow inside it (paginated), recurses into sub-folders, and falls back to GHL's search box when row-index clicks fail.
4. **Session reuse**: a persistent Chromium profile stores cookies + Firebase JWT, so re-login is rare.

See `references/ghl-internals.md` and `references/lessons-learned.md` for the full story, including every workaround that exists because a simpler approach didn't survive reality.

## Known gotchas

- **Workflows with the same prefix** (e.g. three workflows that share the first 30+ characters of their name) — handled by falling back to the search box when index-based clicks hit the wrong row.
- **Naive UI's "Next" button** is often not `disabled` on the last page — handled by comparing the first row of each page to the previous.
- **Sub-folders vs workflows** — can't tell from the table; the script clicks and checks the resulting URL.
- **GHL bot detection** — the script sets a real Chrome user-agent, patches `navigator.webdriver`, and blocks service workers so captured JSON isn't stale.

## Caveats

- This tool automates your own logged-in session. It is not a supported GHL API. If GHL changes its web app, selectors may break — check `references/lessons-learned.md` for extension patterns.
- Location IDs identify your GHL sub-account. They aren't auth credentials, but treat the captured audit folder as business-sensitive data (it contains your contact field names, tag names, internal URLs, etc.).

## License

MIT — see [LICENSE](./LICENSE).
