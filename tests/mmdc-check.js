#!/usr/bin/env node
// Acceptance check with the official Mermaid CLI (mmdc): every .mmd given (default: tests/expected/*.mmd) must render without error.
// Usage: node tests/mmdc-check.js [file-or-dir ...]
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'node_modules', '@mermaid-js', 'mermaid-cli', 'src', 'cli.js');
const CFG = path.join(ROOT, 'tests', 'puppeteer.json');
const args = process.argv.slice(2);
const inputs = (args.length ? args : [path.join(ROOT, 'tests', 'expected')]).flatMap((p) =>
  fs.statSync(p).isDirectory() ? fs.readdirSync(p).filter((f) => f.endsWith('.mmd')).map((f) => path.join(p, f)) : [p]);
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mmdc-'));
let bad = 0;
for (const f of inputs) {
  const svg = path.join(out, path.basename(f) + '.svg');
  try {
    execFileSync(process.execPath, [CLI, '-q', '-p', CFG, '-i', f, '-o', svg], { stdio: 'pipe' });
    const s = fs.readFileSync(svg, 'utf8');
    if (/Syntax error|Parse error/i.test(s)) throw new Error('SVG contains a Mermaid error message');
    console.log(`  ok    ${path.relative(ROOT, f)}  (${(s.length / 1024).toFixed(0)} KB svg)`);
  } catch (e) {
    bad++;
    console.log(`  FAIL  ${path.relative(ROOT, f)}\n        ${String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 3).join('\n        ')}`);
  }
}
fs.rmSync(out, { recursive: true, force: true });
console.log(`mmdc: ${inputs.length - bad}/${inputs.length} rendered`);
process.exit(bad ? 1 : 0);
