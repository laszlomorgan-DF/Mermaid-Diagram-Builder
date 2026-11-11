#!/usr/bin/env node
/*
 * Test suite. Each check is tied to an acceptance criterion:
 *
 *  [facts]      Hand-written expectations per fixture, derived by reading the SQL (not from parser output).
 *  [golden]     Saved expected model + Mermaid per fixture (regression snapshots; refresh with --update after reviewing diffs).
 *  [roundtrip]  SQL → model → DDL → model gives the same model.
 *  [mermaid]    Every Mermaid variant parses and renders with the real mermaid.min.js (headless Edge).
 *  [database]   Real PostgreSQL (PGlite, WASM build of Postgres): load DDL, run the catalog query the tool ships,
 *               and the counts/keys must match the model.
 *  [overlay]    Manual edits survive re-import, conflicts are flagged, exported ALTERs reproduce the edits.
 *  [catalog]    The catalog-result reader accepts CSV, TSV and psql/mysql table output.
 *
 * Usage: node tests/run-tests.js [--update] [--skip-browser]
 */
const fs = require('fs');
const path = require('path');
const E = require('../src/core.js');
const { Parser } = require('node-sql-parser');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const EXP = path.join(ROOT, 'tests', 'expected');
const UPDATE = process.argv.includes('--update');
const SKIP_BROWSER = process.argv.includes('--skip-browser');

let pass = 0, fail = 0;
const failures = [];
function check(area, name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++; failures.push(`[${area}] ${name}${detail ? '\n      ' + detail : ''}`); return false;
}
const lc = (s) => String(s || '').toLowerCase();
const fkSig = (t, f) => `${t.name}(${f.columns.join(',')})->${f.refTable}(${f.refColumns.join(',')})`;
const allFks = (m) => m.tables.flatMap((t) => t.fks.map((f) => fkSig(t, f))).sort();
const tbl = (m, name) => m.tables.find((t) => lc(t.name) === lc(name));
const unreadCount = (m) => m.log.filter((r) => r.status === 'unread').length;

const fixtures = fs.readdirSync(FIX).filter((f) => f.endsWith('.sql')).sort();
const models = {};
for (const f of fixtures) models[f] = E.parseSql(fs.readFileSync(path.join(FIX, f), 'utf8'), { crossCheck: Parser });

// ───────────── [facts] hand-written expectations ─────────────
const FACTS = {
  'mssql_ssms.sql': (m) => {
    check('facts', 'mssql: dialect detected', m.dialect === 'tsql' && m.detected.confident);
    check('facts', 'mssql: 5 tables', m.tables.length === 5, m.tables.map((t) => t.name).join(','));
    check('facts', 'mssql: FKs incl. composite and ALTER-added', JSON.stringify(allFks(m)) === JSON.stringify([
      'OrderLines(OrderID)->Orders(OrderID)', 'OrderLines(ProductCode)->Products(ProductCode)', 'Orders(CustomerID)->Customers(CustomerID)', 'Shipments(OrderID,LineNo)->OrderLines(OrderID,LineNo)']), allFks(m).join(' | '));
    check('facts', 'mssql: NOCHECK FK marked disabled', tbl(m, 'OrderLines').fks.find((f) => f.name === 'FK_OrderLines_Products').disabled === true);
    check('facts', 'mssql: composite PK', tbl(m, 'OrderLines').pk.columns.join() === 'OrderID,LineNo');
    check('facts', 'mssql: schema-qualified', tbl(m, 'Orders').schema === 'sales' && tbl(m, 'Customers').schema === 'dbo');
    check('facts', 'mssql: unique constraint + filtered unique index', tbl(m, 'Customers').uniques[0].columns.join() === 'Email' && tbl(m, 'Shipments').uniques[0].where === '([CarrierRef] IS NOT NULL)');
    check('facts', 'mssql: bracketed name with space', !!tbl(m, 'Customers').columns.find((c) => c.name === 'Display Name'));
    check('facts', 'mssql: types cleaned of brackets', tbl(m, 'Customers').columns.find((c) => c.name === 'Balance').type === 'decimal(10,2)' && tbl(m, 'Customers').columns.find((c) => c.name === 'Notes').type === 'nvarchar(max)');
    check('facts', 'mssql: DEFAULT … FOR applied', tbl(m, 'Customers').columns.find((c) => c.name === 'Balance').default === '((0))');
    check('facts', 'mssql: nothing unread (view/proc are ignored, not unread)', unreadCount(m) === 0);
    check('facts', 'mssql: procedure body kept whole', m.log.filter((r) => r.kind === 'create-procedure').length === 1 && !m.log.some((r) => r.snippet.startsWith('END')));
  },
  'pg_dump.sql': (m) => {
    check('facts', 'pg: dialect detected', m.dialect === 'postgres' && m.detected.confident);
    check('facts', 'pg: 4 tables', m.tables.length === 4);
    check('facts', 'pg: FKs from late ALTER TABLE ONLY', JSON.stringify(allFks(m)) === JSON.stringify(['invoice_lines(account_id,invoice_no)->invoices(account_id,invoice_no)', 'invoices(account_id)->accounts(id)']), allFks(m).join(' | '));
    check('facts', 'pg: 3-column PK', tbl(m, 'invoice_lines').pk.columns.join() === 'account_id,invoice_no,line_no');
    check('facts', 'pg: quoted mixed-case column kept', !!tbl(m, 'accounts').columns.find((c) => c.name === 'Display Name'));
    check('facts', 'pg: COMMENT ON COLUMN applied', tbl(m, 'accounts').columns.find((c) => c.name === 'email').comment === 'Login email; must be unique');
    check('facts', 'pg: unique constraint + unique index', tbl(m, 'accounts').uniques.length === 1 && tbl(m, 'products').uniques.length === 1);
    check('facts', 'pg: dollar-quoted function did not split', unreadCount(m) === 0);
    const g = E.guessRelationships(m).map((x) => `${x.from.table}.${x.columns[0]}->${x.refTable}`);
    check('facts', 'pg: only the undeclared product_id is guessed', JSON.stringify(g) === JSON.stringify(['invoice_lines.product_id->products']), g.join(', '));
  },
  'mysql_dump.sql': (m) => {
    check('facts', 'mysql: dialect detected', m.dialect === 'mysql' && m.detected.confident);
    check('facts', 'mysql: 4 tables, /*! */ and DROP IF EXISTS handled', m.tables.length === 4 && unreadCount(m) === 0);
    check('facts', 'mysql: inline FKs', JSON.stringify(allFks(m)) === JSON.stringify(['contacts(company_id)->companies(id)', 'deals(company_id)->companies(id)', 'deals(owner_contact_id)->contacts(id)']), allFks(m).join(' | '));
    check('facts', 'mysql: UNIQUE KEY', tbl(m, 'companies').uniques[0].columns.join() === 'vat_no');
    check('facts', 'mysql: enum type kept', tbl(m, 'companies').columns.find((c) => c.name === 'status').type === "enum('lead','active','churned')");
    const g = E.guessRelationships(m).map((x) => `${x.from.table}.${x.columns[0]}->${x.refTable}`);
    check('facts', 'mysql: notes.deal_id guessed', JSON.stringify(g) === JSON.stringify(['notes.deal_id->deals']), g.join(', '));
  },
  'tsql_handwritten.sql': (m) => {
    check('facts', 'tsql-hw: dialect detected', m.dialect === 'tsql');
    check('facts', 'tsql-hw: 3 tables without GO', m.tables.length === 3, m.tables.map((t) => t.name).join(','));
    check('facts', 'tsql-hw: inline/self/late FKs', JSON.stringify(allFks(m)) === JSON.stringify([
      'Departments(ParentDepartmentId)->Departments(DepartmentId)', 'EmployeeBadges(EmployeeId)->Employees(EmployeeId)', 'Employees(CompanyCarId)->CompanyCars(CarId)', 'Employees(DepartmentId)->Departments(DepartmentId)', 'Employees(ManagerId)->Employees(EmployeeId)']), allFks(m).join(' | '));
    check('facts', 'tsql-hw: FK to missing table flagged unresolved', tbl(m, 'Employees').fks.find((f) => f.refTable === 'CompanyCars').unresolved === true);
    const emp = tbl(m, 'Employees');
    check('facts', 'tsql-hw: ADD a, b (one ADD) added both', !!emp.columns.find((c) => c.name === 'HiredOn') && !!emp.columns.find((c) => c.name === 'TerminatedOn'));
    check('facts', 'tsql-hw: ]] escape and keyword name', !!emp.columns.find((c) => c.name === 'Weird]Name') && !!emp.columns.find((c) => c.name === 'Order'));
    check('facts', 'tsql-hw: computed column', emp.columns.find((c) => c.name === 'FullName').computed === true);
    check('facts', 'tsql-hw: MS_Description (named + positional)', /contractors/.test(emp.comment) && emp.columns.find((c) => c.name === 'Salary').comment === 'Gross annual salary');
    check('facts', 'tsql-hw: unread = dynamic EXEC, ALTER on missing table, WAITFOR', unreadCount(m) === 3, m.log.filter((r) => r.status === 'unread').map((r) => r.line + ':' + r.snippet.slice(0, 30)).join(' | '));
    check('facts', 'tsql-hw: N\'…;…\' string did not split INSERT', m.log.filter((r) => r.kind === 'insert').length === 1);
    check('facts', 'tsql-hw: MERGE after SET (no semicolon) is its own statement', m.log.filter((r) => r.kind === 'merge').length === 1 && m.log.filter((r) => r.kind === 'set').every((r) => !/MERGE/i.test(r.text)));
    check('facts', 'tsql-hw: every statement accounted for (15)', m.log.length === 15, String(m.log.length));
  },
  'pg_handwritten.sql': (m) => {
    check('facts', 'pg-hw: dialect detected', m.dialect === 'postgres');
    check('facts', 'pg-hw: tables (partition child not invented)', JSON.stringify(m.tables.map((t) => t.name)) === JSON.stringify(['users', 'profiles', 'Teams', 'team_members', 'measurements']), m.tables.map((t) => t.name).join(','));
    check('facts', 'pg-hw: unquoted names fold to lower case', !!tbl(m, 'users').columns.find((c) => c.name === 'userid') && !!tbl(m, 'users').columns.find((c) => c.name === 'Email'));
    check('facts', 'pg-hw: FKs (REFERENCES without column list → PK)', JSON.stringify(allFks(m)) === JSON.stringify(['Teams(lead_user_id)->users(userid)', 'profiles(user_id)->users(userid)', 'team_members(team_id)->Teams(id)', 'team_members(user_id)->users(userid)']), allFks(m).join(' | '));
    const tm = tbl(m, 'team_members');
    check('facts', 'pg-hw: RENAME/DROP/ADD COLUMN applied', tm.columns.map((c) => c.name).join() === 'team_id,user_id,member_role,joined_on', tm.columns.map((c) => c.name).join());
    check('facts', 'pg-hw: SET NOT NULL applied', tbl(m, 'profiles').columns.find((c) => c.name === 'bio').nullable === false);
    check('facts', 'pg-hw: E-string with ; kept as one default', tbl(m, 'users').columns.find((c) => c.name === 'note').default === "E'it''s; fine\\n'");
    check('facts', 'pg-hw: expression unique index not turned into a key', tbl(m, 'users').uniques.length === 0);
    check('facts', 'pg-hw: unread = PARTITION OF + garbage', unreadCount(m) === 2, m.log.filter((r) => r.status === 'unread').map((r) => r.line).join(','));
    check('facts', 'pg-hw: COPY data + psql meta ignored', m.log.filter((r) => r.kind === 'copy-data').length === 1 && m.log.filter((r) => r.kind === 'psql').length === 2);
    const mm = E.toMermaid(m).text;
    check('facts', 'pg-hw: profiles is one-to-one with users', /users \|\|--o\| profiles/.test(mm), mm.split('\n').filter((l) => /profiles :/.test(l)).join(' '));
    check('facts', 'pg-hw: team_members FK in PK → identifying (solid) line', /Teams \|\|--o\{ team_members/.test(mm));
  },
  'inference.sql': (m) => {
    const g = E.guessRelationships(m).map((x) => `${x.from.table}.${x.columns[0]}->${x.refTable}`).sort();
    check('facts', 'inference: guessed set', JSON.stringify(g) === JSON.stringify([
      'categories.parent_id->categories', 'order_items.order_id->orders', 'order_items.product_id->products', 'orders.billing_customer_id->customers', 'orders.customer_id->customers',
      'products.category_id->categories', 'stock.product_id->products', 'stock.storecode->stores']), g.join(', '));
    const mm = E.toMermaid(m).text;
    check('facts', 'inference: guesses labelled and dotted', /customers \|\|\.\.o\{ orders : "guess: customer_id"/.test(mm), mm);
    check('facts', 'inference: guesses can be hidden', !/guess:/.test(E.toMermaid(m, { showGuesses: false }).text));
  },
};
for (const f of fixtures) {
  if (FACTS[f]) FACTS[f](models[f]);
  else check('facts', `${f}: has hand-written expectations`, false, 'Add an entry to FACTS in tests/run-tests.js');
}

// ───────────── [golden] snapshots ─────────────
fs.mkdirSync(EXP, { recursive: true });
for (const f of fixtures) {
  const base = f.replace(/\.sql$/, '');
  const m = models[f];
  const snapshot = {
    canonical: E.canonicalModel(m),
    summary: E.summarize(m),
    crossCheck: m.crossCheck,
    log: m.log.map((r) => ({ line: r.line, status: r.status, kind: r.kind, target: r.target, check: r.check ? r.check.status : null, warnings: r.notes.filter((n) => n.level === 'warning').map((n) => n.message) })),
    issues: m.issues,
  };
  const outputs = { [`${base}.model.json`]: JSON.stringify(snapshot, null, 2) + '\n', [`${base}.mmd`]: E.toMermaid(m).text };
  for (const [name, content] of Object.entries(outputs)) {
    const p = path.join(EXP, name);
    if (UPDATE || !fs.existsSync(p)) { fs.writeFileSync(p, content); continue; }
    const want = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    if (!check('golden', `${name} matches saved output`, want === content)) {
      const a = want.split('\n'), b = content.split('\n');
      const i = a.findIndex((l, k) => l !== b[k]);
      failures[failures.length - 1] += `\n      first difference at line ${i + 1}:\n        saved: ${a[i]}\n        now:   ${b[i]}`;
    }
  }
}

// ───────────── [roundtrip] SQL → model → DDL → model ─────────────
for (const f of fixtures) {
  const m = models[f];
  const ddl = E.toDDL(m, m.dialect);
  const m2 = E.parseSql(ddl, { dialect: m.dialect });
  const a = JSON.stringify(E.canonicalModel(m), null, 1), b = JSON.stringify(E.canonicalModel(m2), null, 1);
  if (!check('roundtrip', `${f}: model → ${m.dialect} DDL → model is identical`, a === b)) {
    const x = a.split('\n'), y = b.split('\n'); const i = x.findIndex((l, k) => l !== y[k]);
    failures[failures.length - 1] += `\n      first difference: ${x.slice(Math.max(0, i - 3), i + 1).join(' ').trim()}\n        vs ${y.slice(Math.max(0, i - 3), i + 1).join(' ').trim()}`;
  }
  check('roundtrip', `${f}: regenerated DDL reads with no warnings`, unreadCount(m2) === 0 && E.summarize(m2).warnings === m.issues.filter((i) => /not in the script/.test(i.message)).length, JSON.stringify(m2.log.filter((r) => r.notes.some((n) => n.level === 'warning')).map((r) => r.notes)));
}

// ───────────── [catalog] reader formats ─────────────
{
  const rows = [
    ['kind', 'table_schema', 'table_name', 'column_name', 'ordinal', 'data_type', 'is_nullable', 'constraint_name', 'ref_schema', 'ref_table', 'ref_column'],
    ['COLUMN', 'dbo', 'A', 'id', '1', 'int', 'NO', 'NULL', 'NULL', 'NULL', 'NULL'],
    ['FOREIGN KEY', 'dbo', 'B', 'a_id', '1', 'NULL', 'NULL', 'FK_B_A', 'dbo', 'A', 'id'],
  ];
  const tsv = rows.map((r) => r.join('\t')).join('\r\n');
  const csv = rows.map((r) => r.map((c) => (c === 'NULL' ? '' : `"${c}"`)).join(',')).join('\n');
  const psql = [' ' + rows[0].join(' | '), '-'.repeat(40) + '+' + '-'.repeat(10), ...rows.slice(1).map((r) => ' ' + r.map((c) => (c === 'NULL' ? '' : c)).join(' | ')), '(2 rows)'].join('\n');
  const box = ['+----+----+', '| ' + rows[0].join(' | ') + ' |', '+----+----+', ...rows.slice(1).map((r) => '| ' + r.join(' | ') + ' |'), '+----+----+', '2 rows in set (0.00 sec)'].join('\n');
  const noHeader = rows.slice(1).map((r) => r.join('\t')).join('\n');
  for (const [nm, txt] of Object.entries({ tsv, csv, psql, mysqlBox: box, tsvNoHeader: noHeader })) {
    const r = E.parseCatalogText(txt);
    check('catalog', `reads ${nm}`, r.rows.length === 2 && r.rows[1].ref_table === 'A' && r.rows[0].constraint_name === null && r.errors.length === 0, JSON.stringify(r));
  }
}

// ───────────── [overlay] manual edits ─────────────
{
  const sql = fs.readFileSync(path.join(FIX, 'mssql_ssms.sql'), 'utf8');
  const base = models['mssql_ssms.sql'];
  const ov = {
    version: 1,
    tables: [{ id: 't1', schema: 'sales', name: 'Returns', comment: '', columns: [{ id: 'c1', name: 'ReturnID', type: 'int', nullable: false, pk: true }, { id: 'c2', name: 'OrderID', type: 'bigint', nullable: false }] }],
    columns: [
      { id: 'm1', schema: 'dbo', table: 'Customers', column: { name: 'LoyaltyTier', type: 'varchar(10)', nullable: true } },
      { id: 'm2', schema: 'dbo', table: 'Customers', column: { name: 'Email', type: 'varchar(300)', nullable: true } },
      { id: 'm3', schema: 'dbo', table: 'Ghost', column: { name: 'X', type: 'int', nullable: true } },
      { id: 'm4', schema: 'sales', table: 'Orders', column: { name: 'Channel', type: 'varchar(20)', nullable: false, default: "'web'" } },
    ],
    relationships: [{ id: 'r1', schema: 'sales', table: 'Returns', columns: ['OrderID'], refSchema: 'sales', refTable: 'Orders', refColumns: ['OrderID'], name: 'FK_Returns_Orders' }],
  };
  const { model: merged, conflicts } = E.applyOverlay(base, ov);
  const kinds = conflicts.map((c) => c.id + ':' + c.kind).sort().join(',');
  check('overlay', 'conflicts flagged: existing column + orphan table', kinds === 'm2:column-exists,m3:orphan', kinds);
  check('overlay', 'manual column added', !!tbl(merged, 'Customers').columns.find((c) => c.name === 'LoyaltyTier' && c.source === 'manual'));
  check('overlay', 'manual table + relationship', !!tbl(merged, 'Returns') && tbl(merged, 'Returns').fks.length === 1);
  const mm = E.toMermaid(merged).text;
  check('overlay', 'diagram marks manual items', /varchar\(10\) LoyaltyTier "manual"/.test(mm) && /sales\.Returns \(manual\)/.test(mm) && /FK_Returns_Orders \(manual\)/.test(mm), mm);
  check('overlay', 'base model untouched', !tbl(base, 'Customers').columns.find((c) => c.name === 'LoyaltyTier'));
  // Re-import: the SQL now contains LoyaltyTier → becomes a conflict, overlay itself unchanged.
  const sql2 = sql + '\nALTER TABLE [dbo].[Customers] ADD [LoyaltyTier] [varchar](10) NULL\nGO\n';
  const re = E.applyOverlay(E.parseSql(sql2), ov);
  check('overlay', 're-import keeps overlay and flags new duplicate', re.conflicts.some((c) => c.id === 'm1' && c.kind === 'column-exists') && ov.columns.length === 4);
  // Exported migration, applied to the original SQL, reproduces the manual items.
  const mig = E.overlayToDDL(ov, merged, conflicts, 'tsql');
  check('overlay', 'migration skips conflicting items', /-- SKIPPED column Customers\.Email/.test(mig) && /-- SKIPPED column Ghost\.X/.test(mig));
  check('overlay', 'migration warns NOT NULL without default only where needed', !/Channel is NOT NULL with no DEFAULT/.test(mig) && /OrderID is NOT NULL/.test(mig) === false);
  const after = E.parseSql(sql + '\nGO\n' + mig);
  const want = E.canonicalModel(E.applyOverlay(base, Object.assign({}, ov, { columns: ov.columns.filter((c) => c.id === 'm1' || c.id === 'm4') })).model);
  const got = E.canonicalModel(after);
  // Manual table has no PK name / sources; compare structure only.
  const shape = (cm) => cm.tables.map((t) => `${t.schema}.${t.name}:${t.columns.map((c) => c.name + ' ' + lc(c.type) + (c.nullable ? '' : '!')).join(',')}|pk=${t.pk ? t.pk.columns : ''}|fk=${t.fks.map((f) => f.columns + '>' + f.refTable).sort()}`).join('\n');
  check('overlay', 'SQL + exported migration = merged diagram', shape(got) === shape(want), `got:\n${shape(got)}\nwant:\n${shape(want)}`);
}

// ───────────── [mermaid] + [database] need async ─────────────
(async () => {
  if (!SKIP_BROWSER) {
    const { openMermaid } = require('./lib/mermaid-browser.js');
    const mm = await openMermaid();
    try {
      for (const f of fixtures) {
        const m = models[f];
        const variants = {
          default: {}, keysOnly: { keysOnly: true }, LR: { direction: 'LR' }, noGuesses: { showGuesses: false },
          comments: { showComments: true, showNullable: true }, qualifiedAlways: { qualifiedNames: 'always' },
        };
        const first = m.tables[0];
        if (first) variants.focus = { focus: E.tkey(first.schema, first.name), depth: 1 };
        const { model: merged } = E.applyOverlay(m, { version: 1, tables: [{ id: 'x', schema: first ? first.schema : '', name: 'Manual "quoted" table', columns: [{ id: 'y', name: '1st col', type: "enum('a', 'b')", nullable: true }] }], columns: [], relationships: [] });
        for (const [vn, opts] of Object.entries(variants)) {
          const r = await mm.check(E.toMermaid(m, opts).text);
          check('mermaid', `${f} [${vn}] renders`, r.ok, r.error);
        }
        const r2 = await mm.check(E.toMermaid(merged).text);
        check('mermaid', `${f} [with awkward manual table] renders`, r2.ok, r2.error);
      }
    } finally { await mm.close(); }
  }

  // [database] PGlite = real PostgreSQL compiled to WASM
  const { PGlite } = await import('@electric-sql/pglite');
  const catalogRows = async (db) => (await db.query(E.CATALOG_QUERIES.postgres.replace(/^--.*\n/gm, ''))).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? null : String(v)])));
  // (a) the original pg_dump file, loaded as-is (with its owner role created)
  {
    const db = new PGlite();
    await db.exec('CREATE ROLE app;');
    await db.exec(fs.readFileSync(path.join(FIX, 'pg_dump.sql'), 'utf8'));
    const cmp = E.compareWithCatalog(models['pg_dump.sql'], await catalogRows(db));
    check('database', 'pg_dump.sql loaded into PostgreSQL: model matches catalog exactly', cmp.ok, JSON.stringify({ counts: cmp.counts.filter((c) => !c.ok), diffs: cmp.diffs }));
    await db.close();
  }
  // (b) every fixture: generated DDL loaded into PostgreSQL, catalog must match the model
  for (const f of fixtures) {
    const m = JSON.parse(JSON.stringify(models[f]));
    for (const t of m.tables) t.fks = t.fks.filter((x) => !x.unresolved); // cannot create FKs to tables that are not in the script
    const db = new PGlite();
    const ddl = E.toDDL(m, 'postgres', { portable: true });
    try {
      await db.exec(ddl);
      const cmp = E.compareWithCatalog(m, await catalogRows(db));
      check('database', `${f}: generated DDL accepted by PostgreSQL; counts and keys match`, cmp.ok, JSON.stringify({ counts: cmp.counts.filter((c) => !c.ok), diffs: cmp.diffs.slice(0, 5) }));
      if (f === 'mssql_ssms.sql') {
        const c = Object.fromEntries(cmp.counts.map((x) => [x.label, x.catalog]));
        check('database', 'mssql: catalog counts tables 5 / columns 23 / FKs 4 / FK columns 5', c.Tables === 5 && c.Columns === 23 && c['Foreign keys'] === 4 && c['FK columns'] === 5, JSON.stringify(c));
      }
    } catch (e) {
      check('database', `${f}: generated DDL accepted by PostgreSQL`, false, e.message + '\n' + ddl.slice(0, 400));
    }
    await db.close();
  }
  // (c) the comparison actually detects differences (negative control)
  {
    const db = new PGlite();
    await db.exec(E.toDDL(models['inference.sql'], 'postgres', { portable: true }) + 'ALTER TABLE orders ADD COLUMN extra text; ALTER TABLE orders ADD FOREIGN KEY (customer_id) REFERENCES customers(id);');
    const cmp = E.compareWithCatalog(models['inference.sql'], await catalogRows(db));
    check('database', 'negative control: extra column and FK in DB are reported', !cmp.ok && cmp.diffs.some((d) => /orders\.extra/.test(d.message)) && cmp.diffs.some((d) => /customer_id→customers/.test(d.message)), JSON.stringify(cmp.diffs));
    await db.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  const cc = Object.entries(models).map(([f, m]) => `  ${f.padEnd(24)} ${m.crossCheck.confirmed}/${m.crossCheck.checked} statements confirmed by node-sql-parser (${m.crossCheck.grammarFailed} it could not parse, ${m.crossCheck.misread} misread, ${m.crossCheck.disagreed} disagreements)`);
  console.log('Independent cross-check:\n' + cc.join('\n'));
  if (fail) { console.log('\nFailures:\n  ' + failures.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(2); });
