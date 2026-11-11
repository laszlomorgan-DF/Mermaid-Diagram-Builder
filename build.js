#!/usr/bin/env node
// Builds the single offline HTML file: dist/SQL-ER-Diagram-Builder.html
// Everything (Mermaid, node-sql-parser dialect builds, core, UI, samples) is inlined — no network access at runtime.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const pkgVersion = (p) => JSON.parse(read(`node_modules/${p}/package.json`)).version;

function inlineScript(code, label) {
  if (/<\/script/i.test(code)) code = code.replace(/<\/script/gi, '<\\/script');
  if (/<!--/.test(code) && /<script/i.test(code)) throw new Error(`${label}: contains "<!--" and "<script", which can break inline HTML scripts`);
  return `<script data-src="${label}">\n${code}\n</script>`;
}

const samples = {
  'SQL Server (SSMS script)': read('tests/fixtures/mssql_ssms.sql'),
  'PostgreSQL (pg_dump)': read('tests/fixtures/pg_dump.sql'),
  'MySQL (mysqldump)': read('tests/fixtures/mysql_dump.sql'),
};

const scripts = [
  inlineScript(read('node_modules/mermaid/dist/mermaid.min.js'), `mermaid ${pkgVersion('mermaid')}`),
  ...['transactsql', 'postgresql', 'mysql'].map((d) => inlineScript(
    read(`node_modules/node-sql-parser/umd/${d}.umd.js`) + `\n;window.__NSP = window.__NSP || {}; window.__NSP[${JSON.stringify(d)}] = window.Parser;`,
    `node-sql-parser ${pkgVersion('node-sql-parser')} (${d})`)),
  inlineScript(read('src/core.js'), 'core'),
  inlineScript('window.__SAMPLES = ' + JSON.stringify(samples).replace(/</g, '\\u003c') + ';', 'samples'),
  inlineScript(read('src/app.js'), 'app'),
];

let html = read('src/index.html');
html = html.replace('/*INLINE:css*/', () => read('src/app.css'));
html = html.replace('<!--INLINE:scripts-->', () => scripts.join('\n'));
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'SQL-ER-Diagram-Builder.html');
fs.writeFileSync(out, html);
console.log(`Built ${path.relative(ROOT, out)} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB) — mermaid ${pkgVersion('mermaid')}, node-sql-parser ${pkgVersion('node-sql-parser')}`);
