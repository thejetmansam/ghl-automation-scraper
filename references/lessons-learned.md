# Lessons Learned — Why `audit-ghl.js` Looks The Way It Does

This document explains the non-obvious choices in the audit script. If you're tempted to "simplify" something, check here first — most of the complexity exists because a simpler approach was tried and failed.

## 1. Why Playwright, not Chrome MCP or the GHL API

### Attempted: Chrome MCP JavaScript execution
**Failed because** the workflow list is inside a cross-origin iframe. Chrome MCP's `javascript_tool` runs code in the top-level frame context only. It can't see `document.querySelectorAll('.n-data-table-tr')` from the iframe.

### Attempted: GHL Public API `GET /workflows/`
**Returns only metadata** (id, name, status, updated timestamp). No trigger/action detail. Confirmed via research + direct API call with the Private Integration Token.

### Why Playwright works
`page.frames()` enumerates ALL frames including cross-origin ones. `frame.evaluate()` runs in the iframe's context. And `page.on('response')` captures network traffic from ANY frame. Combined = full access.

## 2. Why the content-aware frame wait is 3-attempt, not `waitForSelector`

**Naive problem**: `waitForSelector('.n-data-table-tr')` fires the moment the DOM element appears — which is BEFORE the API response loads the data into the rows. The script would then find empty rows (skeleton state) and return 0 workflows.

**What I tried first**: `waitForSelector` + a fixed 5-second `sleep()`. Worked most of the time, failed ~20% when GHL's backend was slow.

**Current approach**: poll until at least one row has non-empty `innerText` in column [1] (the name cell). Poll every 3 seconds for up to 60 seconds. This is actually FASTER in the common case (2-6 seconds) because it doesn't wait longer than needed, and NEVER has false positives.

## 3. Why we compare first-row names to detect end of pagination

**Attempted**: check `nextButton.isDisabled()`. Naive UI's Next button is frequently NOT disabled on the last page — clicking it does nothing visible, but `disabled` attribute is missing. Our script would click Next forever.

**Attempted**: check `[aria-disabled]`. Same issue — not always set.

**Attempted**: check the active page number via `.n-pagination-item--active`. Works, but breaks when pagination is re-rendered mid-click.

**Current approach**: save the first row's name on each page. If the next page's first row matches, we haven't moved. Break. This works across all Naive UI pagination quirks.

## 4. Why there's a search-box fallback for clicks

**Attempted**: `frame.locator('.n-data-table-td:nth-child(2)').filter({ hasText: workflowName }).click()`

**Failed when** multiple workflows share a prefix. Example: three workflows in the same folder that all start with the same ~30-character campaign name and only differ by a source suffix (e.g. `... - GreatPages`, `... - Typeform`, `... - Retargeting`). `hasText` is a substring match that fires on the first visible match — which is usually the wrong row.

**Attempted**: row index (`.nth(wi)`) — works great on page 1 but rows are re-indexed on pagination. If `wi > 10`, we need to be on page 2+ first. The script handles this but it's fragile if the UI re-renders mid-sequence.

**Current approach**: if index-based click fails, type the full workflow name into GHL's search box (`input[placeholder*="Search" i]`). The table filters to an exact-ish match, and clicking the first visible row is now reliable.

## 5. Why triggers and actions are captured in two separate API streams

**The gotcha**: GHL stores triggers at a different URL than workflow bodies.

- `/workflow/{loc}/{wfId}` returns the workflow body — includes `workflowData.templates[]` (actions) but NO triggers.
- `/workflow/{loc}/trigger?workflowId=X` returns the triggers for workflow X.

**If you only capture the first endpoint, every workflow will have `_triggers: null`.** This is easy to miss — I lost an hour on this. The symptom: a Python script summing `len(workflow.triggers)` returns 0 for all 58 workflows. But they obviously have triggers — the UI shows them!

**Current approach**: the network interception has TWO match patterns in a single listener:
```js
// Pattern A: workflow body
if (url.includes('/workflow/') && !url.includes('/trigger')) { ... capture body }
// Pattern B: triggers
if (url.includes('/trigger') && url.includes('workflowId')) { ... capture triggers }
```

The merge step at the end joins them by workflow ID.

## 6. Why we navigate fresh back to the root for every workflow

**Attempted**: stay inside a folder, click through workflows sequentially. After clicking one workflow → clicking Back → clicking the next workflow, the table state gets into weird modes. Sometimes the iframe context changes. Sometimes the search filter persists and hides rows.

**Current approach**: `page.goto(BASE_URL)` between every workflow, re-enter the folder, click the Nth row. Slow but bulletproof.

The cost is ~8 seconds per workflow vs ~5 if we stayed in place. For 58 workflows that's 3 minutes extra. Worth it for reliability.

## 7. Why sub-folder IDs aren't always what they seem

**The confusing discovery**: in the GHL database, every workflow has a `parentId` field. When I first looked at it, I assumed `parentId` = sub-folder ID. But some root folders ALSO have a `parentId` pointing to themselves, and some items at the same UI level have different `parentId`s.

**Observation**: The `?folder={id}` URL sometimes appears after clicking items that look like workflows (based on the table status column showing "Published" and enrollment counts). These are actually nested folders that HAPPEN to have status and enrollment data from Notion/GHL's legacy UI. You can't tell a folder from a workflow by looking at the table — you have to click and watch the URL.

**Current approach**: on every click, check the resulting URL:
- `/workflow/{id}` → real workflow
- `?folder={id}` without `/workflow/` → sub-folder, recurse at end of pass

## 8. Why the script de-duplicates captured workflows by ID

The network listener fires on MANY responses, including navigations that happen to trigger a fetch but don't correspond to us opening a new workflow (e.g. browser autocomplete, middle-click handlers, hover previews). Also: when we navigate back to the root between workflows, GHL sometimes refetches recently-viewed workflows.

**Current approach**: at the merge step, build a dict keyed by workflow ID. The last capture wins (most recent = freshest). Duplicates are silently dropped.

## 9. Why we `block` service workers

**Symptom without blocking**: the first 1-2 workflow loads capture API data, but subsequent loads return cached/stale JSON from the service worker. Triggers appear stale.

**Fix**: `serviceWorkers: 'block'` in the Playwright context options. Disables SW registration for this session. Every network call hits the backend fresh. GHL's web app still works (SWs are a progressive enhancement).

## 10. Things to try if extending the script

- **Auxiliary endpoint captures**: enrich workflows with human-readable tag names (resolve tag IDs via `/locations/{id}/tags`), user names (`/users/search`), pipeline stage names (`/opportunities/pipelines`).
- **Network interception for `/integrations/facebook/*`**: capture which FB pages/forms each workflow filters on.
- **Diff against previous snapshot**: load `audits/{yesterday}/raw/workflows-with-triggers.json` and compute changes since last run. Emit `diff.md`.
- **Sub-folder recursion depth**: current script recurses one level. If GHL supports nested sub-folders (it seems to, in some accounts), make the recursion actually recursive with a depth limit.
- **Needs Review tab**: the audit currently skips this. To include, navigate to `?listTab=needs-review` and repeat the folder traversal.
- **Deleted tab**: same as above with `?listTab=deleted`. Useful for understanding what WAS running recently.

## Anti-patterns — don't do these

- **Don't click individual workflow nodes to read their config.** We tried this — it works visually (the right-side panel opens with all details) but extracting structured data from the panel requires clicking each node, scrolling, and parsing. Takes 10x as long as network interception and is fragile against UI changes.
- **Don't rely on `innerText` of Vue Flow nodes for structure.** The visible text gets truncated by CSS (`text-overflow: ellipsis`) and can't be used to reconstruct the workflow graph. Use the network-captured JSON instead.
- **Don't re-login every run.** GHL's login form triggers bot detection if hit too often. Use the persistent browser profile; re-login only when the session actually expires (typically weeks).
- **Don't store credentials in the script.** Use a persistent profile directory. If you need CI automation, see `SKILL.md` for the self-hosted runner pattern.
