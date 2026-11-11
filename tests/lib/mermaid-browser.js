// Runs Mermaid's own parser/renderer (the same mermaid.min.js that gets inlined
// into the tool) inside headless Edge, so syntax checks use the real thing.
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'puppeteer.json'), 'utf8'));

async function openMermaid() {
  const browser = await puppeteer.launch(cfg);
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><div id="c"></div></body></html>');
  await page.addScriptTag({ path: path.join(ROOT, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js') });
  await page.evaluate(() => {
    window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', maxTextSize: 5e6, maxEdges: 5000, er: { htmlLabels: false } });
  });
  let n = 0;
  return {
    async check(src) {
      return page.evaluate(async (src, id) => {
        try {
          await window.mermaid.parse(src);
          const { svg } = await window.mermaid.render(id, src);
          return { ok: true, svgLength: svg.length };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e).split('\n').slice(0, 4).join(' / ') };
        }
      }, src, 'm' + (n++));
    },
    close: () => browser.close(),
  };
}

module.exports = { openMermaid };
