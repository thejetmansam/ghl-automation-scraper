#!/usr/bin/env node
/**
 * GHL Workflow Audit — Consolidated Entrypoint
 * ============================================
 *
 * Captures every workflow in a GHL sub-account via Playwright + network interception.
 * Folds together four iterations of audit scripts into one pass:
 *
 *   1. Navigate through every folder on the root workflow list
 *   2. Navigate into every workflow in each folder (paginated within folders)
 *   3. Recurse into sub-folders (detected via ?folder= URL)
 *   4. Fall back to GHL's search box when row-based clicks fail
 *   5. Intercept BOTH the workflow body API AND the separate trigger API
 *   6. Merge actions + triggers into a single workflows-with-triggers.json
 *
 * Why network interception?
 *   GHL's public REST API is read-only and omits trigger/action detail.
 *   The GHL web app internally fetches full workflow JSON from its backend.
 *   We piggyback on the authenticated browser session to capture those responses.
 *
 * Output:
 *   audits/YYYY-MM-DD/
 *     raw/
 *       captured-apis.json          (all network captures, timestamped)
 *       triggers-by-id.json         (triggers keyed by workflow ID)
 *       workflows-with-triggers.json (merged — primary output)
 *     screenshots/                  (one PNG per workflow editor)
 *     AUDIT_SUMMARY.md              (stats + folder listing)
 *
 * Usage:
 *   node audit-ghl.js                           # default: audits/YYYY-MM-DD/
 *   node audit-ghl.js --output audits/my-run    # custom output folder
 *   node audit-ghl.js --headless                # skip browser UI (after first login)
 *   node audit-ghl.js --no-screenshots          # faster, skip per-workflow screenshots
 *   GHL_LOCATION_ID=xxxxx node audit-ghl.js     # override via env var
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const argv = parseArgs(process.argv.slice(2));

const LOCATION_ID = process.env.GHL_LOCATION_ID || argv.location;
if (!LOCATION_ID) {
  console.error('❌ Missing GHL_LOCATION_ID. Set via env var or --location flag.');
  console.error('   Example: GHL_LOCATION_ID=your_location_id_here node audit-ghl.js');
  process.exit(1);
}

const BASE_URL = `https://app.gohighlevel.com/v2/location/${LOCATION_ID}/automation/workflows`;
const WORKFLOW_URL = id => `https://app.gohighlevel.com/location/${LOCATION_ID}/workflow/${id}`;

// In this standalone repo, the script's parent directory IS the project root.
// (If dropped into a Claude Code project as `.claude/skills/ghl-workflow-audit/`,
//  change PROJECT_ROOT to `path.resolve(__dirname, '../../../..')` so audits land
//  in the host repo's root instead of inside the skill folder.)
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = path.join(PROJECT_ROOT, 'browser-profile');

const today = new Date().toISOString().slice(0, 10);
const OUTPUT_DIR = argv.output ? path.resolve(argv.output) : path.join(PROJECT_ROOT, 'audits', today);
const RAW_DIR = path.join(OUTPUT_DIR, 'raw');
const SS_DIR = path.join(OUTPUT_DIR, 'screenshots');

const HEADLESS = !!argv.headless;
const TAKE_SCREENSHOTS = !argv['no-screenshots'];
const SLOW_MO = argv.headless ? 0 : 100;

fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(SS_DIR, { recursive: true });
fs.mkdirSync(PROFILE_DIR, { recursive: true });

// ─── HELPERS ────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

async function ss(page, name) {
  if (!TAKE_SCREENSHOTS) return null;
  const safe = name.replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 70);
  const p = path.join(SS_DIR, `${safe}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

/**
 * Wait for the GHL workflow list iframe to contain ACTUAL row data (not skeleton).
 *
 * Why this exists: GHL's table renders empty <tr> elements before the API
 * response lands. A naive waitForSelector('.n-data-table-tr') fires instantly
 * on the skeleton. We poll until cells have non-empty text.
 */
async function getFrame(page, timeoutSec = 60) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    await sleep(3000);
    for (const f of page.frames()) {
      if (!f.url().includes('leadconnectorhq.com')) continue;
      const ready = await f.evaluate(() => {
        const rows = document.querySelectorAll('.n-data-table-tr');
        for (const r of rows) {
          const tds = r.querySelectorAll('.n-data-table-td');
          // Column [1] is the name — wait until it has real text
          if (tds.length >= 3 && tds[1]?.innerText?.trim()?.length > 2) return true;
        }
        return false;
      }).catch(() => false);
      if (ready) return f;
    }
  }
  throw new Error(`Frame with workflow data not found after ${timeoutSec}s`);
}

/**
 * Extract row data from the Naive UI table in the current frame.
 * Column layout: [0]=checkbox [1]=name [2]=status [3]=totalEnrolled
 *                [4]=activeEnrolled [5]=lastUpdated [6]=createdOn
 */
async function getRows(frame) {
  await sleep(1000);
  return frame.evaluate(() => {
    const rows = [];
    document.querySelectorAll('.n-data-table-tr').forEach(row => {
      const tds = row.querySelectorAll('.n-data-table-td');
      if (tds.length < 3) return;
      const name = tds[1]?.innerText?.trim();
      if (!name || name.length < 2) return;
      rows.push({
        name,
        status: tds[2]?.innerText?.trim() || '',
        totalEnrolled: tds[3]?.innerText?.trim() || '',
        activeEnrolled: tds[4]?.innerText?.trim() || '',
        lastUpdated: tds[5]?.innerText?.trim() || '',
        createdOn: tds[6]?.innerText?.trim() || '',
      });
    });
    return rows;
  });
}

/**
 * Paginate through all pages of the current table view.
 *
 * Why we compare first-row names: Naive UI's Next button is often NOT disabled
 * on the last page — clicking it does nothing visible but our script would loop
 * forever. If the first row of "page N+1" matches page N, we've stopped moving.
 */
async function getAllRows(frame) {
  const all = [];
  let lastFirst = null;
  for (let pg = 1; pg <= 20; pg++) {
    const rows = await getRows(frame);
    if (rows.length === 0) break;
    if (pg > 1 && rows[0]?.name === lastFirst) break;
    lastFirst = rows[0]?.name;
    all.push(...rows);
    try {
      const next = frame.locator('button:has-text("Next"), [aria-label="forward"]').first();
      const disabled = await next.getAttribute('disabled').catch(() => null);
      if (disabled !== null) break;
      await next.click();
      await sleep(2000);
    } catch (e) { break; }
  }
  return all;
}

/**
 * Click a row by name using GHL's search box.
 *
 * Why this exists: frame.locator(...).filter({ hasText: name }).click()
 * can click the WRONG row when workflow names share prefixes (e.g. multiple
 * workflows with a shared name prefix). Typing the full name into the search box narrows
 * to an exact-ish match; then we click the first result.
 */
async function clickViaSearch(frame, name) {
  try {
    const search = frame.locator('input[placeholder*="Search" i]').first();
    await search.click();
    await search.fill('');
    await search.type(name.slice(0, 30), { delay: 50 });
    await sleep(3000);
    // Click the first (and usually only) matching row
    await frame.getByText(name.trim(), { exact: true }).first().click({ timeout: 5000, force: true });
    return true;
  } catch (e) {
    return false;
  }
}

function kebab(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
async function main() {
  try { fs.unlinkSync(path.join(PROFILE_DIR, 'SingletonLock')); } catch (e) {}

  console.log('🚀 GHL Workflow Audit');
  console.log(`   Location: ${LOCATION_ID}`);
  console.log(`   Output: ${OUTPUT_DIR}`);
  console.log(`   Headless: ${HEADLESS ? 'yes' : 'no'}`);
  console.log('');

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    slowMo: SLOW_MO,
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
    serviceWorkers: 'block',
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await ctx.newPage();

  // ── Network interception ─────────────────────────────────────────────────
  // Capture BOTH endpoints in one pass:
  //   1. /workflow/{locationId}/{workflowId}  →  workflow body (actions, conditions)
  //   2. /workflow/{locationId}/trigger?workflowId=... →  trigger list
  const capturedApis = [];
  const triggersByWfId = {};

  page.on('response', async (resp) => {
    if (resp.status() !== 200) return;
    const url = resp.url();

    // Trigger endpoint
    if (url.includes('/trigger') && url.includes('workflowId')) {
      const m = url.match(/workflowId=([a-zA-Z0-9-]+)/);
      if (!m) return;
      const wfId = m[1];
      try {
        const body = await resp.json().catch(() => null);
        if (body) {
          triggersByWfId[wfId] = body;
          const count = Array.isArray(body) ? body.length : (body.triggers?.length || 1);
          console.log(`    🔔 Triggers for ${wfId.slice(0, 8)}: ${count} triggers`);
        }
      } catch (e) {}
      return;
    }

    // Workflow body endpoint (but not static assets, not the trigger endpoint)
    if (url.includes('leadconnectorhq.com') &&
        (url.includes('/workflow/') || url.includes('/workflows/')) &&
        !url.includes('.js') && !url.includes('.css') && !url.includes('.png')) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('text')) return;
        const body = await resp.json().catch(() => null);
        if (body && (body.workflowData || body.actions || body.name)) {
          capturedApis.push({ url, data: body, timestamp: new Date().toISOString() });
          console.log(`  🎯 ${body.name || url.slice(-50)} (${JSON.stringify(body).length} bytes)`);
        }
      } catch (e) {}
    }
  });

  // ── Login check ──────────────────────────────────────────────────────────
  console.log('📍 Loading workflow list...');
  try { await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60000 }); } catch (e) {}
  await sleep(3000);
  if (page.url().includes('login') || page.url().includes('signin')) {
    if (HEADLESS) {
      console.error('❌ Login required, but running headless. Run once non-headless to save session.');
      process.exit(2);
    }
    console.log('🔐 LOGIN REQUIRED — log in manually in the browser window (3 min timeout)');
    await page.waitForURL('**app.gohighlevel.com/v2/location**', { timeout: 180000 });
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 60000 });
  }

  let frame = await getFrame(page);
  console.log('✅ Frame ready\n');

  // ── Phase 1: list root folders ────────────────────────────────────────────
  const rootRows = await getRows(frame);
  console.log(`📂 ${rootRows.length} root items:`);
  rootRows.forEach(r => console.log(`   ${r.name} | ${r.status || '(folder)'}`));

  const results = {
    date: new Date().toISOString(),
    locationId: LOCATION_ID,
    folders: [],
  };

  // Known sub-folder IDs we discover during traversal — visit these at the end
  const subFoldersToVisit = [];

  // ── Phase 2: for each root folder, enumerate and visit its workflows ─────
  for (let fi = 0; fi < rootRows.length; fi++) {
    const folderName = rootRows[fi].name;
    console.log(`\n${'═'.repeat(60)}\n📁 [${fi + 1}/${rootRows.length}] ${folderName}\n${'═'.repeat(60)}`);

    // Navigate fresh to root and click into this folder
    try { await page.goto(BASE_URL, { waitUntil: 'load', timeout: 45000 }); } catch (e) {}
    await sleep(3000);
    frame = await getFrame(page, 30);

    try {
      await frame.locator('.n-data-table-td:nth-child(2)').filter({ hasText: folderName }).first().click({ timeout: 5000 });
    } catch (e) {
      try { await frame.locator('.n-data-table-tr .n-data-table-td:nth-child(2)').nth(fi).click({ timeout: 5000 }); } catch (e2) {
        console.log(`  ⚠️ Could not enter folder`);
        results.folders.push({ name: folderName, error: 'click failed' });
        continue;
      }
    }
    await sleep(3000);

    const items = await getAllRows(frame);
    console.log(`  📋 ${items.length} items:`);
    items.forEach((w, i) => console.log(`    ${i + 1}. ${w.name} [${w.status || '(sub-folder?)'}]`));

    const folderResult = { name: folderName, lastUpdated: rootRows[fi].lastUpdated, workflows: [] };

    // Visit each item in this folder
    for (let wi = 0; wi < items.length; wi++) {
      const wf = items[wi];
      console.log(`\n  🔗 [${wi + 1}/${items.length}] ${wf.name}`);

      // Fresh navigation back to the folder
      try { await page.goto(BASE_URL, { waitUntil: 'load', timeout: 45000 }); } catch (e) {}
      await sleep(3000);
      frame = await getFrame(page, 30);
      try {
        await frame.locator('.n-data-table-td:nth-child(2)').filter({ hasText: folderName }).first().click({ timeout: 5000 });
      } catch (e) {
        try { await frame.locator('.n-data-table-tr .n-data-table-td:nth-child(2)').nth(fi).click({ timeout: 5000 }); } catch (e2) { continue; }
      }
      await sleep(3000);

      // Paginate to the right page if needed (items on page 2+ are at index wi % 10)
      const pageNum = Math.floor(wi / 10) + 1;
      for (let p = 1; p < pageNum; p++) {
        try {
          await frame.locator('button:has-text("Next"), [aria-label="forward"]').first().click({ timeout: 3000 });
          await sleep(2000);
        } catch (e) { break; }
      }

      const rowIdx = wi % 10;

      // Click the row — first try by index, then by search-box fallback
      let clicked = false;
      try {
        await frame.locator('.n-data-table-tr .n-data-table-td:nth-child(2)').nth(rowIdx).click({ timeout: 5000 });
        clicked = true;
      } catch (e) {
        console.log(`    ⚠️ Row-index click failed, trying search fallback...`);
        clicked = await clickViaSearch(frame, wf.name);
      }

      if (!clicked) {
        console.log(`    ❌ Could not open workflow`);
        folderResult.workflows.push({ ...wf, error: 'click failed' });
        continue;
      }

      // Wait for editor to load + API calls to fire
      await sleep(8000);

      const editorUrl = page.url();
      const wfIdMatch = editorUrl.match(/workflow\/([a-zA-Z0-9-]+)/);
      const folderIdMatch = editorUrl.match(/folder=([a-zA-Z0-9-]+)/);

      if (folderIdMatch && !wfIdMatch) {
        console.log(`    📁 Sub-folder detected (id=${folderIdMatch[1]}) — will visit later`);
        subFoldersToVisit.push({
          parentFolder: folderName,
          name: wf.name,
          id: folderIdMatch[1],
        });
        folderResult.workflows.push({ ...wf, isSubFolder: true, subFolderId: folderIdMatch[1] });
        continue;
      }

      const wfId = wfIdMatch ? wfIdMatch[1] : '';
      console.log(`    ID: ${wfId}`);
      await ss(page, `${folderName}_${wf.name}`);

      folderResult.workflows.push({ ...wf, workflowId: wfId, editorUrl });
    }

    results.folders.push(folderResult);
    fs.writeFileSync(path.join(RAW_DIR, 'captured-apis.json'), JSON.stringify(capturedApis, null, 2));
    fs.writeFileSync(path.join(RAW_DIR, 'triggers-by-id.json'), JSON.stringify(triggersByWfId, null, 2));
    console.log(`  💾 Progress saved`);
  }

  // ── Phase 3: recurse into discovered sub-folders ──────────────────────────
  if (subFoldersToVisit.length > 0) {
    console.log(`\n${'═'.repeat(60)}\n📂 Sub-folders to recurse: ${subFoldersToVisit.length}\n${'═'.repeat(60)}`);

    for (const sf of subFoldersToVisit) {
      console.log(`\n📁 ${sf.parentFolder} → ${sf.name} (${sf.id})`);
      const subUrl = `${BASE_URL}?folder=${sf.id}`;
      try { await page.goto(subUrl, { waitUntil: 'load', timeout: 45000 }); } catch (e) {}
      await sleep(5000);
      frame = await getFrame(page, 30).catch(() => null);
      if (!frame) { console.log(`  ⚠️ Frame not loaded`); continue; }

      const subItems = await getAllRows(frame);
      console.log(`  📋 ${subItems.length} items inside`);

      const subResult = { parent: sf.parentFolder, name: sf.name, workflows: [] };

      for (let si = 0; si < subItems.length; si++) {
        const wf = subItems[si];
        console.log(`    🔗 [${si + 1}/${subItems.length}] ${wf.name}`);

        try { await page.goto(subUrl, { waitUntil: 'load', timeout: 45000 }); } catch (e) {}
        await sleep(4000);
        frame = await getFrame(page, 20).catch(() => null);
        if (!frame) { subResult.workflows.push({ ...wf, error: 'frame failed' }); continue; }

        try {
          await frame.locator('.n-data-table-tr .n-data-table-td:nth-child(2)').nth(si).click({ timeout: 5000 });
        } catch (e) {
          const clicked = await clickViaSearch(frame, wf.name);
          if (!clicked) { subResult.workflows.push({ ...wf, error: 'click failed' }); continue; }
        }
        await sleep(8000);

        const editorUrl = page.url();
        const wfIdMatch = editorUrl.match(/workflow\/([a-zA-Z0-9-]+)/);
        const wfId = wfIdMatch ? wfIdMatch[1] : '';
        console.log(`      ID: ${wfId}`);
        await ss(page, `${sf.parentFolder}_${sf.name}_${wf.name}`);

        subResult.workflows.push({ ...wf, workflowId: wfId, editorUrl });
      }

      results.folders.push({ name: `${sf.parentFolder} / ${sf.name}`, isSubFolder: true, ...subResult });
      fs.writeFileSync(path.join(RAW_DIR, 'captured-apis.json'), JSON.stringify(capturedApis, null, 2));
      fs.writeFileSync(path.join(RAW_DIR, 'triggers-by-id.json'), JSON.stringify(triggersByWfId, null, 2));
    }
  }

  // ── Phase 4: merge actions + triggers into workflows-with-triggers.json ──
  console.log(`\n${'═'.repeat(60)}\n🔗 Merging ${capturedApis.length} APIs + ${Object.keys(triggersByWfId).length} trigger sets\n${'═'.repeat(60)}`);

  // De-dupe by workflow ID, keep most recent capture
  const byId = {};
  for (const c of capturedApis) {
    const wid = c.data.id || c.data._id;
    if (wid) byId[wid] = c.data;
  }

  const merged = Object.values(byId).map(wf => {
    const wid = wf.id || wf._id;
    return { ...wf, _triggers: triggersByWfId[wid] || null };
  });

  fs.writeFileSync(path.join(RAW_DIR, 'workflows-with-triggers.json'), JSON.stringify(merged, null, 2));
  fs.writeFileSync(path.join(RAW_DIR, 'captured-apis.json'), JSON.stringify(capturedApis, null, 2));
  fs.writeFileSync(path.join(RAW_DIR, 'triggers-by-id.json'), JSON.stringify(triggersByWfId, null, 2));

  // ── Phase 5: write AUDIT_SUMMARY.md ──────────────────────────────────────
  const published = merged.filter(w => w.status === 'published').length;
  const drafts = merged.filter(w => w.status === 'draft').length;
  const totalSteps = merged.reduce((s, w) => s + (w.workflowData?.templates?.length || 0), 0);
  const withTriggers = merged.filter(w => w._triggers).length;

  const summary = `# GHL Workflow Audit — ${today}

**Location:** ${LOCATION_ID}
**Captured at:** ${new Date().toISOString()}

## Stats

- **${merged.length}** unique workflows captured
  - ${published} published
  - ${drafts} draft
- **${withTriggers}/${merged.length}** workflows have trigger data
- **${totalSteps}** total action/condition steps across all workflows
- **${results.folders.length}** folders traversed

## Folders

${results.folders.map(f => `- **${f.name}** — ${f.workflows?.length || 0} workflows`).join('\n')}

## Files in this snapshot

- \`raw/workflows-with-triggers.json\` — primary output (merged actions + triggers)
- \`raw/captured-apis.json\` — raw network responses (all workflow body captures)
- \`raw/triggers-by-id.json\` — trigger responses keyed by workflow ID
- \`screenshots/\` — one PNG per workflow editor

## Next steps

1. Generate human-readable \`AUDIT.md\` from this snapshot
2. Generate per-automation YAML source of truth files
3. Run drift detection against existing \`automations/*/workflow.yml\`
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, 'AUDIT_SUMMARY.md'), summary);

  console.log(`\n✅ AUDIT COMPLETE`);
  console.log(`   ${merged.length} workflows captured (${published} published, ${drafts} draft)`);
  console.log(`   ${withTriggers}/${merged.length} have triggers`);
  console.log(`   Output: ${OUTPUT_DIR}`);

  if (!HEADLESS) {
    console.log('\n⏳ Browser stays open 15s — inspect, then it closes');
    await sleep(15000);
  }
  await ctx.close();
}

main().catch(e => {
  console.error('\n❌ Fatal error:', e);
  process.exit(1);
});
