#!/usr/bin/env node
// Drives the built single-file tool in headless Edge like a user would, with ALL network access blocked.
// Usage: node tests/ui-test.js [screenshotDir]
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const E = require('../src/core.js');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'dist', 'SQL-ER-Diagram-Builder.html');
const SHOTS = process.argv[2] || path.join(ROOT, 'tests', 'out');
fs.mkdirSync(SHOTS, { recursive: true });
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'puppeteer.json'), 'utf8'));

let pass = 0, fail = 0; const failures = [];
const check = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch(cfg);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const consoleErrors = [], netAttempts = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  await page.setRequestInterception(true);
  page.on('request', (r) => { const u = r.url(); if (u.startsWith('file:') || u.startsWith('data:') || u.startsWith('blob:')) r.continue(); else { netAttempts.push(u); r.abort(); } });
  const dl = path.join(SHOTS, 'downloads'); fs.rmSync(dl, { recursive: true, force: true }); fs.mkdirSync(dl, { recursive: true });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });

  const url = 'file:///' + HTML.replace(/\\/g, '/');
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'load' });

  check('libraries loaded (mermaid + 3 node-sql-parser dialects)', await page.evaluate(() => !!window.mermaid && ['transactsql', 'postgresql', 'mysql'].every((d) => typeof window.__NSP[d] === 'function')));
  check('empty state shown on first open', await page.$eval('#emptyState', (e) => !e.hidden));
  await page.screenshot({ path: path.join(SHOTS, '01-empty.png') });

  // Sample: SQL Server
  await page.evaluate(() => [...document.querySelectorAll('#sampleButtons button')].find((b) => /SQL Server/.test(b.textContent)).click());
  await page.waitForSelector('#diagram svg', { timeout: 20000 });
  await sleep(400);
  const entities = await page.$$eval('#diagram svg [data-table]', (els) => [...new Set(els.map((e) => e.dataset.table))]);
  check('diagram drawn with 5 clickable tables', entities.length === 5, JSON.stringify(entities));
  check('dialect detected as SQL Server', /SQL Server/.test(await page.$eval('#dialectHint', (e) => e.textContent)));
  check('summary shows cross-check result', /Cross-check: \d+\/\d+ confirmed/.test(await page.$eval('#parseSummary', (e) => e.textContent)), await page.$eval('#parseSummary', (e) => e.textContent));
  check('problems: none', /Problems \(none\)/.test(await page.$eval('#problemsTitle', (e) => e.textContent)));
  await page.screenshot({ path: path.join(SHOTS, '02-mssql-sample.png') });

  // Click a table in the diagram → Tables tab with its detail
  const box = await page.evaluate(() => { const g = document.querySelector('#diagram svg [data-table="dbo.customers"]'); const r = g.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 12 }; });
  await page.mouse.click(box.x, box.y);
  await sleep(200);
  check('clicking a diagram table opens it in Tables tab', await page.evaluate(() => document.querySelector('.tab.active').dataset.tab === 'tables' && /Customers/.test(document.querySelector('#tableDetail h3').textContent)));

  // Add a manual column with the keyboard
  await page.type('.addcol input[aria-label="New column name"]', 'LoyaltyTier');
  await page.type('.addcol input[aria-label="New column type"]', 'varchar(10)');
  await page.keyboard.press('Enter');
  await sleep(700);
  check('manual column appears in Mermaid with "manual" note', await page.evaluate(() => /varchar\(10\) LoyaltyTier "manual"/.test(document.querySelector('#mermaidCode').textContent)));
  check('manual column drawn in SVG', await page.evaluate(() => document.querySelector('#diagram svg').textContent.includes('LoyaltyTier')));
  check('focus returns to name input for the next column', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-label') === 'New column name'));
  // Add one with a link
  await page.type('.addcol input[aria-label="New column name"]', 'PreferredProduct');
  await page.type('.addcol input[aria-label="New column type"]', 'char(8)');
  await page.select('.addcol select[aria-label="References"]', 'dbo.products');
  await page.click('.addcol .btn.primary');
  await sleep(700);
  check('manual link drawn', await page.evaluate(() => /dbo__Products \|o\.\.o\{ dbo__Customers : "PreferredProduct \(manual\)"/.test(document.querySelector('#mermaidCode').textContent)), await page.$eval('#mermaidCode', (e) => e.textContent.split('\n').filter((l) => /PreferredProduct/.test(l)).join(' | ')));
  await page.screenshot({ path: path.join(SHOTS, '03-manual-column.png') });

  // Re-import SQL that now contains LoyaltyTier → conflict, manual items kept
  await page.evaluate(() => { const ta = document.getElementById('sql'); ta.value += '\nALTER TABLE [dbo].[Customers] ADD [LoyaltyTier] [varchar](10) NULL\nGO\n'; ta.dispatchEvent(new Event('input')); });
  await sleep(1200);
  check('re-import flags the now-duplicate manual column', /Problems \(1\)/.test(await page.$eval('#problemsTitle', (e) => e.textContent)) && /LoyaltyTier is now in the SQL/.test(await page.$eval('#problemsBody', (e) => e.textContent)), await page.$eval('#problemsBody', (e) => e.textContent.slice(0, 300)));
  check('other manual column survives re-import', await page.evaluate(() => window.__erdApp.state.overlay.columns.length === 2 && /PreferredProduct/.test(document.querySelector('#mermaidCode').textContent)));
  // resolve via the panel button
  await page.evaluate(() => [...document.querySelectorAll('#problemsBody button')].find((b) => /delete the manual copy/.test(b.textContent)).click());
  await sleep(600);
  check('conflict resolved from the Problems panel', /Problems \(none\)/.test(await page.$eval('#problemsTitle', (e) => e.textContent)));

  // Persistence across reload
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#diagram svg', { timeout: 20000 });
  await sleep(400);
  check('work restored after reload', await page.evaluate(() => window.__erdApp.state.overlay.columns.length === 1 && /PreferredProduct/.test(document.querySelector('#mermaidCode').textContent)));

  // Focus + schema filter
  await page.select('#focus', 'sales.orderlines');
  await sleep(700);
  const focused = await page.evaluate(() => window.__erdApp.lastOut.view.tables.map((t) => t.name).sort().join(','));
  check('focus on OrderLines shows only it and its neighbours', focused === 'OrderLines,Orders,Products,Shipments', focused);
  await page.select('#focus', '');
  await page.evaluate(() => [...document.querySelectorAll('#schemaFilter .chip')].find((c) => c.textContent === 'dbo').click());
  await sleep(700);
  check('schema filter hides dbo tables and reports hidden links', await page.evaluate(() => window.__erdApp.lastOut.view.tables.every((t) => t.schema === 'sales') && /not drawn because the table at the other end is filtered out/.test(document.querySelector('#problemsBody').textContent)));
  await page.evaluate(() => [...document.querySelectorAll('#schemaFilter .chip')].find((c) => c.textContent === 'dbo').click());
  await sleep(500);

  // Verify tab: feed a catalog result produced by a REAL PostgreSQL loaded with the same structure
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  const baseModel = await page.evaluate(() => JSON.parse(JSON.stringify(window.__erdApp.base)));
  await db.exec(E.toDDL(baseModel, 'postgres', { portable: true }));
  const rows = (await db.query(E.CATALOG_QUERIES.postgres)).rows;
  await db.close();
  // T-SQL schema names survive; this simulates pasting SSMS "Copy with Headers" (tab-separated) output.
  const tsv = [E.CATALOG_COLUMNS.join('\t'), ...rows.map((r) => E.CATALOG_COLUMNS.map((c) => (r[c] == null ? 'NULL' : String(r[c]))).join('\t'))].join('\r\n');
  await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'verify').click());
  await page.evaluate((t) => { const ta = document.getElementById('catalogText'); ta.value = t; ta.dispatchEvent(new Event('input')); }, tsv);
  await sleep(900);
  const verdict = await page.$eval('#verifyResult', (e) => e.textContent);
  check('Verify: matches the database', /matches the database/.test(verdict), verdict.slice(0, 300));
  await page.screenshot({ path: path.join(SHOTS, '04-verify.png') });
  // Negative: remove one FK row → must be reported
  const tsvMissing = tsv.split('\r\n').filter((l) => !/FK_Orders_Customers/.test(l)).join('\r\n');
  await page.evaluate((t) => { const ta = document.getElementById('catalogText'); ta.value = t; ta.dispatchEvent(new Event('input')); }, tsvMissing);
  await sleep(900);
  check('Verify: missing FK in database is reported', /CustomerID→customers\(customerid\) is in the model but not in the database/i.test(await page.$eval('#verifyResult', (e) => e.textContent)));
  await page.evaluate(() => { const ta = document.getElementById('catalogText'); ta.value = ''; ta.dispatchEvent(new Event('input')); });
  await sleep(400);

  // Exports
  for (const kind of ['mmd', 'svg', 'png', 'json', 'migration', 'ddl']) {
    await page.click('#btnExport');
    await page.click(`#exportMenu button[data-export="${kind}"]`);
    await sleep(kind === 'png' ? 2500 : 700);
  }
  const files = fs.readdirSync(dl);
  const find = (re) => files.find((f) => re.test(f));
  const png = find(/\.png$/), svg = find(/\.svg$/), mmd = find(/\.mmd$/), mig = find(/manual-changes\.sql$/), ddl = find(/schema\.sql$/), json = find(/model\.json$/);
  check('exports written: mmd, svg, png, json, manual-changes.sql, schema.sql', png && svg && mmd && mig && ddl && json, files.join(', '));
  if (png) { const b = fs.readFileSync(path.join(dl, png)); check('PNG is a real image (not blank-tainted)', b.slice(1, 4).toString() === 'PNG' && b.length > 20000, b.length + ' bytes'); }
  if (mig) check('manual-changes.sql adds the manual column and link', /ALTER TABLE \[dbo\]\.\[Customers\] ADD \[PreferredProduct\] char\(8\) NULL/.test(fs.readFileSync(path.join(dl, mig), 'utf8')) && /FOREIGN KEY \(\[PreferredProduct\]\) REFERENCES \[dbo\]\.\[Products\]/.test(fs.readFileSync(path.join(dl, mig), 'utf8')));
  if (mmd) fs.copyFileSync(path.join(dl, mmd), path.join(SHOTS, 'exported.mmd'));

  // Manual table creation
  await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.dataset.tab === 'tables').click());
  await page.click('#btnNewTable');
  await page.evaluate(() => { document.getElementById('ntSchema').value = 'sales'; });
  await page.type('#ntName', 'Returns');
  await page.keyboard.press('Enter');
  await sleep(700);
  check('manual table created with an Id PK', await page.evaluate(() => /sales__Returns\["sales\.Returns \(manual\)"\]/.test(document.querySelector('#mermaidCode').textContent) && /int Id PK "manual"/.test(document.querySelector('#mermaidCode').textContent)));
  await page.screenshot({ path: path.join(SHOTS, '05-tables-tab.png') });

  // Postgres + MySQL samples, and dark mode
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
  for (const s of ['PostgreSQL', 'MySQL']) {
    await page.evaluate(() => { localStorage.clear(); });
    await page.reload({ waitUntil: 'load' });
    await page.evaluate((s) => [...document.querySelectorAll('#sampleButtons button')].find((b) => b.textContent.includes(s)).click(), s);
    await page.waitForSelector('#diagram svg', { timeout: 20000 }); await sleep(500);
    const n = await page.evaluate(() => window.__erdApp.merged.tables.length);
    check(`${s} sample renders`, n === 4, String(n));
    await page.screenshot({ path: path.join(SHOTS, `06-${s.toLowerCase()}-dark.png`) });
  }
  // Narrow screen
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]);
  await page.setViewport({ width: 390, height: 844 });
  await sleep(500);
  check('no horizontal page scroll at phone width', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), await page.evaluate(() => document.documentElement.scrollWidth + ' > ' + window.innerWidth));
  await page.screenshot({ path: path.join(SHOTS, '07-phone.png') });

  check('no network requests attempted (fully offline)', netAttempts.length === 0, netAttempts.join(', '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
  await browser.close();
  console.log(`UI: ${pass} passed, ${fail} failed. Screenshots in ${SHOTS}`);
  if (fail) { console.log('  ' + failures.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(2); });
