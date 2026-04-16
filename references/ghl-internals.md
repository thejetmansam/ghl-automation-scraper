# GHL Internals — How the Web App Actually Works

Read this when extending `audit-ghl.js` or debugging why something isn't captured.

## Architecture

GHL's Automation > Workflows UI is NOT a single page. It's a cross-origin composition:

```
app.gohighlevel.com                      (outer shell, nav, routing)
  └── <iframe src="client-app-automation-workflows.leadconnectorhq.com">
        (all workflow-related content lives here)
```

**Implications:**
- JavaScript running in `app.gohighlevel.com` CANNOT read the iframe's DOM (CORS).
- Chrome extensions / Chrome MCP can only interact with the outer frame by default.
- Playwright's `page.frames()` traverses ALL frames regardless of origin — that's why this skill uses Playwright, not Chrome MCP.

## Table component: Naive UI `n-data-table`

The workflow list table is rendered by [Naive UI](https://www.naiveui.com/en-US/os-theme/components/data-table), a Vue 3 component library.

- Rows: `.n-data-table-tr` (NOT `<tr>`)
- Cells: `.n-data-table-td` (NOT `<td>`)
- Loading overlay: `.n-data-table--loading` modifier on the root
- Pagination container: `.n-pagination`
- Active page: `.n-pagination-item--active`

**Column order in the workflow list** (0-indexed):
```
0: checkbox (bulk select)
1: name
2: status badge (Published / Draft / blank for folders)
3: Total Enrolled
4: Active Enrolled
5: Last Updated
6: Created On
7: Stats icon
```

**Folder rows** have a folder icon and an empty status cell. Workflow rows have a toggle switch (via a `[role="switch"]` element, which may be on a `<div>` or `<button>`, not always the latter).

## URL patterns

- Root list: `/v2/location/{locationId}/automation/workflows`
- Filtered by tab: `?listTab=all | needs-review | deleted`
- Inside a folder: same URL, but after clicking a folder row the app pushes `?folder={folderId}`
- Workflow editor: `/location/{locationId}/workflow/{workflowId}` (note: no `v2` prefix here)

**Sub-folders vs workflows — how to tell:**
When you click a row, check the URL after navigation:
- Contains `/workflow/{id}` → it's a workflow, capture the JSON
- Contains `?folder={id}` without `/workflow/` → it's a sub-folder, recurse by navigating to the same URL

## Authentication

GHL uses Firebase Auth for the web app. The session is stored as:
- `localStorage.refreshedToken` (Firebase JWT, ~2800 chars)
- Various cookies on `app.gohighlevel.com` and `*.leadconnectorhq.com`

**Important:** the Firebase JWT is DIFFERENT from the public API's Sub-Account OAuth Token. The Firebase JWT authenticates you for the web app's internal `backend.leadconnectorhq.com` endpoints. The public API at `services.leadconnectorhq.com/workflows/` rejects Firebase JWTs — you need a Private Integration Token or OAuth flow for that.

Our script relies on the browser session (cookies + localStorage token), not on any extracted API keys.

## Internal API endpoints used by the web app

These are not officially documented but are what the web app actually calls:

### Workflow body (actions, conditions, branches, steps)

```
GET https://backend.leadconnectorhq.com/workflow/{locationId}/{workflowId}
    ?includeScheduledPauseInfo=true&sessionId={uuid}
```

Returns full workflow object:
```js
{
  _id, id, locationId, companyId, name, status, version,
  timezone, parentId,             // folder ID
  workflowData: {
    templates: [                  // every action/condition/step
      {
        id, order, name, type,    // e.g. "add_contact_tag", "if_else", "wait"
        attributes: { ... },      // type-specific config
        next,                     // ID of next step OR array for branches
        parentKey,                // ID of parent step
        children,                 // for branching steps
      }
    ]
  }
}
```

### Triggers (stored SEPARATELY — this is easy to miss)

```
GET https://backend.leadconnectorhq.com/workflow/{locationId}/trigger?workflowId={workflowId}
```

Returns an array of trigger objects:
```js
[
  {
    id, date_added, deleted,
    actions: [ { workflow_id, type: "add_to_workflow" } ],
    conditions: [
      { operator: "==", field: "appointment.eventType", value: "normal" },
      ...
    ],
    ...
  }
]
```

Filter rules for network interception:
- Capture URL matches `/workflow/` or `/workflows/` AND response is JSON
- For triggers, specifically match `/trigger` with `workflowId` in query string
- Skip `.js` / `.css` / `.png` / static assets

### Other endpoints the web app calls (NOT currently captured, but useful to know exist)

- `/workflows-marketplace/integration-apps` — list of available action apps
- `/workflows-marketplace/location/{id}/assets` — node type definitions (huge, 2MB)
- `/marketplace/core/search/module?type=triggers|actions` — installed trigger/action modules
- `/workflow/{locationId}/auto-save/settings` — auto-save config
- `/workflow/{locationId}/workflow-ai/settings` — AI feature config
- `/integrations/facebook/{locationId}/trigger/pages` — when editing FB triggers, loads page list
- `/integrations/facebook/{locationId}/trigger/forms?pageId=X` — loads form list for an FB page

If you need to resolve tag/field/user IDs from the captured JSON to human names, you may need to call these auxiliary endpoints.

## Bot detection

GHL uses moderate bot detection (looks for `navigator.webdriver`, `headless` user-agent strings). The skill counters with:
- `args: ['--disable-blink-features=AutomationControlled']`
- Custom userAgent matching a real Chrome
- `addInitScript` that deletes `navigator.webdriver`

If GHL tightens detection, also consider:
- Running in headed mode (never headless) during suspect periods
- Randomizing slowMo / human-like delays
- Adding realistic mouse movements (Playwright's `page.mouse.move` with intermediate points)
