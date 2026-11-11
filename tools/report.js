#!/usr/bin/env node
// Prints what the tool makes of a SQL file and writes <file>.mmd next to it.
// Usage: node tools/report.js samples/my-schema.sql [--dialect tsql|postgres|mysql]
const fs = require('fs');
const path = require('path');
const E = require('../src/core.js');
const { Parser } = require('node-sql-parser');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const di = args.indexOf('--dialect');
if (!file) { console.error('Usage: node tools/report.js <file.sql> [--dialect tsql|postgres|mysql]'); process.exit(1); }
const sql = fs.readFileSync(file, 'utf8');
const m = E.parseSql(sql, { dialect: di >= 0 ? args[di + 1] : 'auto', crossCheck: Parser });
const s = E.summarize(m);
const d = m.detected;

console.log(`\n${path.basename(file)} — ${sql.split('\n').length} lines`);
console.log(`Dialect: ${E.DIALECTS[m.dialect].label}${di >= 0 ? ' (you chose it)' : d.confident ? ' (detected, confident)' : ' (detected, NOT confident — pass --dialect if wrong)'}   scores ${JSON.stringify(d.scores)}`);
console.log(`Model:   ${s.tables} tables, ${s.columns} columns, ${s.fks} foreign keys`);
console.log(`Read:    ${s.statements} statements — ${s.applied} read, ${s.partial} partly read, ${s.ignored} not structural, ${s.unread} unread`);
const cc = m.crossCheck;
console.log(`Cross-check: ${cc.confirmed}/${cc.checked} confirmed by node-sql-parser, ${cc.disagreed} disagree, ${cc.grammarFailed} it could not parse, ${cc.misread} it misread`);

const ignoredKinds = {};
for (const r of m.log.filter((x) => x.status === 'ignored')) ignoredKinds[r.kind] = (ignoredKinds[r.kind] || 0) + 1;
console.log(`Ignored (not part of a table diagram): ${Object.entries(ignoredKinds).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`);

const problems = [];
for (const r of m.log) {
  if (r.status === 'unread') problems.push([r.line, 'UNREAD', (r.notes.find((n) => n.level === 'warning') || {}).message || '', r.snippet]);
  else for (const n of r.notes.filter((x) => x.level === 'warning')) problems.push([r.line, 'PARTLY', n.message, r.snippet]);
}
for (const i of m.issues) problems.push([i.line, 'MODEL', i.message, '']);
console.log(`\nProblems: ${problems.length || 'none'}`);
for (const [line, kind, msg, snip] of problems.sort((a, b) => (a[0] || 0) - (b[0] || 0))) console.log(`  line ${String(line).padStart(5)}  ${kind.padEnd(6)}  ${msg}${snip ? `\n                        ${snip.slice(0, 110)}` : ''}`);

const g = E.guessRelationships(m);
console.log(`\nGuessed relationships (drawn dotted, labelled "guess:"): ${g.length || 'none'}`);
for (const x of g) console.log(`  ${x.from.table}.${x.columns[0]} → ${x.refTable}.${x.refColumns[0]}   (${x.reason})`);

const out = file.replace(/\.[^.]+$/, '') + '.mmd';
fs.writeFileSync(out, E.toMermaid(m).text);
console.log(`\nMermaid written to ${out}`);
