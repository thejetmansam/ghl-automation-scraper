---
name: ghl-workflow-audit
description: Audit all workflows in a Go High Level (GHL) sub-account — capture every workflow's full JSON (triggers, actions, conditions, branches, connections) into a dated snapshot folder. Use whenever the user asks to "audit GHL", "re-audit workflows", "capture current automation state", "sync GHL to the repo", "check for drift", "snapshot automations", or wants to refresh the automation inventory. Also invoke this skill BEFORE designing a new automation so Claude has ground-truth data for conflict checking. This is the canonical way to get GHL's internal workflow data — the public GHL API does not return trigger/action details, so this skill uses Playwright browser automation + network interception instead.
---

# GHL Workflow Audit

## What this skill does

Opens every folder in GHL's Automation > Workflows page, visits every workflow, and intercepts the API responses that load each workflow's definition. Saves the raw JSON (which contains triggers, actions, conditions, field values, wait times, step connections, branch logic — everything) into a dated snapshot folder.

## When to use it

- User says "audit GHL" / "re-audit the workflows" / "run a GHL snapshot"
- User wants to know what's actually live in GHL right now
- User is about to design a new automation and needs ground-truth data for conflict checking (invoke this FIRST if the last audit is stale)
- User mentions "drift", "sync reality to repo", "refresh the automation inventory"
- Any task involving the source-of-truth YAML files in `automations/*/workflow.yml` that might depend on current GHL state

## Prerequisites

1. **Node.js + Playwright installed**: `npm install && npx playwright install chromium`
2. **Environment variables** (or `.env` in the repo root):
   - `GHL_LOCATION_ID` — your GHL sub-account ID (e.g. `YOUR_LOCATION_ID_HERE`)
3. **First-time browser profile setup**: the first run opens a browser window. Log into GHL manually. The session cookies save to `./browser-profile/` and persist across runs until GHL expires the session (typically weeks). After the initial login, the audit is fully autonomous.

## How to invoke

From the repo root:
```bash
node scripts/audit-ghl.js
```

Optional flags:
```bash
# Override output location (default: audits/YYYY-MM-DD/)
node scripts/audit-ghl.js --output audits/custom-name

# Run headless (after initial interactive login)
node scripts/audit-ghl.js --headless

# Skip screenshots (faster)
node scripts/audit-ghl.js --no-screenshots
```

## What the output looks like

```
audits/2026-04-16/
├── AUDIT_SUMMARY.md        ← stats + folder list (generated at end)
├── raw/
│   ├── workflows-with-triggers.json  ← merged: actions + triggers per workflow
│   ├── captured-apis.json            ← raw network responses (all pages/passes)
│   └── triggers-by-id.json           ← trigger responses keyed by workflow ID
└── screenshots/
    └── <folder>_<workflow>.png       ← one per workflow
```

The `workflows-with-triggers.json` file is the primary output. Each entry has:
- `id`, `name`, `status` (published/draft), `folder`, `version`
- `workflowData.templates[]` — every action/condition/step with full config, including `next` / `parentKey` / `children` for flow traversal
- `_triggers` — array of triggers with conditions, filters, and trigger-specific config

## Why this approach (not the GHL API)

GHL's public REST API (`services.leadconnectorhq.com/workflows/`) is read-only and returns ONLY workflow names, IDs, and active/inactive status. It does NOT include triggers, actions, or step configuration — so for a meaningful audit, we have to intercept the internal API calls the GHL web app makes to its Firebase backend.

The browser running the GHL web app fetches the full workflow JSON from `backend.leadconnectorhq.com/workflow/{locationId}/{workflowId}` when you open the editor, plus a separate call to `backend.leadconnectorhq.com/workflow/{locationId}/trigger?workflowId=...` for triggers. Playwright's `page.on('response')` captures both — no API key needed, just the logged-in session.

## Key technical gotchas (encoded in the script)

The script already handles these; read `references/ghl-internals.md` for the full explanation:

1. **Cross-origin iframe**: the workflow list is inside `client-app-automation-workflows.leadconnectorhq.com`. Playwright's frame access works; Chrome MCP's JavaScript does not.
2. **Naive UI table**: selectors are `.n-data-table-tr` / `.n-data-table-td`, not standard `<table>/<tr>/<td>`.
3. **Content-aware iframe wait**: `waitForSelector('.n-data-table-tr')` fires on skeleton rows. The script re-checks until cells have non-empty text.
4. **Column layout**: `[0]=checkbox, [1]=name, [2]=status, [3]=totalEnrolled, [4]=activeEnrolled, [5]=lastUpdated, [6]=createdOn`.
5. **Sub-folders** — clicking some rows navigates to `?folder=<id>` instead of `?workflow=<id>`. Script detects via URL and recurses.
6. **Pagination** — Naive UI's "Next" button is often not disabled on the last page. Script detects end by comparing the first row of each page to the previous.
7. **Name matching** — `filter({ hasText: name })` hits wrong rows when workflows share prefixes. Script falls back to the GHL search box, which filters to exact-ish matches.
8. **Trigger endpoint** — triggers live at a different URL than the workflow body. Script captures both endpoints in one pass.

## After the audit — next steps

Once the snapshot exists at `audits/YYYY-MM-DD/`, the user typically wants to:

1. **Generate readable docs**: run `node scripts/generate-audit-md.js` to produce `AUDIT.md`
2. **Update source-of-truth**: run `node scripts/generate-source-of-truth.js` to emit `automations/<name>/workflow.yml` + README for each
3. **Check drift**: run `node scripts/diff-against-source.js` to compare current audit vs. the YAML source of truth

These are separate skills/scripts that consume this skill's output. If they don't exist yet, build them after validating the audit ran successfully.

## Troubleshooting

**"Frame never loaded"** — GHL login session expired. Run in headed mode (remove `--headless`), log in manually, rerun.

**"0 items found" in a folder** — timing issue or a sub-folder that's been mis-classified. Check `captured-apis.json` for the raw response; the script logs URL patterns that can reveal what happened.

**"Could not click workflow" (repeatedly)** — workflow names with special characters (quotes, accents) can break text-based selectors. The script's search-box fallback usually handles this; if it persists, the browser profile may be corrupted. Delete `browser-profile/`, rerun, log in fresh.

**Session-expired re-login loop** — GHL sometimes force-logs-out after long idle. VNC / open the browser manually, log in, then rerun.

## Detailed references

- `references/ghl-internals.md` — How the GHL web app works under the hood (iframes, endpoints, auth model)
- `references/lessons-learned.md` — Why each technique in `audit-ghl.js` exists, what was tried that didn't work, what to try if extending the script

## The consolidated script

`scripts/audit-ghl.js` — Single entrypoint. Folds together everything learned across 4 iterations of the audit scripts (network-interception pass, sub-folder recursion pass, missing-workflow search-fallback, triggers-by-id capture). Run it as-is, or use it as the starting point for related tools.
