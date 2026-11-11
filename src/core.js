/*
 * SQL → ER model → Mermaid core.
 *
 * Pipeline:  text ──scan──▶ statements ──tokenize──▶ tokens ──DDL parser──▶ model
 *                                                   └─▶ node-sql-parser cross-check (independent second reading)
 *            model + overlay (manual edits) ──▶ merged model ──▶ Mermaid / DDL / catalog comparison
 *
 * Every statement produces a log record. Anything not turned into model facts is recorded there
 * (level "ignored" for known non-structural SQL, "warning" for things that may matter). Nothing is dropped silently.
 *
 * Runs unchanged in the browser (window.SqlErd) and in Node (module.exports) so the same code is tested.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SqlErd = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '1.0.0';

  const DIALECTS = {
    tsql: { label: 'SQL Server (T-SQL)', defaultSchema: 'dbo', nsp: 'transactsql' },
    postgres: { label: 'PostgreSQL', defaultSchema: 'public', nsp: 'postgresql' },
    mysql: { label: 'MySQL / MariaDB', defaultSchema: '', nsp: 'mysql' },
  };

  // ───────────────────────────── utilities ─────────────────────────────
  const lc = (s) => (s == null ? '' : String(s).toLowerCase());
  const tkey = (schema, name) => lc(schema) + '.' + lc(name);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uniqBy = (arr, f) => { const seen = new Set(); return arr.filter((x) => { const k = f(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  const sameCols = (a, b) => a.length === b.length && a.every((x, i) => lc(x) === lc(b[i]));
  const sameColSet = (a, b) => a.length === b.length && a.map(lc).sort().join('\u0000') === b.map(lc).sort().join('\u0000');

  function makeLineIndex(text) {
    const nl = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) nl.push(i + 1);
    return (off) => {
      let lo = 0, hi = nl.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (nl[mid] <= off) lo = mid; else hi = mid - 1; }
      return lo + 1;
    };
  }

  class ParseError extends Error {
    constructor(msg, tok) { super(msg + (tok ? ` near "${tok.raw}"` : ' at end of statement')); this.tok = tok; }
  }

  // ─────────────────────────── dialect detection ───────────────────────────
  function detectDialect(sql) {
    const s = sql.slice(0, 400000);
    const score = { tsql: 0, postgres: 0, mysql: 0 };
    const hit = (re, d, w) => { if (re.test(s)) score[d] += w; };
    hit(/^\s*GO\s*$/im, 'tsql', 4); hit(/\[[^\]\n]+\]\s*\.\s*\[/, 'tsql', 3); hit(/\bIDENTITY\s*\(/i, 'tsql', 2);
    hit(/\b(NON)?CLUSTERED\b/i, 'tsql', 2); hit(/SET\s+ANSI_NULLS/i, 'tsql', 3); hit(/\bN?VARCHAR\s*\(\s*MAX\s*\)|\[n?varchar\]/i, 'tsql', 2);
    hit(/\bNVARCHAR\b|\bNCHAR\b|\bDATETIME2\b|\bUNIQUEIDENTIFIER\b|\bMONEY\b/i, 'tsql', 1); hit(/\bsp_\w+|\bEXEC\b|\bsys\.\w+/i, 'tsql', 2); hit(/\bN'/, 'tsql', 1);
    hit(/\btimestamptz\b|\bjsonb\b|\bbytea\b|\bAS\s+ENUM\b|^\\(restrict|connect)\b/im, 'postgres', 2); hit(/\bE'|\$\$/, 'postgres', 1);
    hit(/::\s*[a-z]/i, 'postgres', 2); hit(/ALTER\s+TABLE\s+ONLY\b/i, 'postgres', 3); hit(/pg_catalog|pg_dump|PostgreSQL database dump/i, 'postgres', 4);
    hit(/\b(BIG|SMALL)?SERIAL\b/i, 'postgres', 2); hit(/character varying|timestamp with(out)? time zone/i, 'postgres', 2); hit(/OWNER TO/i, 'postgres', 2);
    hit(/`/, 'mysql', 3); hit(/\bENGINE\s*=/i, 'mysql', 4); hit(/\bAUTO_INCREMENT\b/i, 'mysql', 2); hit(/\/\*!\d/, 'mysql', 3); hit(/\bUNSIGNED\b/i, 'mysql', 1); hit(/MySQL dump|MariaDB dump/i, 'mysql', 4);
    const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
    const [best, second] = ranked;
    const confident = best[1] >= 3 && best[1] >= second[1] * 2;
    return { dialect: best[1] > 0 ? best[0] : 'postgres', scores: score, confident, guessed: best[1] === 0 };
  }

  // ───────────────────────────── statement scanner ─────────────────────────────
  // Splits a script into statements, respecting strings, quoted identifiers, comments,
  // T-SQL GO batches, PostgreSQL dollar quotes / psql meta-commands / COPY data, MySQL DELIMITER and /*! */.
  function scan(sql, dialect) {
    const T = dialect === 'tsql', P = dialect === 'postgres', M = dialect === 'mysql';
    const segs = [], issues = [];
    const n = sql.length;
    let i = 0, start = 0, lineStart = true, delim = ';', inCond = false;
    const lineAt = makeLineIndex(sql);
    const push = (end, extra) => { const text = sql.slice(start, end); if (/\S/.test(text)) segs.push(Object.assign({ offset: start, text }, extra || {})); };
    const eolFrom = (k) => { const e = sql.indexOf('\n', k); return e < 0 ? n : e; };
    const isIdChar = (ch) => !!ch && /[A-Za-z0-9_$\u0080-\uffff]/.test(ch);
    const skipQuoted = (q, backslash) => {
      let j = i + 1;
      while (j < n) {
        const ch = sql[j];
        if (backslash && ch === '\\') { j += 2; continue; }
        if (ch === q) { if (sql[j + 1] === q) { j += 2; continue; } return j + 1; }
        j++;
      }
      issues.push({ level: 'warning', line: lineAt(i), message: `Unterminated ${q} quote starting here; the rest of the script was read as one statement.` });
      return n;
    };
    while (i < n) {
      const c = sql[i];
      if (c === '\n') { lineStart = true; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\uFEFF') { i++; continue; }
      if (lineStart) {
        lineStart = false;
        const eol = eolFrom(i), line = sql.slice(i, eol).replace(/\r$/, '');
        if (T && /^GO(?:\s+\d+)?\s*(?:--.*)?$/i.test(line)) { push(i); i = eol; start = i; continue; }
        if (M && /^DELIMITER\s+\S+/i.test(line)) {
          push(i); segs.push({ offset: i, text: line, directive: 'delimiter' });
          delim = line.trim().split(/\s+/)[1]; i = eol; start = i; continue;
        }
        if (P && c === '\\') { push(i); segs.push({ offset: i, text: line, directive: 'psql' }); i = eol; start = i; continue; }
      }
      if (c === '-' && sql[i + 1] === '-') { i = eolFrom(i); continue; }
      if (M && c === '#') { i = eolFrom(i); continue; }
      if (c === '/' && sql[i + 1] === '*') {
        if (M && sql[i + 2] === '!') { i += 3; while (i < n && /[0-9]/.test(sql[i])) i++; inCond = true; continue; }
        let depth = 1, j = i + 2;
        while (j < n && depth) {
          if (sql[j] === '*' && sql[j + 1] === '/') { depth--; j += 2; }
          else if (P && sql[j] === '/' && sql[j + 1] === '*') { depth++; j += 2; }
          else j++;
        }
        if (depth) issues.push({ level: 'warning', line: lineAt(i), message: 'Unterminated /* comment.' });
        i = j; continue;
      }
      if (inCond && c === '*' && sql[i + 1] === '/') { inCond = false; i += 2; continue; }
      if (c === "'") { i = skipQuoted("'", M || (P && /[eE]/.test(sql[i - 1] || '') && !isIdChar(sql[i - 2]))); continue; }
      if (c === '"') { i = skipQuoted('"', M); continue; }
      if (c === '`') { i = skipQuoted('`', false); continue; }
      if (T && c === '[') { i = skipQuoted(']', false); continue; }
      if (P && c === '$' && !isIdChar(sql[i - 1])) {
        const m = /^\$([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/.exec(sql.slice(i, i + 80));
        if (m) {
          const e = sql.indexOf(m[0], i + m[0].length);
          if (e < 0) issues.push({ level: 'warning', line: lineAt(i), message: `Unterminated dollar quote ${m[0]}.` });
          i = e < 0 ? n : e + m[0].length; continue;
        }
      }
      // T-SQL: batches end at GO only; ';' is handled per batch by tsqlSubSplit so procedure bodies stay whole.
      if (!T && sql.startsWith(delim, i)) {
        const stmtText = sql.slice(start, i);
        push(i); i += delim.length; start = i;
        if (P && /^\s*(?:--[^\n]*\n\s*)*COPY\b[\s\S]*\bFROM\s+stdin\b/i.test(stmtText)) {
          const e = sql.indexOf('\n\\.', i);
          const stop = e < 0 ? n : eolFrom(e + 1);
          segs.push({ offset: i, text: sql.slice(i, stop), directive: 'copy-data' });
          i = stop; start = i;
        }
        continue;
      }
      i++;
    }
    push(n);
    return { segs, issues, lineAt };
  }

  // ───────────────────────────── tokenizer ─────────────────────────────
  const TWO_CHAR = new Set(['::', ':=', '<>', '<=', '>=', '!=', '||', '->', '=>']);
  function tokenize(text, base, dialect) {
    const T = dialect === 'tsql', P = dialect === 'postgres', M = dialect === 'mysql';
    const toks = [];
    const n = text.length;
    let i = 0, inCond = false;
    const isIdStart = (ch) => /[A-Za-z_\u00C0-\uFFFF]/.test(ch) || (T && ch === '#');
    const isIdChar = (ch) => !!ch && (/[A-Za-z0-9_$\u00C0-\uFFFF]/.test(ch) || (T && (ch === '#' || ch === '@')));
    const endQuoted = (from, q, backslash) => {
      let j = from + 1;
      while (j < n) {
        const ch = text[j];
        if (backslash && ch === '\\') { j += 2; continue; }
        if (ch === q) { if (text[j + 1] === q) { j += 2; continue; } return j + 1; }
        j++;
      }
      return n;
    };
    const unq = (raw, q) => raw.slice(1, raw.endsWith(q) ? -1 : undefined).split(q + q).join(q);
    while (i < n) {
      const c = text[i];
      if (/\s/.test(c) || c === '\uFEFF') { i++; continue; }
      if (c === '-' && text[i + 1] === '-') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
      if (M && c === '#') { const e = text.indexOf('\n', i); i = e < 0 ? n : e; continue; }
      if (c === '/' && text[i + 1] === '*') {
        if (M && text[i + 2] === '!') { i += 3; while (i < n && /[0-9]/.test(text[i])) i++; inCond = true; continue; }
        let depth = 1, j = i + 2;
        while (j < n && depth) {
          if (text[j] === '*' && text[j + 1] === '/') { depth--; j += 2; }
          else if (P && text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; }
          else j++;
        }
        i = j; continue;
      }
      if (inCond && c === '*' && text[i + 1] === '/') { inCond = false; i += 2; continue; }
      const pos = base + i;
      // prefixed strings: N'..' E'..' B'..' X'..'
      if (/[NnEeBbXx]/.test(c) && text[i + 1] === "'" && !isIdChar(text[i - 1])) {
        const bs = M || /[Ee]/.test(c);
        const e = endQuoted(i + 1, "'", bs);
        const raw = text.slice(i, e);
        toks.push({ type: 'str', value: unq(raw.slice(1), "'"), raw, pos }); i = e; continue;
      }
      if (c === "'") { const e = endQuoted(i, "'", M); const raw = text.slice(i, e); toks.push({ type: 'str', value: unq(raw, "'"), raw, pos }); i = e; continue; }
      if (c === '"') {
        const e = endQuoted(i, '"', M); const raw = text.slice(i, e);
        toks.push(M ? { type: 'str', value: unq(raw, '"'), raw, pos } : { type: 'qid', value: unq(raw, '"'), raw, pos }); i = e; continue;
      }
      if (c === '`') { const e = endQuoted(i, '`', false); const raw = text.slice(i, e); toks.push({ type: 'qid', value: unq(raw, '`'), raw, pos }); i = e; continue; }
      if (T && c === '[') {
        let j = i + 1;
        while (j < n) { if (text[j] === ']') { if (text[j + 1] === ']') { j += 2; continue; } j++; break; } j++; }
        const raw = text.slice(i, j); toks.push({ type: 'qid', value: raw.slice(1, raw.endsWith(']') ? -1 : undefined).split(']]').join(']'), raw, pos }); i = j; continue;
      }
      if (P && c === '$' && !isIdChar(text[i - 1])) {
        const m = /^\$([A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/.exec(text.slice(i, i + 80));
        if (m) { const e = text.indexOf(m[0], i + m[0].length); const end = e < 0 ? n : e + m[0].length; const raw = text.slice(i, end); toks.push({ type: 'str', value: raw.slice(m[0].length, raw.length - m[0].length), raw, pos }); i = end; continue; }
        const pm = /^\$\d+/.exec(text.slice(i, i + 12));
        if (pm) { toks.push({ type: 'param', value: pm[0], raw: pm[0], pos }); i += pm[0].length; continue; }
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
        const m = /^(?:0x[0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 64));
        toks.push({ type: 'num', value: m[0], raw: m[0], pos }); i += m[0].length; continue;
      }
      if (c === '@' && (T || M)) {
        const m = /^@@?[A-Za-z0-9_$#@.\u00C0-\uFFFF]*/.exec(text.slice(i, i + 256));
        toks.push({ type: 'var', value: m[0], raw: m[0], pos }); i += m[0].length; continue;
      }
      if (isIdStart(c)) {
        let j = i + 1; while (j < n && isIdChar(text[j])) j++;
        const raw = text.slice(i, j); toks.push({ type: 'word', value: raw, up: raw.toUpperCase(), raw, pos }); i = j; continue;
      }
      const two = text.substr(i, 2);
      if (TWO_CHAR.has(two)) { toks.push({ type: 'punct', value: two, raw: two, pos }); i += 2; continue; }
      toks.push({ type: 'punct', value: c, raw: c, pos }); i++;
    }
    return toks;
  }

  const isIdentTok = (t) => !!t && (t.type === 'word' || t.type === 'qid');

  // Joins tokens back into canonical SQL text. Re-tokenizing the output yields the same tokens,
  // so the representation is stable across round trips.
  function smartJoin(toks, compactCommas) {
    let s = '', prev = null, prev2 = null;
    for (const t of toks) {
      if (prev) {
        const P = (x, vals) => x && x.type === 'punct' && vals.includes(x.value);
        let space = true;
        if (P(t, [')', ',', '.', '::', '[', ']'])) space = false;
        else if (P(prev, ['(', '.', '::', '['])) space = false;
        else if (P(t, ['(']) && isIdentTok(prev)) space = false;
        else if (P(prev, ['-', '+']) && (!prev2 || (prev2.type === 'punct' && !P(prev2, [')', ']'])) || (prev2.type === 'word' && /^(DEFAULT|AND|OR|NOT|WHEN|THEN|ELSE|IS)$/.test(prev2.up)))) space = false;
        else if (compactCommas && P(prev, [','])) space = false;
        if (space) s += ' ';
      }
      s += t.raw;
      prev2 = prev; prev = t;
    }
    return s;
  }
  // Same as smartJoin but quoted identifiers lose their quotes (used for type names such as [nvarchar](max)).
  const typeJoin = (toks) => smartJoin(toks.map((t) => (t.type === 'qid' ? Object.assign({}, t, { raw: t.value }) : t)), true);

  // ───────────────────────────── token stream ─────────────────────────────
  class TS {
    constructor(toks) { this.t = toks; this.i = 0; }
    peek(k = 0) { return this.t[this.i + k]; }
    eof() { return this.i >= this.t.length; }
    next() { const r = this.t[this.i]; this.i++; return r; }
    isWord(w, k = 0) { const t = this.t[this.i + k]; return !!t && t.type === 'word' && (Array.isArray(w) ? w.includes(t.up) : t.up === w); }
    isWords(...ws) { return ws.every((w, k) => this.isWord(w, k)); }
    isPunct(p, k = 0) { const t = this.t[this.i + k]; return !!t && t.type === 'punct' && t.value === p; }
    accept(...ws) { if (this.isWords(...ws)) { this.i += ws.length; return true; } return false; }
    acceptAny(...ws) { return this.isWord(ws) ? this.next() : null; }
    expectPunct(p) { if (!this.isPunct(p)) throw new ParseError(`expected "${p}"`, this.peek()); this.i++; }
    expectWord(w) { if (!this.isWord(w)) throw new ParseError(`expected ${w}`, this.peek()); return this.next(); }
    ident() { const t = this.peek(); if (!isIdentTok(t)) throw new ParseError('expected a name', t); this.i++; return t; }
    skipGroupOrToken() {
      const s = this.i;
      if (this.isPunct('(')) {
        let d = 0;
        while (!this.eof()) { const t = this.next(); if (t.type === 'punct' && t.value === '(') d++; else if (t.type === 'punct' && t.value === ')') { d--; if (d === 0) break; } }
      } else this.i++;
      return this.t.slice(s, this.i);
    }
    // Consume up to (not including) a ',' or ')' at depth 0.
    skipUntilListEnd() {
      const s = this.i; let d = 0;
      while (!this.eof()) {
        const t = this.peek();
        if (t.type === 'punct') {
          if (t.value === '(') d++;
          else if (t.value === ')') { if (d === 0) break; d--; }
          else if (t.value === ',' && d === 0) break;
        }
        this.i++;
      }
      return this.t.slice(s, this.i);
    }
    rest() { const r = this.t.slice(this.i); this.i = this.t.length; return r; }
  }

  // name, schema.name or db.schema.name → {db, schema, name}
  function identVal(t, dialect) {
    if (t.type === 'qid') return t.value;
    return dialect === 'postgres' ? t.value.toLowerCase() : t.value;
  }
  function qualifiedName(ts, dialect) {
    const parts = [identVal(ts.ident(), dialect)];
    while (ts.isPunct('.') && isIdentTok(ts.peek(1))) { ts.next(); parts.push(identVal(ts.next(), dialect)); }
    // T-SQL allows server.db..table — collapse empty parts
    if (ts.isPunct('.') && ts.isPunct('.', 1)) { ts.next(); ts.next(); parts.push('', identVal(ts.ident(), dialect)); }
    const name = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
    const db = parts.length >= 3 ? parts[parts.length - 3] : null;
    return { db, schema, name, parts };
  }

  // ───────────────────────────── DDL parser ─────────────────────────────
  const COLUMN_STOP = new Set(['NOT', 'NULL', 'CONSTRAINT', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'CHECK', 'COLLATE', 'IDENTITY', 'GENERATED',
    'AUTO_INCREMENT', 'AUTOINCREMENT', 'COMMENT', 'ON', 'ROWGUIDCOL', 'SPARSE', 'FOR', 'WITH', 'PERSISTED', 'MASKED', 'ENCRYPTED', 'DEFAULT', 'FOREIGN', 'VISIBLE', 'INVISIBLE', 'STORAGE', 'COLUMN_FORMAT', 'SRID']);
  const TSQL_SET_OPTIONS = new Set(['ANSI_NULLS', 'QUOTED_IDENTIFIER', 'NOCOUNT', 'ANSI_PADDING', 'ANSI_WARNINGS', 'ARITHABORT', 'CONCAT_NULL_YIELDS_NULL',
    'NUMERIC_ROUNDABORT', 'XACT_ABORT', 'IDENTITY_INSERT', 'TRANSACTION', 'STATISTICS', 'DATEFORMAT', 'LANGUAGE', 'IMPLICIT_TRANSACTIONS', 'LOCK_TIMEOUT',
    'DEADLOCK_PRIORITY', 'ROWCOUNT', 'TEXTSIZE', 'NOEXEC', 'PARSEONLY', 'FMTONLY', 'CONTEXT_INFO', 'ANSI_NULL_DFLT_ON', 'ANSI_NULL_DFLT_OFF', 'CURSOR_CLOSE_ON_COMMIT', 'DATEFIRST']);

  // Splits one GO batch into statements (T-SQL does not require semicolons).
  function tsqlSubSplit(toks) {
    if (!toks.length) return [];
    const u = (k) => (toks[k] && toks[k].type === 'word' ? toks[k].up : '');
    let k0 = 1; if (u(1) === 'OR' && u(2) === 'ALTER') k0 = 3;
    if ((u(0) === 'CREATE' || u(0) === 'ALTER') && /^(PROC|PROCEDURE|FUNCTION|TRIGGER|VIEW)$/.test(u(k0))) return [toks];
    const parts = []; let cur = [], depth = 0, inBeginEnd = 0;
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.type === 'punct' && t.value === '(') depth++;
      else if (t.type === 'punct' && t.value === ')') depth--;
      if (t.type === 'word' && t.up === 'BEGIN' && u(k + 1) !== 'TRAN' && u(k + 1) !== 'TRANSACTION') inBeginEnd++;
      if (t.type === 'word' && t.up === 'END' && inBeginEnd) inBeginEnd--;
      if (t.type === 'punct' && t.value === ';' && depth === 0 && !inBeginEnd) { if (cur.length) parts.push(cur); cur = []; continue; }
      let starts = false;
      if (depth === 0 && !inBeginEnd && cur.length && t.type === 'word') {
        const nx = u(k + 1), pv = toks[k - 1];
        switch (t.up) {
          case 'CREATE': starts = true; break;
          case 'ALTER': starts = /^(TABLE|SCHEMA|INDEX|DATABASE|VIEW|PROC|PROCEDURE|FUNCTION|TRIGGER|AUTHORIZATION)$/.test(nx); break;
          case 'DROP': starts = /^(TABLE|INDEX|VIEW|PROC|PROCEDURE|FUNCTION|SCHEMA|TRIGGER|SYNONYM|TYPE|SEQUENCE)$/.test(nx) && !(pv && pv.type === 'word' && pv.up === 'ON'); break;
          case 'SET': starts = TSQL_SET_OPTIONS.has(nx) || (toks[k + 1] && toks[k + 1].type === 'var'); break;
          case 'USE': case 'PRINT': case 'EXEC': case 'EXECUTE': case 'GRANT': case 'DENY': case 'REVOKE': case 'DECLARE': case 'TRUNCATE': case 'INSERT':
          case 'MERGE': case 'WAITFOR': case 'COMMIT': case 'ROLLBACK': case 'RAISERROR': case 'THROW': case 'CHECKPOINT': case 'DBCC': starts = true; break;
          case 'UPDATE': case 'DELETE': starts = !(pv && pv.type === 'word' && /^(ON|FOR|AFTER|OF|THEN|INSTEAD|NOT|,)$/.test(pv.up)) && !(pv && pv.type === 'punct' && pv.value === ','); break;
          case 'BEGIN': starts = /^(TRAN|TRANSACTION|DISTRIBUTED)$/.test(nx); break;
          case 'IF': starts = true; break;
          default: starts = false;
        }
      }
      if (starts) { parts.push(cur); cur = []; }
      cur.push(t);
    }
    if (cur.length) parts.push(cur);
    return parts;
  }

  const IGNORED_FIRST = {
    SET: 'session setting', USE: 'database selection', PRINT: 'print', DECLARE: 'variable declaration', BEGIN: 'transaction control', COMMIT: 'transaction control',
    ROLLBACK: 'transaction control', START: 'transaction control', LOCK: 'table locking', UNLOCK: 'table locking', GRANT: 'permissions', REVOKE: 'permissions', DENY: 'permissions',
    INSERT: 'data (INSERT)', UPDATE: 'data (UPDATE)', DELETE: 'data (DELETE)', SELECT: 'query / function call', TRUNCATE: 'data (TRUNCATE)', COPY: 'data (COPY)', MERGE: 'data (MERGE)',
    ANALYZE: 'maintenance', VACUUM: 'maintenance', REINDEX: 'maintenance', CHECKPOINT: 'maintenance', IF: 'control flow (IF)', WHILE: 'control flow',
    RAISERROR: 'messages', THROW: 'messages', RETURN: 'control flow', CALL: 'procedure call', DO: 'anonymous code block', REFRESH: 'materialized view refresh', CLUSTER: 'maintenance', OPTIMIZE: 'maintenance', FLUSH: 'maintenance', RESET: 'session setting', DISCARD: 'session setting', SECURITY: 'security label',
  };
  const IGNORED_OBJECTS = /^(SEQUENCE|FUNCTION|PROCEDURE|PROC|TRIGGER|VIEW|MATERIALIZED|TYPE|EXTENSION|DOMAIN|ROLE|USER|LOGIN|DATABASE|COLLATION|AGGREGATE|OPERATOR|POLICY|PUBLICATION|SUBSCRIPTION|RULE|EVENT|STATISTICS|SYNONYM|FULLTEXT|CAST|CONVERSION|LANGUAGE|SERVER|FOREIGN|TEXT|ACCESS|DEFAULT|PARTITION|ASSEMBLY|CERTIFICATE|MASTER|SYMMETRIC|ASYMMETRIC|CREDENTIAL|XML|SEARCH|TABLESPACE|TRANSFORM|LOGFILE|SPATIAL|QUEUE|SERVICE|CONTRACT|MESSAGE|ROUTE|ENDPOINT|BROKER|RESOURCE|WORKLOAD|APPLICATION|AVAILABILITY|EXTERNAL|SECURITY|OR)$/;

  function parseSql(sql, options) {
    options = options || {};
    const detected = detectDialect(sql);
    const dialect = options.dialect && options.dialect !== 'auto' ? options.dialect : detected.dialect;
    const D = DIALECTS[dialect];
    const model = { version: 1, dialect, schemas: [], tables: [], log: [], issues: [], detected };
    const byKey = new Map();
    const { segs, issues, lineAt } = scan(sql, dialect);
    for (const is of issues) model.issues.push(is);

    // Build statement list
    const stmts = [];
    for (const seg of segs) {
      if (seg.directive) { stmts.push({ directive: seg.directive, text: seg.text, line: lineAt(seg.offset), tokens: [] }); continue; }
      const toks = tokenize(seg.text, seg.offset, dialect);
      if (!toks.length) continue;
      const groups = dialect === 'tsql' ? tsqlSubSplit(toks) : [toks];
      for (const g of groups) {
        if (!g.length) continue;
        const startPos = g[0].pos - seg.offset;
        const endTok = g[g.length - 1];
        const endPos = endTok.pos - seg.offset + endTok.raw.length;
        stmts.push({ tokens: g, line: lineAt(g[0].pos), text: seg.text.slice(startPos, endPos) });
      }
    }

    const defSchema = D.defaultSchema;
    const schemaOf = (qn) => (qn.schema != null && qn.schema !== '' ? qn.schema : defSchema);
    const findTable = (schema, name) => byKey.get(tkey(schema, name));
    const findColumn = (table, name) => table.columns.find((c) => lc(c.name) === lc(name));

    // ── column definition ──
    function parseType(ts) {
      const start = ts.i;
      const first = ts.ident();
      let name = first.type === 'qid' ? first.value : first.value;
      while (ts.isPunct('.') && isIdentTok(ts.peek(1))) { ts.next(); const p = ts.next(); name += '.' + (p.type === 'qid' ? p.value : p.value); }
      const low = name.toLowerCase();
      const words = [name];
      if (/^(character|char|nchar|bit|national)$/.test(low)) {
        if (low === 'national' && ts.isWord(['CHARACTER', 'CHAR'])) words.push(ts.next().value);
        if (ts.isWord('VARYING')) words.push(ts.next().value);
      }
      if (low === 'double' && ts.isWord('PRECISION')) words.push(ts.next().value);
      if (low === 'long' && ts.isWord(['VARCHAR', 'VARBINARY', 'RAW'])) words.push(ts.next().value);
      let out = words.join(' ');
      if (ts.isPunct('(')) out += typeJoin(ts.skipGroupOrToken());
      if (/^(timestamp|time)$/.test(low) && (ts.isWords('WITH', 'TIME', 'ZONE') || ts.isWords('WITHOUT', 'TIME', 'ZONE'))) { out += ' ' + [ts.next(), ts.next(), ts.next()].map((t) => t.value).join(' '); }
      if (low === 'interval') { while (ts.isWord(['YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'TO'])) out += ' ' + ts.next().value; if (ts.isPunct('(')) out += typeJoin(ts.skipGroupOrToken()); }
      while (ts.isWord(['UNSIGNED', 'SIGNED', 'ZEROFILL'])) out += ' ' + ts.next().value;
      while (ts.isPunct('[')) { const s = ts.i; ts.next(); while (!ts.eof() && !ts.isPunct(']')) ts.next(); ts.next(); out += typeJoin(ts.t.slice(s, ts.i)); }
      if (ts.isWord('ARRAY')) { out += ' ' + ts.next().value; while (ts.isPunct('[')) { const s = ts.i; ts.next(); while (!ts.eof() && !ts.isPunct(']')) ts.next(); ts.next(); out += typeJoin(ts.t.slice(s, ts.i)); } }
      if (ts.i === start) throw new ParseError('expected a data type', ts.peek());
      return out;
    }

    function takeExpr(ts) {
      // DEFAULT expression: at least one token/group, then continue until a column-constraint keyword, ',' or ')' at depth 0.
      const out = [];
      out.push(...ts.skipGroupOrToken());
      while (!ts.eof()) {
        if (ts.isPunct(',') || ts.isPunct(')')) break;
        const t = ts.peek();
        if (t.type === 'word' && COLUMN_STOP.has(t.up)) {
          if (t.up === 'NULL' && out.length && out[out.length - 1].type === 'word' && out[out.length - 1].up === 'IS') { /* IS NULL */ }
          else break;
        }
        if (t.type === 'word' && t.up === 'CHARACTER' && ts.isWord('SET', 1)) break;
        out.push(...ts.skipGroupOrToken());
      }
      return smartJoin(out);
    }

    function parseReferences(ts, rec) {
      ts.expectWord('REFERENCES');
      const qn = qualifiedName(ts, dialect);
      const fk = { name: null, columns: [], refSchema: qn.schema, refTable: qn.name, refColumns: [], onDelete: null, onUpdate: null, disabled: false, trusted: true, line: rec.line };
      if (ts.isPunct('(')) fk.refColumns = parseIdentList(ts, rec).map((x) => x.name);
      for (;;) {
        if (ts.isWords('ON', 'DELETE') || ts.isWords('ON', 'UPDATE')) {
          ts.next(); const which = ts.next().up;
          let act;
          if (ts.isWords('SET', 'NULL') || ts.isWords('SET', 'DEFAULT') || ts.isWords('NO', 'ACTION')) act = ts.next().value + ' ' + ts.next().value;
          else act = ts.next().value;
          act = act.toUpperCase();
          if (which === 'DELETE') fk.onDelete = act; else fk.onUpdate = act;
          continue;
        }
        if (ts.isWord('MATCH')) { ts.next(); ts.next(); continue; }
        if (ts.isWords('NOT', 'FOR', 'REPLICATION')) { ts.next(); ts.next(); ts.next(); note(rec, 'ignored', 'NOT FOR REPLICATION'); continue; }
        if (ts.isWords('NOT', 'DEFERRABLE') || ts.isWord('DEFERRABLE')) { ts.accept('NOT'); ts.next(); continue; }
        if (ts.isWord('INITIALLY')) { ts.next(); ts.next(); continue; }
        if (ts.isWords('NOT', 'VALID')) { ts.next(); ts.next(); fk.trusted = false; continue; }
        if (ts.isWords('NOT', 'ENFORCED') || ts.isWord('ENFORCED')) { if (ts.accept('NOT')) fk.disabled = true; ts.next(); continue; }
        break;
      }
      return fk;
    }

    function parseIdentList(ts, rec) {
      ts.expectPunct('(');
      const items = [];
      while (!ts.eof() && !ts.isPunct(')')) {
        const t = ts.peek();
        if (isIdentTok(t) && (ts.isPunct(',', 1) || ts.isPunct(')', 1) || ts.isWord(['ASC', 'DESC', 'COLLATE', 'NULLS'], 1) || (ts.peek(1) && ts.peek(1).type === 'word' && dialect === 'postgres') || (ts.isPunct('(', 1) && dialect === 'mysql'))) {
          ts.next();
          items.push({ name: identVal(t, dialect) });
          const tail = ts.skipUntilListEnd();
          if (tail.length && !(tail.length === 1 && tail[0].type === 'word' && /^(ASC|DESC)$/.test(tail[0].up))) {
            const txt = smartJoin(tail);
            if (!/^(ASC|DESC)?$/i.test(txt)) note(rec, 'ignored', `Key column option "${txt}" on ${identVal(t, dialect)}`);
          }
        } else {
          const ex = ts.skipUntilListEnd();
          items.push({ name: smartJoin(ex), expr: true });
        }
        if (ts.isPunct(',')) ts.next();
      }
      ts.expectPunct(')');
      return items;
    }

    function note(rec, level, message) { rec.notes.push({ level, message }); }

    function parseColumnDef(ts, rec) {
      const nameTok = ts.ident();
      const col = { name: identVal(nameTok, dialect), type: '', nullable: true, default: null, identity: false, computed: false, comment: '' };
      const inline = { pk: null, unique: null, fk: null };
      if (ts.isWord('AS') && dialect === 'tsql') { ts.next(); col.computed = true; col.type = 'computed'; col.computedExpr = smartJoin(ts.skipGroupOrToken()); }
      else col.type = parseType(ts);
      if (dialect === 'mysql' && ts.isWord(['AS'])) { ts.next(); col.computed = true; col.computedExpr = smartJoin(ts.skipGroupOrToken()); ts.acceptAny('STORED', 'VIRTUAL'); }
      let cname = null;
      while (!ts.eof() && !ts.isPunct(',') && !ts.isPunct(')')) {
        if (ts.isWord('CONSTRAINT')) { ts.next(); cname = identVal(ts.ident(), dialect); continue; }
        if (ts.isWords('NOT', 'NULL')) { ts.next(); ts.next(); col.nullable = false; cname = null; continue; }
        if (ts.isWord('NULL')) { ts.next(); col.nullable = true; cname = null; continue; }
        if (ts.isWord('DEFAULT')) { ts.next(); col.default = takeExpr(ts); if (cname) col.defaultName = cname; cname = null; continue; }
        if (ts.isWords('PRIMARY', 'KEY')) { ts.next(); ts.next(); ts.acceptAny('CLUSTERED', 'NONCLUSTERED'); ts.acceptAny('ASC', 'DESC'); inline.pk = { name: cname }; cname = null; skipIndexOptions(ts, rec); continue; }
        if (ts.isWord('UNIQUE')) { ts.next(); ts.acceptAny('KEY'); ts.acceptAny('CLUSTERED', 'NONCLUSTERED'); inline.unique = { name: cname }; cname = null; skipIndexOptions(ts, rec); continue; }
        if (ts.isWords('FOREIGN', 'KEY')) { ts.next(); ts.next(); continue; }
        if (ts.isWord('REFERENCES')) { inline.fk = parseReferences(ts, rec); inline.fk.name = cname; cname = null; continue; }
        if (ts.isWord('CHECK')) { ts.next(); ts.accept('NOT', 'FOR', 'REPLICATION'); const e = smartJoin(ts.skipGroupOrToken()); note(rec, 'ignored', `CHECK on ${col.name}: ${e}`); cname = null; continue; }
        if (ts.isWord('IDENTITY')) { ts.next(); if (ts.isPunct('(')) col.identitySpec = typeJoin(ts.skipGroupOrToken()); col.identity = true; ts.accept('NOT', 'FOR', 'REPLICATION'); continue; }
        if (ts.isWord(['AUTO_INCREMENT', 'AUTOINCREMENT'])) { ts.next(); col.identity = true; continue; }
        if (ts.isWord('GENERATED')) {
          ts.next();
          if (!ts.accept('ALWAYS')) ts.accept('BY', 'DEFAULT');
          ts.accept('ON', 'NULL');
          ts.expectWord('AS');
          if (ts.isWord('IDENTITY')) { ts.next(); col.identity = true; if (ts.isPunct('(')) ts.skipGroupOrToken(); }
          else { col.computed = true; col.computedExpr = smartJoin(ts.skipGroupOrToken()); ts.acceptAny('STORED', 'VIRTUAL'); }
          continue;
        }
        if (ts.isWord(['STORED', 'VIRTUAL', 'PERSISTED'])) { ts.next(); continue; }
        if (ts.isWord('COLLATE')) { ts.next(); ts.next(); continue; }
        if (ts.isWord('COMMENT') && ts.peek(1) && ts.peek(1).type === 'str') { ts.next(); col.comment = ts.next().value; continue; }
        if (ts.isWords('ON', 'UPDATE')) { ts.next(); ts.next(); const e = takeExpr(ts); note(rec, 'ignored', `ON UPDATE ${e} on ${col.name}`); continue; }
        if (ts.isWords('CHARACTER', 'SET')) { ts.next(); ts.next(); ts.next(); continue; }
        if (ts.isWord('CHARSET')) { ts.next(); ts.next(); continue; }
        if (ts.isWord(['ROWGUIDCOL', 'SPARSE', 'FILESTREAM', 'VISIBLE', 'INVISIBLE'])) { note(rec, 'ignored', `${ts.next().value} on ${col.name}`); continue; }
        if (ts.isWords('NOT', 'FOR', 'REPLICATION')) { ts.next(); ts.next(); ts.next(); continue; }
        if (ts.isWord(['MASKED', 'ENCRYPTED'])) { const w = ts.next().value; ts.accept('WITH'); ts.skipGroupOrToken(); note(rec, 'ignored', `${w} WITH (...) on ${col.name}`); continue; }
        if (ts.isWord(['STORAGE', 'COLUMN_FORMAT', 'SRID'])) { const w = ts.next().value; ts.next(); note(rec, 'ignored', `${w} on ${col.name}`); continue; }
        if (ts.isWord('WITH') && ts.isPunct('(', 1)) { ts.next(); ts.skipGroupOrToken(); continue; }
        const skipped = smartJoin(ts.skipGroupOrToken());
        note(rec, 'warning', `Skipped unrecognised clause on column ${col.name}: ${skipped}`);
      }
      return { col, inline };
    }

    function skipIndexOptions(ts, rec) {
      const s = ts.i;
      for (;;) {
        if (ts.isWord('WITH') && ts.isPunct('(', 1)) { ts.next(); ts.skipGroupOrToken(); continue; }
        if (ts.isWord('ON') && (isIdentTok(ts.peek(1))) && !ts.isWord(['DELETE', 'UPDATE'], 1)) { ts.next(); ts.next(); if (ts.isPunct('(')) ts.skipGroupOrToken(); continue; }
        if (ts.isWords('USING', 'INDEX')) { ts.next(); ts.next(); if (ts.accept('TABLESPACE')) ts.next(); continue; }
        if (ts.isWord('USING') && isIdentTok(ts.peek(1))) { ts.next(); ts.next(); continue; }
        if (ts.isWord('INCLUDE') && ts.isPunct('(', 1)) { ts.next(); ts.skipGroupOrToken(); continue; }
        if (ts.isWord(['KEY_BLOCK_SIZE']) ) { ts.next(); if (ts.isPunct('=')) ts.next(); ts.next(); continue; }
        if (ts.isWords('NULLS', 'NOT', 'DISTINCT')) { ts.next(); ts.next(); ts.next(); continue; }
        if (ts.isWords('NULLS', 'DISTINCT')) { ts.next(); ts.next(); continue; }
        if (ts.isWords('NOT', 'DEFERRABLE') || ts.isWord('DEFERRABLE')) { ts.accept('NOT'); ts.next(); continue; }
        if (ts.isWord('INITIALLY')) { ts.next(); ts.next(); continue; }
        if (ts.isWord(['COMMENT']) && ts.peek(1) && ts.peek(1).type === 'str') { ts.next(); ts.next(); continue; }
        break;
      }
      if (ts.i > s) note(rec, 'ignored', `Index/storage options: ${smartJoin(ts.t.slice(s, ts.i))}`);
    }

    function isTableConstraintStart(ts) {
      if (ts.isWord(['CONSTRAINT', 'FOREIGN', 'CHECK', 'EXCLUDE', 'FULLTEXT', 'SPATIAL', 'PERIOD', 'LIKE'])) return true;
      if (ts.isWords('PRIMARY', 'KEY')) return true;
      if (ts.isWord('UNIQUE')) return true;
      if (ts.isWord(['KEY', 'INDEX']) && (isIdentTok(ts.peek(1)) || ts.isPunct('(', 1))) return true;
      return false;
    }

    // Returns {kind, ...} describing the constraint. Applies nothing itself.
    function parseTableConstraint(ts, rec) {
      let name = null;
      if (ts.isWord('CONSTRAINT')) { ts.next(); if (isIdentTok(ts.peek()) && !ts.isWord(['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'DEFAULT', 'EXCLUDE'])) name = identVal(ts.next(), dialect); }
      if (ts.isWords('PRIMARY', 'KEY')) {
        ts.next(); ts.next(); ts.acceptAny('CLUSTERED', 'NONCLUSTERED');
        if (ts.isWord('USING')) { ts.next(); ts.next(); }
        const cols = parseIdentList(ts, rec); skipIndexOptions(ts, rec);
        return { kind: 'pk', name, columns: cols.map((c) => c.name), exprs: cols.filter((c) => c.expr) };
      }
      if (ts.isWord('UNIQUE')) {
        ts.next(); ts.acceptAny('KEY', 'INDEX'); ts.acceptAny('CLUSTERED', 'NONCLUSTERED');
        if (isIdentTok(ts.peek()) && !ts.isWord('USING') && ts.isPunct('(', 1)) name = identVal(ts.next(), dialect);
        else if (isIdentTok(ts.peek()) && !ts.isWord(['USING', 'NULLS'])) name = identVal(ts.next(), dialect);
        if (ts.isWord('USING')) { ts.next(); ts.next(); }
        if (ts.isWords('NULLS', 'NOT', 'DISTINCT')) { ts.next(); ts.next(); ts.next(); }
        const cols = parseIdentList(ts, rec); skipIndexOptions(ts, rec);
        return { kind: 'unique', name, columns: cols.map((c) => c.name), exprs: cols.filter((c) => c.expr) };
      }
      if (ts.isWords('FOREIGN', 'KEY')) {
        ts.next(); ts.next();
        if (isIdentTok(ts.peek()) && !ts.isPunct('(')) { const nm = identVal(ts.next(), dialect); name = name || nm; }
        const cols = parseIdentList(ts, rec).map((c) => c.name);
        const fk = parseReferences(ts, rec);
        fk.name = name; fk.columns = cols;
        return { kind: 'fk', fk };
      }
      if (ts.isWord('CHECK')) { ts.next(); ts.accept('NOT', 'FOR', 'REPLICATION'); const e = smartJoin(ts.skipGroupOrToken()); if (ts.isWords('NOT', 'VALID')) { ts.next(); ts.next(); } return { kind: 'check', name, text: e }; }
      if (ts.isWord('DEFAULT') && dialect === 'tsql') { ts.next(); const e = takeExpr(ts); ts.expectWord('FOR'); const col = identVal(ts.ident(), dialect); return { kind: 'default', name, expr: e, column: col }; }
      if (ts.isWord('EXCLUDE')) { const e = smartJoin(ts.skipUntilListEnd()); return { kind: 'other', name, text: e, what: 'EXCLUDE constraint' }; }
      if (ts.isWord(['KEY', 'INDEX', 'FULLTEXT', 'SPATIAL'])) {
        const e = smartJoin(ts.skipUntilListEnd());
        return { kind: 'index', name, text: e };
      }
      if (ts.isWord('PERIOD')) { const e = smartJoin(ts.skipUntilListEnd()); return { kind: 'other', name, text: e, what: 'PERIOD FOR SYSTEM_TIME' }; }
      if (ts.isWord('LIKE')) { const e = smartJoin(ts.skipUntilListEnd()); return { kind: 'other', name, text: e, what: 'LIKE (copies another table\'s columns — not expanded)', level: 'warning' }; }
      throw new ParseError('unrecognised constraint', ts.peek());
    }

    function applyConstraint(table, c, rec, source) {
      if (c.kind === 'pk') {
        if (c.exprs && c.exprs.length) note(rec, 'warning', `Primary key on expression(s) not modelled: ${c.exprs.map((e) => e.name).join(', ')}`);
        if (table.pk) note(rec, 'warning', `Table ${table.name} already had a primary key (${table.pk.columns.join(', ')}); replaced by (${c.columns.join(', ')}).`);
        table.pk = { name: c.name, columns: c.columns };
        rec.facts.pk = c.columns;
      } else if (c.kind === 'unique') {
        if (c.exprs && c.exprs.length) { note(rec, 'warning', `Unique constraint on expression(s) not modelled: ${c.exprs.map((e) => e.name).join(', ')}`); return; }
        table.uniques.push({ name: c.name, columns: c.columns, source: source || 'constraint', where: null });
        (rec.facts.uniques = rec.facts.uniques || []).push(c.columns);
      } else if (c.kind === 'fk') {
        c.fk.line = rec.line;
        table.fks.push(c.fk);
        (rec.facts.fks = rec.facts.fks || []).push({ columns: c.fk.columns, refTable: c.fk.refTable, refColumns: c.fk.refColumns });
      } else if (c.kind === 'check') {
        note(rec, 'ignored', `CHECK constraint${c.name ? ' ' + c.name : ''} not diagrammed: ${c.text}`);
      } else if (c.kind === 'default') {
        const col = findColumn(table, c.column);
        if (col) { col.default = c.expr; if (c.name) col.defaultName = c.name; }
        else note(rec, 'warning', `DEFAULT for unknown column ${c.column}`);
      } else if (c.kind === 'index') {
        note(rec, 'ignored', `Non-unique index not diagrammed: ${c.text}`);
      } else {
        note(rec, c.level || 'ignored', `${c.what}: ${c.text}`);
      }
    }

    function addColumnToTable(table, def, rec) {
      const { col, inline } = def;
      if (findColumn(table, col.name)) { note(rec, 'warning', `Column ${col.name} defined twice in ${table.name}; later definition kept.`); table.columns = table.columns.filter((c) => lc(c.name) !== lc(col.name)); }
      table.columns.push(col);
      (rec.facts.columns = rec.facts.columns || []).push(col.name);
      if (inline.pk) applyConstraint(table, { kind: 'pk', name: inline.pk.name, columns: [col.name] }, rec);
      if (inline.unique) applyConstraint(table, { kind: 'unique', name: inline.unique.name, columns: [col.name] }, rec);
      if (inline.fk) { inline.fk.columns = [col.name]; applyConstraint(table, { kind: 'fk', fk: inline.fk }, rec); }
    }

    // ── statement handlers ──
    function handleCreateTable(ts, rec) {
      ts.expectWord('CREATE');
      ts.accept('OR', 'REPLACE');
      ts.acceptAny('GLOBAL', 'LOCAL'); ts.acceptAny('TEMP', 'TEMPORARY', 'UNLOGGED');
      ts.expectWord('TABLE');
      ts.accept('IF', 'NOT', 'EXISTS');
      const qn = qualifiedName(ts, dialect);
      const schema = dialect === 'mysql' ? (qn.schema || '') : schemaOf(qn);
      rec.kind = 'create-table'; rec.target = (schema ? schema + '.' : '') + qn.name;
      if (ts.isWord('AS') || ts.isWords('PARTITION', 'OF') || ts.isWord('OF') || (ts.isWord('LIKE') && dialect === 'mysql')) {
        rec.status = 'unread'; note(rec, 'warning', `CREATE TABLE ${rec.target} ${ts.peek().value} … is not supported (columns come from another object). Table not diagrammed.`); return;
      }
      const table = { schema, name: qn.name, comment: '', columns: [], pk: null, uniques: [], fks: [], line: rec.line, source: 'sql' };
      rec.facts = { table: qn.name, columns: [] };
      ts.expectPunct('(');
      while (!ts.eof() && !ts.isPunct(')')) {
        const at = ts.i;
        try {
          if (isTableConstraintStart(ts)) applyConstraint(table, parseTableConstraint(ts, rec), rec);
          else addColumnToTable(table, parseColumnDef(ts, rec), rec);
        } catch (e) {
          ts.i = at;
          const bad = smartJoin(ts.skipUntilListEnd());
          note(rec, 'warning', `Could not read table element "${bad.slice(0, 120)}" (${e.message}). It was skipped.`);
        }
        if (ts.isPunct(',')) ts.next();
        else if (!ts.isPunct(')') && !ts.eof()) { const bad = smartJoin(ts.skipUntilListEnd()); note(rec, 'warning', `Unexpected text skipped in ${qn.name}: ${bad.slice(0, 120)}`); if (ts.isPunct(',')) ts.next(); }
      }
      ts.expectPunct(')');
      if (!ts.eof()) {
        const restToks = ts.rest();
        const txt = smartJoin(restToks);
        const cm = /\bCOMMENT\s*=?\s*'((?:[^']|'')*)'/i.exec(txt);
        if (cm) table.comment = cm[1].replace(/''/g, "'");
        if (/\bINHERITS\b/i.test(txt)) note(rec, 'warning', `Table inheritance not modelled: ${txt}`);
        else note(rec, 'ignored', `Table options: ${txt}`);
      }
      const k = tkey(schema, qn.name);
      if (byKey.has(k)) {
        note(rec, 'warning', `Table ${rec.target} was already defined at line ${byKey.get(k).line}; this later definition replaces it.`);
        model.tables = model.tables.filter((t) => t !== byKey.get(k));
      }
      byKey.set(k, table); model.tables.push(table);
      rec.status = 'applied';
    }

    const ALTER_IGNORED = [
      ['OWNER', 'TO'], ['ENABLE'], ['DISABLE'], ['SET', 'SCHEMA'], ['SET', '('], ['RESET'], ['CLUSTER'], ['REPLICA'], ['ATTACH'], ['DETACH'], ['INHERIT'], ['NO', 'INHERIT'],
      ['VALIDATE'], ['ENGINE'], ['AUTO_INCREMENT'], ['CONVERT'], ['DEFAULT', 'CHARSET'], ['CHARACTER'], ['COLLATE'], ['ROW_FORMAT'], ['ALGORITHM'], ['LOCK'], ['FORCE'],
      ['SET', 'WITHOUT'], ['SET', 'LOGGED'], ['SET', 'UNLOGGED'], ['SET', 'TABLESPACE'], ['SET', 'ACCESS'], ['REBUILD'], ['SWITCH'], ['ORDER', 'BY'], ['PARTITION'], ['COALESCE'], ['REORGANIZE'],
    ];

    function handleAlterTable(ts, rec) {
      ts.expectWord('ALTER'); ts.expectWord('TABLE');
      ts.accept('IF', 'EXISTS'); ts.accept('ONLY');
      const qn = qualifiedName(ts, dialect);
      if (ts.isPunct('*')) ts.next();
      const schema = dialect === 'mysql' ? (qn.schema || '') : schemaOf(qn);
      rec.kind = 'alter-table'; rec.target = (schema ? schema + '.' : '') + qn.name;
      rec.facts = { table: qn.name };
      let table = findTable(schema, qn.name);
      if (!table && dialect === 'mysql' && !qn.schema) table = model.tables.find((t) => lc(t.name) === lc(qn.name));
      let trusted = true;
      if (ts.isWords('WITH', 'CHECK')) { ts.next(); ts.next(); }
      else if (ts.isWords('WITH', 'NOCHECK')) { ts.next(); ts.next(); trusted = false; }
      let applied = 0, ignored = 0;
      const needTable = () => { if (!table) throw new ParseError(`table ${rec.target} is not created anywhere in this script`); return table; };
      let lastAction = null;
      while (!ts.eof()) {
        const at = ts.i;
        // T-SQL: one ADD may introduce several comma-separated columns/constraints (ALTER TABLE t ADD a int, b int)
        const implicitAdd = dialect === 'tsql' && lastAction === 'add' && !ts.isWord(['ADD', 'DROP', 'ALTER', 'WITH', 'NOCHECK', 'ENABLE', 'DISABLE', 'SWITCH', 'SET', 'REBUILD']) && !ts.isWords('CHECK', 'CONSTRAINT');
        try {
          if (ts.isWord('ADD') || implicitAdd) {
            if (ts.isWord('ADD')) ts.next();
            lastAction = 'add';
            if (ts.isWord('COLUMN')) { ts.next(); ts.accept('IF', 'NOT', 'EXISTS'); addColumnToTable(needTable(), parseColumnDef(ts, rec), rec); applied++; }
            else if (ts.isPunct('(') && dialect === 'mysql') {
              ts.next();
              while (!ts.eof() && !ts.isPunct(')')) { addColumnToTable(needTable(), parseColumnDef(ts, rec), rec); if (ts.isPunct(',')) ts.next(); }
              ts.expectPunct(')'); applied++;
            } else if (isTableConstraintStart(ts) || ts.isWord('DEFAULT')) {
              const c = parseTableConstraint(ts, rec);
              if (c.kind === 'fk') c.fk.trusted = trusted && c.fk.trusted;
              applyConstraint(needTable(), c, rec, c.kind === 'unique' ? 'constraint' : undefined);
              if (c.kind === 'check' || c.kind === 'index' || c.kind === 'other') ignored++; else applied++;
            } else { ts.accept('IF', 'NOT', 'EXISTS'); addColumnToTable(needTable(), parseColumnDef(ts, rec), rec); applied++; }
          } else if (ts.isWord('DROP')) {
            ts.next(); lastAction = 'drop';
            if (ts.isWords('PRIMARY', 'KEY')) { ts.next(); ts.next(); needTable().pk = null; applied++; }
            else if (ts.isWord('CONSTRAINT') || (ts.isWords('FOREIGN', 'KEY') && dialect === 'mysql') || (ts.isWord(['INDEX', 'KEY']) && dialect === 'mysql')) {
              if (ts.isWord('FOREIGN')) ts.next(); ts.next(); ts.accept('IF', 'EXISTS');
              const nm = identVal(ts.ident(), dialect); const t = needTable();
              const before = t.fks.length + t.uniques.length + (t.pk ? 1 : 0);
              t.fks = t.fks.filter((f) => lc(f.name) !== lc(nm)); t.uniques = t.uniques.filter((u) => lc(u.name) !== lc(nm));
              if (t.pk && lc(t.pk.name) === lc(nm)) t.pk = null;
              const after = t.fks.length + t.uniques.length + (t.pk ? 1 : 0);
              if (after < before) applied++; else { note(rec, 'ignored', `DROP of ${nm}: no matching key in the model (probably a CHECK/DEFAULT/index).`); ignored++; }
              while (ts.isWord(['CASCADE', 'RESTRICT'])) ts.next();
            } else {
              ts.accept('COLUMN'); ts.accept('IF', 'EXISTS');
              const t = needTable();
              do {
                const nm = identVal(ts.ident(), dialect);
                if (!findColumn(t, nm)) note(rec, 'warning', `DROP COLUMN ${nm}: column not found.`);
                t.columns = t.columns.filter((c) => lc(c.name) !== lc(nm));
                applied++;
                while (ts.isWord(['CASCADE', 'RESTRICT'])) ts.next();
                if (dialect === 'tsql' && ts.isPunct(',') && isIdentTok(ts.peek(1)) && !ts.isWord(['ADD', 'DROP', 'ALTER'], 1)) { ts.next(); continue; }
                break;
              } while (true);
            }
          } else if (ts.isWord('ALTER') || ts.isWord('MODIFY') || ts.isWord('CHANGE')) {
            const verb = ts.next().up; lastAction = verb;
            ts.accept('COLUMN');
            const t = needTable();
            if (verb === 'MODIFY' || verb === 'CHANGE') {
              let oldName = null;
              if (verb === 'CHANGE') oldName = identVal(ts.ident(), dialect);
              const def = parseColumnDef(ts, rec);
              const idx = t.columns.findIndex((c) => lc(c.name) === lc(oldName || def.col.name));
              if (idx < 0) note(rec, 'warning', `${verb} of unknown column ${oldName || def.col.name}`);
              else { t.columns[idx] = def.col; if (oldName) renameColumnRefs(t, oldName, def.col.name); }
              applied++;
            } else {
              const nm = identVal(ts.ident(), dialect);
              const col = findColumn(t, nm);
              if (!col) throw new ParseError(`ALTER COLUMN ${nm}: column not found`);
              if (ts.isWords('SET', 'NOT', 'NULL')) { ts.next(); ts.next(); ts.next(); col.nullable = false; applied++; }
              else if (ts.isWords('DROP', 'NOT', 'NULL')) { ts.next(); ts.next(); ts.next(); col.nullable = true; applied++; }
              else if (ts.isWords('SET', 'DEFAULT')) { ts.next(); ts.next(); col.default = takeExpr(ts); applied++; }
              else if (ts.isWords('DROP', 'DEFAULT')) { ts.next(); ts.next(); col.default = null; applied++; }
              else if (ts.isWord('TYPE') || ts.isWords('SET', 'DATA', 'TYPE')) {
                if (ts.isWord('SET')) { ts.next(); ts.next(); } ts.next();
                col.type = parseType(ts); if (ts.isWord('COLLATE')) { ts.next(); ts.next(); } if (ts.isWord('USING')) { ts.next(); takeExpr(ts); } applied++;
              } else if (ts.isWord('ADD') && ts.isWord('GENERATED', 1)) { ts.next(); ts.next(); ts.skipUntilListEnd(); col.identity = true; applied++; }
              else if (dialect === 'tsql' && (isIdentTok(ts.peek()))) {
                col.type = parseType(ts);
                if (ts.isWords('NOT', 'NULL')) { ts.next(); ts.next(); col.nullable = false; } else if (ts.isWord('NULL')) { ts.next(); col.nullable = true; }
                const rest = ts.skipUntilListEnd(); if (rest.length) note(rec, 'ignored', `ALTER COLUMN options: ${smartJoin(rest)}`);
                applied++;
              } else { const rest = smartJoin(ts.skipUntilListEnd()); note(rec, 'ignored', `ALTER COLUMN ${nm} ${rest}`); ignored++; }
            }
          } else if (ts.isWord('RENAME')) {
            ts.next(); const t = needTable(); lastAction = 'rename';
            if (ts.isWord('COLUMN') || (isIdentTok(ts.peek()) && ts.isWord('TO', 1))) {
              ts.accept('COLUMN'); const a = identVal(ts.ident(), dialect); ts.expectWord('TO'); const b = identVal(ts.ident(), dialect);
              const col = findColumn(t, a); if (!col) throw new ParseError(`RENAME COLUMN ${a}: column not found`);
              col.name = b; renameColumnRefs(t, a, b); applied++;
            } else if (ts.isWord('CONSTRAINT')) { ts.next(); const a = identVal(ts.ident(), dialect); ts.expectWord('TO'); const b = identVal(ts.ident(), dialect); for (const f of t.fks) if (lc(f.name) === lc(a)) f.name = b; for (const u of t.uniques) if (lc(u.name) === lc(a)) u.name = b; if (t.pk && lc(t.pk.name) === lc(a)) t.pk.name = b; applied++; }
            else {
              ts.acceptAny('TO', 'AS'); const nq = qualifiedName(ts, dialect);
              const newSchema = dialect === 'mysql' ? (nq.schema || t.schema) : (nq.schema || t.schema);
              byKey.delete(tkey(t.schema, t.name)); t.name = nq.name; t.schema = newSchema; byKey.set(tkey(t.schema, t.name), t);
              note(rec, 'info', `Table renamed to ${t.name}; foreign keys that referenced the old name were updated.`);
              for (const other of model.tables) for (const f of other.fks) if (lc(f.refTable) === lc(qn.name)) { f.refTable = t.name; f.refSchema = t.schema; }
              applied++;
            }
          } else if (ts.isWords('CHECK', 'CONSTRAINT') || ts.isWords('NOCHECK', 'CONSTRAINT')) {
            const nocheck = ts.next().up === 'NOCHECK'; ts.next();
            const t = needTable();
            if (ts.isWord('ALL')) { ts.next(); if (nocheck) t.fks.forEach((f) => { f.disabled = true; }); }
            else {
              do {
                const nm = identVal(ts.ident(), dialect);
                const f = t.fks.find((x) => lc(x.name) === lc(nm));
                if (f) f.disabled = nocheck;
                if (ts.isPunct(',') && isIdentTok(ts.peek(1))) { ts.next(); continue; }
                break;
              } while (true);
            }
            note(rec, 'ignored', `${nocheck ? 'NOCHECK' : 'CHECK'} CONSTRAINT (enable/disable)${nocheck ? ' — matching foreign keys are marked disabled' : ''}`);
            ignored++;
          } else {
            const m = ALTER_IGNORED.find((seq) => seq.every((w, k) => (w === '(' ? ts.isPunct('(', k) : ts.isWord(w, k))));
            const rest = smartJoin(ts.skipUntilListEnd());
            if (m) { note(rec, 'ignored', `ALTER TABLE action not structural: ${rest}`); ignored++; }
            else { note(rec, 'warning', `Unrecognised ALTER TABLE action skipped: ${rest.slice(0, 160)}`); }
          }
        } catch (e) {
          ts.i = at;
          const rest = smartJoin(ts.skipUntilListEnd());
          note(rec, 'warning', `Could not apply "${rest.slice(0, 160)}": ${e.message}`);
        }
        if (ts.isPunct(',')) { ts.next(); continue; }
        if (!ts.eof()) { const rest = smartJoin(ts.rest()); note(rec, 'warning', `Unexpected trailing text skipped: ${rest.slice(0, 160)}`); }
      }
      if (!table && applied === 0) { rec.status = 'unread'; if (!rec.notes.some((n) => n.level === 'warning')) note(rec, 'warning', `ALTER TABLE on ${rec.target}, which is not created in this script.`); return; }
      rec.status = applied ? 'applied' : 'ignored';
      if (!applied && !ignored && !rec.notes.length) note(rec, 'warning', 'ALTER TABLE contained no recognisable action.');
    }

    function renameColumnRefs(table, a, b) {
      const r = (arr) => arr.map((c) => (lc(c) === lc(a) ? b : c));
      if (table.pk) table.pk.columns = r(table.pk.columns);
      for (const u of table.uniques) u.columns = r(u.columns);
      for (const f of table.fks) f.columns = r(f.columns);
      for (const other of model.tables) for (const f of other.fks) if (lc(f.refTable) === lc(table.name) && lc(f.refSchema || table.schema) === lc(table.schema)) f.refColumns = r(f.refColumns);
    }

    function handleCreateIndex(ts, rec) {
      ts.expectWord('CREATE');
      const unique = !!ts.acceptAny('UNIQUE');
      ts.acceptAny('CLUSTERED', 'NONCLUSTERED'); ts.acceptAny('FULLTEXT', 'SPATIAL', 'BITMAP');
      ts.acceptAny('COLUMNSTORE');
      ts.expectWord('INDEX');
      ts.accept('CONCURRENTLY'); ts.accept('IF', 'NOT', 'EXISTS');
      let name = null;
      if (!ts.isWord('ON')) name = identVal(ts.ident(), dialect);
      if (ts.isWord('USING')) { ts.next(); ts.next(); }
      ts.expectWord('ON'); ts.accept('ONLY');
      const qn = qualifiedName(ts, dialect);
      const schema = dialect === 'mysql' ? (qn.schema || '') : schemaOf(qn);
      rec.kind = 'create-index'; rec.target = (schema ? schema + '.' : '') + qn.name;
      if (ts.isWord('USING')) { ts.next(); ts.next(); }
      if (!unique) { rec.status = 'ignored'; note(rec, 'ignored', `Non-unique index ${name || ''} on ${rec.target} — indexes are not diagrammed.`); return; }
      const cols = parseIdentList(ts, rec);
      let where = null;
      while (!ts.eof()) {
        if (ts.isWord('WHERE')) { ts.next(); const w = []; while (!ts.eof() && !ts.isWord(['WITH', 'ON', 'TABLESPACE'])) w.push(...ts.skipGroupOrToken()); where = smartJoin(w); continue; }
        if (ts.isWord('INCLUDE')) { ts.next(); ts.skipGroupOrToken(); continue; }
        if (ts.isWord('WITH')) { ts.next(); ts.skipGroupOrToken(); continue; }
        if (ts.isWord('ON')) { ts.next(); ts.skipGroupOrToken(); continue; }
        if (ts.isWord('TABLESPACE')) { ts.next(); ts.next(); continue; }
        if (ts.isWords('NULLS', 'NOT', 'DISTINCT')) { ts.next(); ts.next(); ts.next(); continue; }
        if (ts.isWords('NULLS', 'DISTINCT')) { ts.next(); ts.next(); continue; }
        note(rec, 'ignored', `Index option: ${smartJoin(ts.skipGroupOrToken())}`);
      }
      let table = findTable(schema, qn.name);
      if (!table && dialect === 'mysql' && !qn.schema) table = model.tables.find((t) => lc(t.name) === lc(qn.name));
      if (!table) { rec.status = 'unread'; note(rec, 'warning', `Unique index ${name || ''} is on ${rec.target}, which is not created in this script.`); return; }
      if (cols.some((c) => c.expr)) { rec.status = 'ignored'; note(rec, 'warning', `Unique index ${name || ''} uses expressions (${cols.filter((c) => c.expr).map((c) => c.name).join(', ')}); not modelled as a key.`); return; }
      table.uniques.push({ name, columns: cols.map((c) => c.name), source: 'index', where });
      if (where) note(rec, 'info', `Filtered unique index — unique only where ${where}.`);
      rec.facts = { table: qn.name, uniques: [cols.map((c) => c.name)] };
      rec.status = 'applied';
    }

    function handleCommentOn(ts, rec) {
      ts.expectWord('COMMENT'); ts.expectWord('ON');
      const what = ts.next().up;
      rec.kind = 'comment';
      if (what !== 'TABLE' && what !== 'COLUMN') { rec.status = 'ignored'; note(rec, 'ignored', `COMMENT ON ${what}`); ts.rest(); return; }
      const parts = [identVal(ts.ident(), dialect)];
      while (ts.isPunct('.')) { ts.next(); parts.push(identVal(ts.ident(), dialect)); }
      ts.expectWord('IS');
      const v = ts.next();
      const text = v.type === 'str' ? v.value : '';
      let schema, tname, cname;
      if (what === 'TABLE') { tname = parts[parts.length - 1]; schema = parts.length >= 2 ? parts[parts.length - 2] : defSchema; }
      else { cname = parts[parts.length - 1]; tname = parts[parts.length - 2]; schema = parts.length >= 3 ? parts[parts.length - 3] : defSchema; }
      const t = findTable(schema, tname);
      if (!t) { rec.status = 'unread'; note(rec, 'warning', `COMMENT ON ${what} for ${schema}.${tname}, which is not in the script.`); return; }
      if (what === 'TABLE') t.comment = text;
      else { const c = findColumn(t, cname); if (!c) { rec.status = 'unread'; note(rec, 'warning', `COMMENT ON unknown column ${cname}`); return; } c.comment = text; }
      rec.target = schema + '.' + tname + (cname ? '.' + cname : '');
      rec.status = 'applied';
    }

    function handleExec(ts, rec) {
      ts.next();
      rec.kind = 'exec';
      if (ts.isPunct('(')) {
        const inner = ts.rest().filter((t) => t.type === 'str').map((t) => t.value).join(' ');
        rec.status = 'unread';
        note(rec, 'warning', `Dynamic SQL inside EXEC(...) is not read: ${inner.slice(0, 160)}`);
        return;
      }
      const qn = qualifiedName(ts, dialect);
      if (lc(qn.name) !== 'sp_addextendedproperty' && lc(qn.name) !== 'sp_updateextendedproperty') { rec.status = 'ignored'; note(rec, 'ignored', `EXEC ${qn.name}`); ts.rest(); return; }
      const order = ['@name', '@value', '@level0type', '@level0name', '@level1type', '@level1name', '@level2type', '@level2name'];
      const args = {}; let pos = 0;
      while (!ts.eof()) {
        let key = null;
        if (ts.peek().type === 'var' && ts.isPunct('=', 1)) { key = lc(ts.next().value); ts.next(); }
        const v = ts.skipUntilListEnd();
        const val = v.length === 1 && v[0].type === 'str' ? v[0].value : v.length === 1 && v[0].type === 'word' && v[0].up === 'NULL' ? null : smartJoin(v);
        args[key || order[pos]] = val; pos++;
        if (ts.isPunct(',')) ts.next(); else break;
      }
      if (lc(args['@name']) !== 'ms_description') { rec.status = 'ignored'; note(rec, 'ignored', `Extended property ${args['@name']}`); return; }
      const schema = args['@level0name'] || defSchema, tname = args['@level1name'], cname = lc(args['@level2type']) === 'column' ? args['@level2name'] : null;
      const t = tname && findTable(schema, tname);
      if (!t) { rec.status = 'unread'; note(rec, 'warning', `MS_Description for ${schema}.${tname}, which is not in the script.`); return; }
      if (cname) { const c = findColumn(t, cname); if (!c) { rec.status = 'unread'; note(rec, 'warning', `MS_Description for unknown column ${cname}`); return; } c.comment = args['@value'] || ''; }
      else if (lc(args['@level1type']) === 'table') t.comment = args['@value'] || '';
      rec.target = schema + '.' + tname + (cname ? '.' + cname : ''); rec.kind = 'comment'; rec.status = 'applied';
    }

    function handleDropTable(ts, rec) {
      ts.next(); ts.next(); ts.accept('IF', 'EXISTS');
      rec.kind = 'drop-table';
      const removed = [];
      do {
        const qn = qualifiedName(ts, dialect);
        const schema = dialect === 'mysql' ? (qn.schema || '') : schemaOf(qn);
        const k = tkey(schema, qn.name);
        if (byKey.has(k)) { const t = byKey.get(k); byKey.delete(k); model.tables = model.tables.filter((x) => x !== t); removed.push(qn.name); }
        if (ts.isPunct(',')) { ts.next(); continue; }
        break;
      } while (true);
      while (ts.isWord(['CASCADE', 'RESTRICT'])) ts.next();
      if (removed.length) { rec.status = 'applied'; note(rec, 'warning', `DROP TABLE removed ${removed.join(', ')} (defined earlier in this script).`); }
      else { rec.status = 'ignored'; note(rec, 'ignored', 'DROP TABLE of a table not yet defined (normal at the top of dump files).'); }
    }

    function handleCreateSchema(ts, rec) {
      ts.next(); ts.next(); ts.accept('IF', 'NOT', 'EXISTS');
      rec.kind = 'create-schema';
      if (ts.isWord('AUTHORIZATION')) { rec.status = 'ignored'; ts.rest(); return; }
      const n = identVal(ts.ident(), dialect);
      if (!model.schemas.includes(n)) model.schemas.push(n);
      rec.target = n; rec.status = 'applied';
      const rest = ts.rest();
      if (rest.some((t) => t.type === 'word' && t.up === 'CREATE')) note(rec, 'warning', 'CREATE SCHEMA with embedded statements: the embedded statements were not read.');
    }

    // ── dispatch ──
    for (const st of stmts) {
      const rec = { line: st.line, kind: 'other', status: 'unread', target: null, notes: [], snippet: '', facts: {}, text: st.text };
      model.log.push(rec);
      if (st.directive) {
        rec.kind = st.directive; rec.status = 'ignored'; rec.snippet = st.text.slice(0, 160);
        note(rec, 'ignored', st.directive === 'psql' ? 'psql meta-command' : st.directive === 'copy-data' ? 'COPY data rows' : 'client DELIMITER directive');
        continue;
      }
      const ts = new TS(st.tokens);
      rec.snippet = smartJoin(st.tokens.slice(0, 40)).slice(0, 200);
      const u = (k) => { const t = ts.peek(k); return t && t.type === 'word' ? t.up : ''; };
      try {
        let k = 1; while (/^(OR|REPLACE|ALTER|GLOBAL|LOCAL|TEMP|TEMPORARY|UNLOGGED|UNIQUE|CLUSTERED|NONCLUSTERED|FULLTEXT|SPATIAL|BITMAP|COLUMNSTORE|DEFINER|ALGORITHM|SQL|SECURITY|RECURSIVE|MATERIALIZED|CONSTRAINT|TRUSTED|PROCEDURAL|AGGREGATE)$/.test(u(k)) || (u(k - 1) === 'DEFINER' && ts.isPunct('=', k))) k++;
        if (u(0) === 'CREATE' && u(k) === 'TABLE') handleCreateTable(ts, rec);
        else if (u(0) === 'CREATE' && u(k) === 'INDEX') handleCreateIndex(ts, rec);
        else if (u(0) === 'CREATE' && u(1) === 'SCHEMA') handleCreateSchema(ts, rec);
        else if (u(0) === 'ALTER' && u(1) === 'TABLE') handleAlterTable(ts, rec);
        else if (u(0) === 'COMMENT' && u(1) === 'ON') handleCommentOn(ts, rec);
        else if (u(0) === 'EXEC' || u(0) === 'EXECUTE') handleExec(ts, rec);
        else if (u(0) === 'DROP' && u(1) === 'TABLE') handleDropTable(ts, rec);
        else if ((u(0) === 'CREATE' || u(0) === 'ALTER' || u(0) === 'DROP' || u(0) === 'COMMENT') && (IGNORED_OBJECTS.test(u(k)) || IGNORED_OBJECTS.test(u(1)) || u(1) === 'INDEX' || u(1) === 'SCHEMA')) {
          rec.kind = lc(u(0)) + '-' + lc(u(k) || u(1)); rec.status = 'ignored';
          note(rec, 'ignored', `${u(0)} ${u(k) || u(1)} — not part of the table diagram`);
        } else if (IGNORED_FIRST[u(0)]) {
          rec.kind = lc(u(0)); rec.status = 'ignored'; note(rec, 'ignored', IGNORED_FIRST[u(0)]);
        } else if (u(0) === 'WITH' || u(0) === 'GO') {
          rec.kind = lc(u(0)); rec.status = 'ignored'; note(rec, 'ignored', u(0) === 'GO' ? 'batch separator' : 'query');
        } else {
          rec.status = 'unread'; note(rec, 'warning', 'Statement not recognised; nothing was read from it.');
        }
      } catch (e) {
        rec.status = 'unread';
        note(rec, 'warning', `Could not read statement: ${e.message}`);
      }
      if (rec.status === 'applied' && rec.notes.some((n) => n.level === 'warning')) rec.status = 'partial';
    }

    finalizeModel(model, byKey, defSchema);
    if (options.crossCheck) crossCheck(model, options.crossCheck, dialect);
    return model;
  }

  function finalizeModel(model, byKey, defSchema) {
    for (const t of model.tables) {
      if (t.schema && !model.schemas.includes(t.schema)) model.schemas.push(t.schema);
      if (t.pk) {
        for (const cn of t.pk.columns) { const c = t.columns.find((x) => lc(x.name) === lc(cn)); if (c) c.nullable = false; else model.issues.push({ level: 'warning', line: t.line, message: `Primary key of ${t.name} names column ${cn}, which does not exist.` }); }
      }
      t.uniques = uniqBy(t.uniques, (u) => (u.name ? 'n:' + lc(u.name) : 'c:' + u.columns.map(lc).join(',')));
    }
    for (const t of model.tables) {
      for (const fk of t.fks) {
        const refSchema = fk.refSchema != null && fk.refSchema !== '' ? fk.refSchema : (model.dialect === 'mysql' ? t.schema : defSchema);
        fk.refSchema = refSchema;
        let target = byKey.get(tkey(refSchema, fk.refTable));
        if (!target && model.dialect === 'mysql') target = model.tables.find((x) => lc(x.name) === lc(fk.refTable));
        fk.unresolved = !target;
        if (!target) { model.issues.push({ level: 'warning', line: fk.line, message: `Foreign key ${fk.name || ''} on ${t.name}(${fk.columns.join(', ')}) references ${refSchema ? refSchema + '.' : ''}${fk.refTable}, which is not in the script. It is drawn as an external table.` }); continue; }
        fk.refSchema = target.schema;
        if (!fk.refColumns.length) {
          if (target.pk) fk.refColumns = target.pk.columns.slice();
          else model.issues.push({ level: 'warning', line: fk.line, message: `Foreign key ${fk.name || ''} on ${t.name} names no target columns and ${target.name} has no primary key.` });
        }
        if (fk.refColumns.length && fk.refColumns.length !== fk.columns.length) model.issues.push({ level: 'warning', line: fk.line, message: `Foreign key ${fk.name || ''} on ${t.name}: ${fk.columns.length} column(s) reference ${fk.refColumns.length} column(s).` });
        for (const cn of fk.columns) if (!t.columns.some((c) => lc(c.name) === lc(cn))) model.issues.push({ level: 'warning', line: fk.line, message: `Foreign key ${fk.name || ''} on ${t.name} uses column ${cn}, which does not exist.` });
        for (const cn of fk.refColumns) if (!target.columns.some((c) => lc(c.name) === lc(cn))) model.issues.push({ level: 'warning', line: fk.line, message: `Foreign key ${fk.name || ''} on ${t.name} references ${target.name}.${cn}, which does not exist.` });
      }
    }
  }

  // ───────────────────── independent cross-check with node-sql-parser ─────────────────────
  function nspFacts(ast) {
    const a = Array.isArray(ast) ? ast[0] : ast;
    if (!a || typeof a !== 'object') return null;
    const name = (x) => (x == null ? null : typeof x === 'string' ? x : x.expr ? name(x.expr) : x.value != null ? String(x.value) : x.column != null ? name(x.column) : null);
    const tbl = Array.isArray(a.table) ? a.table[0] : a.table;
    const f = { type: a.type, keyword: a.keyword, table: tbl && tbl.table, columns: [], pk: [], uniques: [], fks: [] };
    const ref = (rd) => ({ refTable: rd.table && rd.table[0] && rd.table[0].table, refColumns: (rd.definition || []).map(name) });
    const visit = (d) => {
      if (!d) return;
      if (d.resource === 'column') {
        const cn = name(d.column); f.columns.push(cn);
        if (d.primary_key) f.pk = [cn];
        if (d.unique || d.unique_or_primary === 'unique') f.uniques.push([cn]);
        if (d.reference_definition) f.fks.push(Object.assign({ columns: [cn] }, ref(d.reference_definition)));
      } else if (d.resource === 'constraint') {
        const cols = (d.definition || []).map(name);
        const ct = lc(d.constraint_type);
        if (ct === 'primary key') f.pk = cols;
        else if (ct.startsWith('unique')) f.uniques.push(cols);
        else if (ct === 'foreign key' && d.reference_definition) f.fks.push(Object.assign({ columns: cols }, ref(d.reference_definition)));
      }
    };
    if (a.type === 'create' && a.keyword === 'table') (a.create_definitions || []).forEach(visit);
    else if (a.type === 'alter') (a.expr || []).forEach((e) => { if (e.create_definitions) visit(e.create_definitions); else if (e.resource === 'column') visit(e); });
    else if (a.type === 'create' && a.keyword === 'index') { if (lc(a.index_type) === 'unique') f.uniques.push((a.index_columns || []).map(name)); }
    return f;
  }

  function crossCheck(model, ParserCtor, dialect) {
    let parser;
    try { parser = typeof ParserCtor === 'function' ? new ParserCtor() : ParserCtor; } catch (e) { return; }
    const db = DIALECTS[dialect].nsp;
    const summary = { checked: 0, confirmed: 0, disagreed: 0, grammarFailed: 0, misread: 0 };
    for (const rec of model.log) {
      if (!['create-table', 'alter-table', 'create-index'].includes(rec.kind) || !['applied', 'partial'].includes(rec.status)) continue;
      const f = rec.facts || {};
      if (rec.kind === 'alter-table' && !f.fks && !f.pk && !f.uniques && !f.columns) continue;
      summary.checked++;
      let ast;
      try { ast = parser.astify(rec.text, { database: db }); }
      catch (e) { summary.grammarFailed++; rec.check = { status: 'not-checked', detail: `node-sql-parser (${db}) could not parse this statement: ${String(e.message).split('\n')[0].slice(0, 140)}` }; continue; }
      const g = nspFacts(ast);
      const expectedType = rec.kind === 'create-table' ? 'create/table' : rec.kind === 'create-index' ? 'create/index' : 'alter';
      const gotType = g ? (g.type === 'alter' ? 'alter' : g.type + '/' + g.keyword) : 'nothing';
      if (gotType !== expectedType) { summary.misread++; rec.check = { status: 'misread', detail: `node-sql-parser read this as "${gotType}" — its grammar misreads this statement, so it is not an independent check here.` }; continue; }
      const diffs = [];
      const L = (a) => (a || []).map((x) => lc(x));
      if (f.table && g.table && lc(f.table) !== lc(g.table)) diffs.push(`table name: built-in "${f.table}" vs node-sql-parser "${g.table}"`);
      if (f.columns && f.columns.length && L(f.columns).join(',') !== L(g.columns).join(',')) diffs.push(`columns: built-in [${f.columns.join(', ')}] vs node-sql-parser [${g.columns.join(', ')}]`);
      if (f.pk && L(f.pk).join(',') !== L(g.pk).join(',')) diffs.push(`primary key: built-in (${f.pk.join(', ')}) vs node-sql-parser (${g.pk.join(', ')})`);
      const sig = (x) => L(x.columns).join(',') + '>' + lc(x.refTable) + '(' + L(x.refColumns).join(',') + ')';
      const fa = (f.fks || []).map(sig).sort().join(' | '), fb = g.fks.map(sig).sort().join(' | ');
      if (fa !== fb) diffs.push(`foreign keys: built-in [${fa}] vs node-sql-parser [${fb}]`);
      const ua = (f.uniques || []).map((u) => L(u).join(',')).sort().join(' | '), ub = g.uniques.map((u) => L(u).join(',')).sort().join(' | ');
      if (ua !== ub) diffs.push(`unique keys: built-in [${ua}] vs node-sql-parser [${ub}]`);
      if (diffs.length) { summary.disagreed++; rec.check = { status: 'disagree', detail: diffs.join('; ') }; rec.notes.push({ level: 'warning', message: 'The two parsers disagree — check this statement by eye: ' + diffs.join('; ') }); if (rec.status === 'applied') rec.status = 'partial'; }
      else { summary.confirmed++; rec.check = { status: 'confirmed', detail: 'node-sql-parser read the same tables, columns and keys.' }; }
    }
    model.crossCheck = summary;
  }

  // ───────────────────────────── relationship guessing ─────────────────────────────
  function typeFamily(t) {
    const s = lc(t).replace(/\(.*$/, '').replace(/\s+(unsigned|signed|zerofill)$/, '').trim();
    if (/^(int|integer|bigint|smallint|tinyint|mediumint|int[248]|serial|bigserial|smallserial|serial[48]|number|numeric|decimal)\b/.test(s)) return 'int';
    if (/^(uuid|uniqueidentifier)$/.test(s)) return 'uuid';
    if (/(char|text|string|varchar|nvarchar|citext)/.test(s)) return 'string';
    return s || 'unknown';
  }
  function splitWords(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').split(/[_\s]+/).filter(Boolean).map(lc);
  }
  function guessRelationships(model) {
    const out = [];
    const tables = model.tables;
    // Any column already taking part in a declared FK (including composite ones) is never guessed.
    const declared = new Set();
    for (const t of tables) for (const f of t.fks) for (const c of f.columns) declared.add(tkey(t.schema, t.name) + '.' + lc(c));
    const byName = new Map();
    for (const t of tables) { const k = lc(t.name).replace(/[_\s]/g, ''); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(t); }
    const singlePk = (t) => (t.pk && t.pk.columns.length === 1 ? t.pk.columns[0] : null);
    const pkNameOwners = new Map();
    for (const t of tables) { const p = singlePk(t); if (p && !/^id$/i.test(p)) { const k = lc(p); if (!pkNameOwners.has(k)) pkNameOwners.set(k, []); pkNameOwners.get(k).push(t); } }
    const pickTarget = (cands, t) => { if (cands.length === 1) return cands[0]; const same = cands.filter((c) => lc(c.schema) === lc(t.schema)); return same.length === 1 ? same[0] : null; };
    for (const t of tables) {
      const ownPk = singlePk(t);
      for (const c of t.columns) {
        if (declared.has(tkey(t.schema, t.name) + '.' + lc(c.name))) continue;
        if (ownPk && lc(ownPk) === lc(c.name)) continue;
        let target = null, reason = '';
        // Rule 1: column has the same (non-generic) name as exactly one other table's single-column PK, e.g. CustomerID → Customers.CustomerID
        const owners = (pkNameOwners.get(lc(c.name)) || []).filter((o) => o !== t);
        if (owners.length) { target = pickTarget(owners, t); reason = 'same name as primary key of'; }
        // Rule 2: <thing>_id / <thing>Id → table named thing / things / thinges / thingies
        if (!target) {
          const m = /^(.*?)[_ ]?(id|Id|ID|iD)$/.exec(c.name);
          if (m && m[1]) {
            const words = splitWords(m[1]);
            for (let s = 0; s < words.length && !target; s++) {
              const base = words.slice(s).join('');
              const forms = [base, base + 's', base + 'es', base.replace(/y$/, 'ies')];
              for (const fm of forms) { const cands = (byName.get(fm) || []).filter((x) => singlePk(x)); if (cands.length) { target = pickTarget(cands, t); if (target) { reason = 'name suggests'; break; } } }
            }
          }
        }
        // Rule 3: parent_id / ParentId with no "parent" table → self-reference (tree)
        if (!target && /^parent_?id$/i.test(c.name) && singlePk(t)) { target = t; reason = 'tree column in'; }
        if (!target || (target === t && !/parent|manager|reports|previous|next|replaced|original/i.test(c.name))) continue;
        const tpk = singlePk(target); if (!tpk) continue;
        const tcol = target.columns.find((x) => lc(x.name) === lc(tpk));
        if (!tcol || typeFamily(tcol.type) !== typeFamily(c.type)) continue;
        out.push({ name: null, columns: [c.name], refSchema: target.schema, refTable: target.name, refColumns: [tpk], guessed: true, from: { schema: t.schema, table: t.name }, reason: `${reason} ${target.name}`, onDelete: null, onUpdate: null });
      }
    }
    return out;
  }

  // ───────────────────────────── manual overlay ─────────────────────────────
  // overlay = { version, tables:[{id, schema, name, comment, columns:[col]}], columns:[{id, schema, table, column:col}], relationships:[{id, schema, table, columns, refSchema, refTable, refColumns, name}] }
  function emptyOverlay() { return { version: 1, tables: [], columns: [], relationships: [] }; }

  function applyOverlay(base, overlay) {
    const m = clone(base);
    overlay = overlay || emptyOverlay();
    const conflicts = [];
    const byKey = new Map(m.tables.map((t) => [tkey(t.schema, t.name), t]));
    for (const t of m.tables) { t.source = t.source || 'sql'; for (const c of t.columns) c.source = c.source || 'sql'; for (const f of t.fks) f.source = f.source || 'sql'; }
    const findT = (schema, name) => byKey.get(tkey(schema, name)) || (m.dialect === 'mysql' && !schema ? m.tables.find((t) => lc(t.name) === lc(name)) : null);
    for (const mt of overlay.tables || []) {
      const existing = findT(mt.schema, mt.name);
      if (existing) {
        conflicts.push({ id: mt.id, kind: 'table-exists', target: `${mt.schema ? mt.schema + '.' : ''}${mt.name}`, message: `Manual table ${mt.name} now also exists in the SQL. Its manual columns that are not in the SQL are still shown; the rest are duplicates you can delete.` });
        for (const col of mt.columns || []) {
          if (existing.columns.some((c) => lc(c.name) === lc(col.name))) conflicts.push({ id: col.id, kind: 'column-exists', target: `${existing.name}.${col.name}`, message: `Manual column ${existing.name}.${col.name} is now in the SQL (${existing.columns.find((c) => lc(c.name) === lc(col.name)).type}). The SQL version is shown.` });
          else existing.columns.push(Object.assign({}, col, { source: 'manual' }));
        }
        continue;
      }
      const t = { schema: mt.schema || '', name: mt.name, comment: mt.comment || '', columns: (mt.columns || []).map((c) => Object.assign({}, c, { source: 'manual' })), pk: null, uniques: [], fks: [], source: 'manual', overlayId: mt.id };
      const pkCols = t.columns.filter((c) => c.pk).map((c) => c.name);
      if (pkCols.length) { t.pk = { name: null, columns: pkCols }; t.columns.forEach((c) => { if (c.pk) c.nullable = false; }); }
      m.tables.push(t); byKey.set(tkey(t.schema, t.name), t);
    }
    for (const mc of overlay.columns || []) {
      const t = findT(mc.schema, mc.table);
      if (!t) { conflicts.push({ id: mc.id, kind: 'orphan', target: `${mc.schema ? mc.schema + '.' : ''}${mc.table}.${mc.column.name}`, message: `Manual column ${mc.column.name} belongs to table ${mc.table}, which is no longer in the SQL. It is kept but not drawn.` }); continue; }
      const ex = t.columns.find((c) => lc(c.name) === lc(mc.column.name));
      if (ex) { conflicts.push({ id: mc.id, kind: 'column-exists', target: `${t.name}.${mc.column.name}`, message: `Manual column ${t.name}.${mc.column.name} is now in the SQL (${ex.type}${lc(ex.type) !== lc(mc.column.type) ? `; your manual type was ${mc.column.type}` : ''}). The SQL version is shown.` }); ex.alsoManual = true; continue; }
      t.columns.push(Object.assign({}, mc.column, { source: 'manual', overlayId: mc.id }));
    }
    for (const r of overlay.relationships || []) {
      const t = findT(r.schema, r.table), target = findT(r.refSchema, r.refTable);
      const label = `${r.table}(${r.columns.join(', ')}) → ${r.refTable}(${r.refColumns.join(', ')})`;
      if (!t || !target) { conflicts.push({ id: r.id, kind: 'orphan', target: label, message: `Manual relationship ${label}: ${!t ? r.table : r.refTable} is not in the model. Not drawn.` }); continue; }
      const missing = r.columns.filter((c) => !t.columns.some((x) => lc(x.name) === lc(c))).concat(r.refColumns.filter((c) => !target.columns.some((x) => lc(x.name) === lc(c))));
      if (missing.length) { conflicts.push({ id: r.id, kind: 'orphan', target: label, message: `Manual relationship ${label} uses missing column(s) ${missing.join(', ')}. Not drawn.` }); continue; }
      if (t.fks.some((f) => sameColSet(f.columns, r.columns) && lc(f.refTable) === lc(target.name))) { conflicts.push({ id: r.id, kind: 'relationship-exists', target: label, message: `Manual relationship ${label} is now declared in the SQL.` }); continue; }
      t.fks.push({ name: r.name || null, columns: r.columns.slice(), refSchema: target.schema, refTable: target.name, refColumns: r.refColumns.slice(), onDelete: null, onUpdate: null, source: 'manual', overlayId: r.id, disabled: false, trusted: true });
    }
    return { model: m, conflicts };
  }

  // ─────────────────── catalog (INFORMATION_SCHEMA) input & comparison ───────────────────
  const CATALOG_COLUMNS = ['kind', 'table_schema', 'table_name', 'column_name', 'ordinal', 'data_type', 'is_nullable', 'constraint_name', 'ref_schema', 'ref_table', 'ref_column'];
  const CATALOG_QUERIES = {
    tsql: `-- SQL Server: run in SSMS against the database, then copy the grid WITH headers (right-click → Copy with Headers).
SELECT 'COLUMN' AS kind, c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name,
       c.ORDINAL_POSITION AS ordinal, c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
       CAST(NULL AS sysname) AS constraint_name, CAST(NULL AS sysname) AS ref_schema, CAST(NULL AS sysname) AS ref_table, CAST(NULL AS sysname) AS ref_column
FROM INFORMATION_SCHEMA.COLUMNS c
JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
UNION ALL
SELECT tc.CONSTRAINT_TYPE, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, NULL, NULL, k.CONSTRAINT_NAME, NULL, NULL, NULL
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_NAME = tc.TABLE_NAME
WHERE tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
UNION ALL
SELECT 'FOREIGN KEY', SCHEMA_NAME(pt.schema_id), pt.name, pc.name, fkc.constraint_column_id, NULL, NULL, fk.name, SCHEMA_NAME(rt.schema_id), rt.name, rc.name
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
UNION ALL
SELECT 'UNIQUE INDEX', SCHEMA_NAME(t.schema_id), t.name, c.name, ic.key_ordinal, NULL, NULL, i.name, NULL, NULL, NULL
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.is_unique = 1 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
ORDER BY 2, 3, 1, 8, 5;`,
    postgres: `-- PostgreSQL: run with  psql -d yourdb --csv -f this.sql > catalog.csv   (or run in any client and export CSV with headers)
SELECT 'COLUMN'::text AS kind, c.table_schema::text, c.table_name::text, c.column_name::text, c.ordinal_position::int AS ordinal,
       c.data_type::text, c.is_nullable::text, NULL::text AS constraint_name, NULL::text AS ref_schema, NULL::text AS ref_table, NULL::text AS ref_column
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
UNION ALL
SELECT tc.constraint_type::text, k.table_schema::text, k.table_name::text, k.column_name::text, k.ordinal_position::int, NULL, NULL, k.constraint_name::text, NULL, NULL, NULL
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage k ON k.constraint_schema = tc.constraint_schema AND k.constraint_name = tc.constraint_name AND k.table_name = tc.table_name
WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE') AND k.table_schema NOT IN ('pg_catalog', 'information_schema')
UNION ALL
SELECT 'FOREIGN KEY', ns.nspname::text, cl.relname::text, a.attname::text, k.ord::int, NULL, NULL, con.conname::text, rns.nspname::text, rcl.relname::text, ra.attname::text
FROM pg_constraint con
JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
JOIN pg_class rcl ON rcl.oid = con.confrelid JOIN pg_namespace rns ON rns.oid = rcl.relnamespace
CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refattnum, ord)
JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refattnum
WHERE con.contype = 'f' AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
UNION ALL
SELECT 'UNIQUE INDEX', ns.nspname::text, cl.relname::text, a.attname::text, k.ord::int, NULL, NULL, ic.relname::text, NULL, NULL, NULL
FROM pg_index ix
JOIN pg_class ic ON ic.oid = ix.indexrelid
JOIN pg_class cl ON cl.oid = ix.indrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
CROSS JOIN LATERAL unnest(ix.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attnum = k.attnum
WHERE ix.indisunique AND NOT ix.indisprimary
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c2 WHERE c2.conindid = ix.indexrelid AND c2.contype IN ('u', 'p'))
  AND ns.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
ORDER BY 2, 3, 1, 8, 5;`,
    mysql: `-- MySQL / MariaDB: run while connected to the database (USE yourdb), export result as CSV with headers.
SELECT 'COLUMN' AS kind, c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name,
       c.ORDINAL_POSITION AS ordinal, c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
       NULL AS constraint_name, NULL AS ref_schema, NULL AS ref_table, NULL AS ref_column
FROM information_schema.COLUMNS c
JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
WHERE c.TABLE_SCHEMA = DATABASE()
UNION ALL
SELECT CASE WHEN k.REFERENCED_TABLE_NAME IS NOT NULL THEN 'FOREIGN KEY' ELSE tc.CONSTRAINT_TYPE END,
       k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, NULL, NULL, k.CONSTRAINT_NAME,
       k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND tc.TABLE_NAME = k.TABLE_NAME
WHERE k.TABLE_SCHEMA = DATABASE()
ORDER BY 2, 3, 1, 8, 5;`,
  };

  // Accepts CSV, TSV (SSMS "Copy with Headers"), psql aligned output, or MySQL CLI boxed output.
  function parseCatalogText(text) {
    let lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
    lines = lines.filter((l) => !/^[\s+\-|]+$/.test(l) && !/^\(\d+ rows?\)$/.test(l.trim()) && !/^\d+ rows? in set/.test(l.trim()));
    if (!lines.length) return { rows: [], errors: ['No rows found.'] };
    const first = lines[0];
    let split;
    if (first.includes('\t')) split = (l) => l.split('\t');
    else if (/^\s*\|/.test(first) || (first.includes('|') && !first.includes(','))) split = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
    else split = (l) => { const out = []; let cur = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
    const cells = lines.map((l) => split(l).map((c) => c.trim()));
    let header = cells[0].map(lc);
    let body = cells.slice(1);
    if (header[0] !== 'kind') { header = CATALOG_COLUMNS; body = cells; }
    const idx = Object.fromEntries(CATALOG_COLUMNS.map((c) => [c, header.indexOf(c)]));
    const errors = [];
    const missing = CATALOG_COLUMNS.filter((c) => idx[c] < 0);
    if (missing.length) errors.push('Missing columns: ' + missing.join(', ') + '. Use the query shown above.');
    const val = (row, c) => { const v = idx[c] >= 0 ? row[idx[c]] : null; return v == null || v === '' || /^null$/i.test(v) ? null : v; };
    const rows = body.map((r) => Object.fromEntries(CATALOG_COLUMNS.map((c) => [c, val(r, c)]))).filter((r) => r.kind);
    return { rows, errors };
  }

  function catalogToModel(rows) {
    const tables = new Map();
    const T = (s, n) => { const k = tkey(s, n); if (!tables.has(k)) tables.set(k, { schema: s, name: n, columns: [], pk: null, uniques: new Map(), fks: new Map() }); return tables.get(k); };
    for (const r of rows) {
      const kind = (r.kind || '').toUpperCase();
      if (kind === 'COLUMN') T(r.table_schema, r.table_name).columns.push({ name: r.column_name, ordinal: +r.ordinal, type: r.data_type, nullable: /^y/i.test(r.is_nullable || '') });
    }
    for (const r of rows) {
      const kind = (r.kind || '').toUpperCase();
      if (kind === 'COLUMN') continue;
      const t = T(r.table_schema, r.table_name);
      if (kind === 'PRIMARY KEY') { t.pk = t.pk || { name: r.constraint_name, cols: [] }; t.pk.cols.push([+r.ordinal, r.column_name]); }
      else if (kind === 'UNIQUE' || kind === 'UNIQUE INDEX') { const u = t.uniques.get(r.constraint_name) || { name: r.constraint_name, cols: [] }; u.cols.push([+r.ordinal, r.column_name]); t.uniques.set(r.constraint_name, u); }
      else if (kind === 'FOREIGN KEY') { const f = t.fks.get(r.constraint_name) || { name: r.constraint_name, cols: [], refSchema: r.ref_schema, refTable: r.ref_table }; f.cols.push([+r.ordinal, r.column_name, r.ref_column]); t.fks.set(r.constraint_name, f); }
    }
    const order = (a) => a.sort((x, y) => x[0] - y[0]);
    return [...tables.values()].map((t) => ({
      schema: t.schema, name: t.name,
      columns: t.columns.sort((a, b) => a.ordinal - b.ordinal),
      pk: t.pk ? { name: t.pk.name, columns: order(t.pk.cols).map((x) => x[1]) } : null,
      uniques: [...t.uniques.values()].map((u) => ({ name: u.name, columns: order(u.cols).map((x) => x[1]) })),
      fks: [...t.fks.values()].map((f) => { const o = order(f.cols); return { name: f.name, columns: o.map((x) => x[1]), refSchema: f.refSchema, refTable: f.refTable, refColumns: o.map((x) => x[2]) }; }),
    }));
  }

  // Compares a parsed model with catalog rows. Matching is by schema+name, except a model table with no
  // schema (MySQL unqualified) matches by name. FKs are matched by shape (columns → target), not by name.
  function compareWithCatalog(model, rows) {
    const cat = catalogToModel(rows);
    const diffs = [];
    const catByKey = new Map(cat.map((t) => [tkey(t.schema, t.name), t]));
    const catByName = new Map(); for (const t of cat) { const k = lc(t.name); catByName.set(k, (catByName.get(k) || []).concat([t])); }
    const matched = new Set();
    const pairs = [];
    for (const t of model.tables) {
      let c = catByKey.get(tkey(t.schema, t.name));
      if (!c && !t.schema) { const cands = catByName.get(lc(t.name)) || []; if (cands.length === 1) c = cands[0]; }
      if (!c) { diffs.push({ severity: 'error', kind: 'table', message: `Table ${t.schema ? t.schema + '.' : ''}${t.name} is in the SQL model but not in the database.` }); continue; }
      matched.add(c); pairs.push([t, c]);
    }
    for (const c of cat) if (!matched.has(c)) diffs.push({ severity: 'error', kind: 'table', message: `Table ${c.schema}.${c.name} is in the database but not in the SQL model.` });
    const fkSig = (cols, refTable, refCols) => cols.map(lc).join(',') + '→' + lc(refTable) + '(' + refCols.map(lc).join(',') + ')';
    for (const [t, c] of pairs) {
      const label = t.name;
      for (const col of t.columns) {
        const cc = c.columns.find((x) => lc(x.name) === lc(col.name));
        if (!cc) diffs.push({ severity: 'error', kind: 'column', message: `${label}.${col.name} is in the SQL model but not in the database.` });
        else if (!!cc.nullable !== !!col.nullable) diffs.push({ severity: 'warning', kind: 'nullability', message: `${label}.${col.name}: model says ${col.nullable ? 'NULL' : 'NOT NULL'}, database says ${cc.nullable ? 'NULL' : 'NOT NULL'}.` });
      }
      for (const cc of c.columns) if (!t.columns.some((x) => lc(x.name) === lc(cc.name))) diffs.push({ severity: 'error', kind: 'column', message: `${label}.${cc.name} is in the database but not in the SQL model.` });
      const mp = t.pk ? t.pk.columns : [], cp = c.pk ? c.pk.columns : [];
      if (!sameCols(mp, cp)) diffs.push({ severity: 'error', kind: 'pk', message: `${label} primary key: model (${mp.join(', ') || 'none'}) vs database (${cp.join(', ') || 'none'}).` });
      const mu = t.uniques.map((u) => u.columns.map(lc).join(',')).sort(), cu = c.uniques.map((u) => u.columns.map(lc).join(',')).sort();
      for (const u of mu) if (!cu.includes(u)) diffs.push({ severity: 'error', kind: 'unique', message: `${label} unique (${u}) is in the model but not in the database.` });
      for (const u of cu) if (!mu.includes(u)) diffs.push({ severity: 'error', kind: 'unique', message: `${label} unique (${u}) is in the database but not in the model.` });
      const mf = t.fks.map((f) => fkSig(f.columns, f.refTable, f.refColumns)), cf = c.fks.map((f) => fkSig(f.columns, f.refTable, f.refColumns));
      for (const f of mf) if (!cf.includes(f)) diffs.push({ severity: 'error', kind: 'fk', message: `${label} foreign key ${f} is in the model but not in the database.` });
      for (const f of cf) if (!mf.includes(f)) diffs.push({ severity: 'error', kind: 'fk', message: `${label} foreign key ${f} is in the database but not in the model.` });
    }
    const count = (tables, f) => tables.reduce((a, t) => a + f(t), 0);
    const counts = [
      { label: 'Tables', model: model.tables.length, catalog: cat.length },
      { label: 'Columns', model: count(model.tables, (t) => t.columns.length), catalog: count(cat, (t) => t.columns.length) },
      { label: 'Primary keys', model: count(model.tables, (t) => (t.pk ? 1 : 0)), catalog: count(cat, (t) => (t.pk ? 1 : 0)) },
      { label: 'Unique keys', model: count(model.tables, (t) => t.uniques.length), catalog: count(cat, (t) => t.uniques.length) },
      { label: 'Foreign keys', model: count(model.tables, (t) => t.fks.length), catalog: count(cat, (t) => t.fks.length) },
      { label: 'FK columns', model: count(model.tables, (t) => t.fks.reduce((a, f) => a + f.columns.length, 0)), catalog: count(cat, (t) => t.fks.reduce((a, f) => a + f.columns.length, 0)) },
    ].map((c) => Object.assign(c, { ok: c.model === c.catalog }));
    return { counts, diffs, ok: counts.every((c) => c.ok) && !diffs.some((d) => d.severity === 'error'), catalogTables: cat };
  }

  // Fill keys the SQL did not declare, using catalog rows. Returns a new model; additions are marked source:'catalog'.
  function fillKeysFromCatalog(model, rows) {
    const m = clone(model);
    const cat = catalogToModel(rows);
    const added = [];
    for (const t of m.tables) {
      const c = cat.find((x) => tkey(x.schema, x.name) === tkey(t.schema, t.name)) || (!t.schema ? cat.find((x) => lc(x.name) === lc(t.name)) : null);
      if (!c) continue;
      if (!t.pk && c.pk) { t.pk = { name: c.pk.name, columns: c.pk.columns, source: 'catalog' }; added.push(`${t.name}: primary key (${c.pk.columns.join(', ')})`); }
      for (const u of c.uniques) if (!t.uniques.some((x) => sameCols(x.columns, u.columns))) { t.uniques.push({ name: u.name, columns: u.columns, source: 'catalog', where: null }); added.push(`${t.name}: unique (${u.columns.join(', ')})`); }
      for (const f of c.fks) if (!t.fks.some((x) => sameCols(x.columns, f.columns) && lc(x.refTable) === lc(f.refTable))) {
        const target = m.tables.find((x) => lc(x.name) === lc(f.refTable) && (lc(x.schema) === lc(f.refSchema) || !x.schema));
        t.fks.push({ name: f.name, columns: f.columns, refSchema: target ? target.schema : f.refSchema, refTable: target ? target.name : f.refTable, refColumns: f.refColumns, onDelete: null, onUpdate: null, source: 'catalog', unresolved: !target, disabled: false, trusted: true });
        added.push(`${t.name}: foreign key (${f.columns.join(', ')}) → ${f.refTable}`);
      }
    }
    return { model: m, added };
  }

  // ───────────────────────────── Mermaid output ─────────────────────────────
  function mermaidType(t) {
    let s = String(t || 'unknown').replace(/\s*,\s*/g, ',').replace(/\s+/g, '_').replace(/['"`]/g, '').replace(/[^\p{L}\p{N}_\-()[\],.]/gu, '_');
    if (!/^\p{L}/u.test(s)) s = 't_' + s;
    return s;
  }
  function mermaidAttrName(n) {
    let s = String(n).replace(/[^\p{L}\p{N}_-]/gu, '_');
    if (!/^[\p{L}_]/u.test(s)) s = '_' + s;
    if (/^(PK|FK|UK)$/i.test(s)) s += '_';
    return s;
  }
  const mermaidText = (s) => String(s).replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ');

  function buildView(model, opts) {
    opts = opts || {};
    const guessed = opts.showGuesses === false ? [] : guessRelationships(model);
    let tables = model.tables.filter((t) => !opts.schemas || opts.schemas.includes(t.schema || ''));
    if (opts.hideTables && opts.hideTables.length) tables = tables.filter((t) => !opts.hideTables.includes(tkey(t.schema, t.name)));
    const rels = [];
    for (const t of model.tables) for (const f of t.fks) rels.push({ from: t, fk: f, guessed: false });
    for (const g of guessed) { const t = model.tables.find((x) => lc(x.schema) === lc(g.from.schema) && lc(x.name) === lc(g.from.table)); if (t) rels.push({ from: t, fk: g, guessed: true }); }
    const findTarget = (f) => model.tables.find((x) => lc(x.name) === lc(f.refTable) && lc(x.schema) === lc(f.refSchema)) || null;
    if (opts.focus) {
      const start = model.tables.find((t) => tkey(t.schema, t.name) === opts.focus);
      if (start) {
        const depth = opts.depth == null ? 1 : opts.depth;
        const adj = new Map();
        const link = (a, b) => { if (!a || !b) return; if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set()); adj.get(a).add(b); adj.get(b).add(a); };
        for (const r of rels) link(r.from, findTarget(r.fk));
        const seen = new Set([start]); let frontier = [start];
        for (let d = 0; d < depth; d++) { const nx = []; for (const t of frontier) for (const n of adj.get(t) || []) if (!seen.has(n)) { seen.add(n); nx.push(n); } frontier = nx; }
        tables = tables.filter((t) => seen.has(t));
        if (!tables.includes(start)) tables.unshift(start);
      }
    }
    const inView = new Set(tables);
    const shown = [], hidden = [], external = new Map();
    for (const r of rels) {
      const target = findTarget(r.fk);
      if (!inView.has(r.from)) continue;
      if (!target) {
        if (r.fk.unresolved) { const k = tkey(r.fk.refSchema, r.fk.refTable); if (!external.has(k)) external.set(k, { schema: r.fk.refSchema, name: r.fk.refTable }); shown.push(Object.assign({ to: null, external: external.get(k) }, r)); }
        else hidden.push(r);
        continue;
      }
      if (!inView.has(target)) { hidden.push(r); continue; }
      shown.push(Object.assign({ to: target }, r));
    }
    return { tables, rels: shown, hiddenRels: hidden, external: [...external.values()], guessed };
  }

  function toMermaid(model, opts) {
    opts = opts || {};
    const view = buildView(model, opts);
    const multiSchema = new Set(model.tables.map((t) => t.schema || '')).size > 1;
    const qualify = opts.qualifiedNames === 'always' || (opts.qualifiedNames !== 'never' && multiSchema);
    const ids = new Map(); const used = new Set();
    const idFor = (schema, name) => {
      const k = tkey(schema, name);
      if (ids.has(k)) return ids.get(k);
      let base = ((qualify && schema ? schema + '__' : '') + name).replace(/[^\p{L}\p{N}_]/gu, '_');
      let id = base, n = 2; while (used.has(lc(id))) id = base + '_' + n++;
      used.add(lc(id)); ids.set(k, id); return id;
    };
    const label = (schema, name) => (qualify && schema ? schema + '.' : '') + name;
    const out = ['erDiagram'];
    if (opts.direction === 'LR') out.push('  direction LR');
    const fkCols = (t) => new Set(t.fks.flatMap((f) => f.columns.map(lc)));
    const guessCols = new Map();
    for (const r of view.rels) if (r.guessed) guessCols.set(tkey(r.from.schema, r.from.name) + '.' + lc(r.fk.columns[0]), r.fk.refTable);
    for (const t of view.tables) {
      const pk = new Set((t.pk ? t.pk.columns : []).map(lc));
      const fks = fkCols(t);
      const uks = new Set(t.uniques.flatMap((u) => u.columns.map(lc)));
      let cols = t.columns;
      if (opts.keysOnly) cols = cols.filter((c) => pk.has(lc(c.name)) || fks.has(lc(c.name)) || uks.has(lc(c.name)) || guessCols.has(tkey(t.schema, t.name) + '.' + lc(c.name)));
      const lbl = label(t.schema, t.name) + (t.source === 'manual' ? ' (manual)' : '');
      out.push(`  ${idFor(t.schema, t.name)}["${mermaidText(lbl)}"] {`);
      for (const c of cols) {
        const keys = [];
        if (pk.has(lc(c.name))) keys.push('PK');
        if (fks.has(lc(c.name))) keys.push('FK');
        if (uks.has(lc(c.name))) keys.push('UK');
        const nm = mermaidAttrName(c.name);
        const notes = [];
        if (nm !== c.name) notes.push('SQL name: ' + c.name);
        if (c.source === 'manual') notes.push('manual');
        if (c.alsoManual) notes.push('also added manually');
        const g = guessCols.get(tkey(t.schema, t.name) + '.' + lc(c.name));
        if (g) notes.push('guessed FK to ' + g);
        if (opts.showNullable && c.nullable) notes.push('nullable');
        if (opts.showComments && c.comment) notes.push(c.comment);
        out.push(`    ${mermaidType(c.type)} ${nm}${keys.length ? ' ' + keys.join(', ') : ''}${notes.length ? ` "${mermaidText(notes.join('; '))}"` : ''}`);
      }
      out.push('  }');
    }
    for (const e of view.external) out.push(`  ${idFor(e.schema, e.name)}["${mermaidText(label(e.schema, e.name) + ' (not in script)')}"]`);
    for (const r of view.rels) {
      const child = r.from, f = r.fk;
      const childCols = f.columns.map((cn) => child.columns.find((c) => lc(c.name) === lc(cn))).filter(Boolean);
      const optional = childCols.some((c) => c.nullable);
      const childPk = child.pk ? child.pk.columns : [];
      const isUnique = (childPk.length && sameColSet(childPk, f.columns)) || child.uniques.some((u) => sameColSet(u.columns, f.columns));
      const identifying = !r.guessed && childPk.length > 0 && f.columns.every((c) => childPk.map(lc).includes(lc(c)));
      const parentCard = optional ? '|o' : '||';
      const childCard = isUnique ? 'o|' : 'o{';
      const line = identifying ? '--' : '..';
      const parentId = r.to ? idFor(r.to.schema, r.to.name) : idFor(r.external.schema, r.external.name);
      let lbl;
      if (r.guessed) lbl = 'guess: ' + f.columns.join(', ');
      else lbl = (opts.relLabel === 'columns' || !f.name ? f.columns.join(', ') : f.name);
      if (f.source === 'manual') lbl += ' (manual)';
      if (f.source === 'catalog') lbl += ' (from catalog)';
      if (f.disabled) lbl += ' (disabled)';
      out.push(`  ${parentId} ${parentCard}${line}${childCard} ${idFor(child.schema, child.name)} : "${mermaidText(lbl)}"`);
    }
    return { text: out.join('\n') + '\n', view, ids: Object.fromEntries(ids) };
  }

  // ───────────────────────────── DDL output ─────────────────────────────
  const PG_RESERVED = new Set('all analyse analyze and any array as asc asymmetric both case cast check collate column constraint create current_catalog current_date current_role current_time current_timestamp current_user default deferrable desc distinct do else end except false fetch for foreign from grant group having in initially intersect into lateral leading limit localtime localtimestamp not null offset on only or order placing primary references returning select session_user some symmetric table then to trailing true union unique user using variadic when where window with'.split(' '));
  function quoteIdent(name, dialect) {
    if (dialect === 'tsql') return '[' + String(name).replace(/]/g, ']]') + ']';
    if (dialect === 'mysql') return '`' + String(name).replace(/`/g, '``') + '`';
    return /^[a-z_][a-z0-9_$]*$/.test(name) && !PG_RESERVED.has(name) ? name : '"' + String(name).replace(/"/g, '""') + '"';
  }
  const sqlStr = (s, dialect) => (dialect === 'tsql' ? 'N' : '') + "'" + String(s).replace(dialect === 'mysql' ? /['\\]/g : /'/g, (m) => (m === "'" ? "''" : '\\\\')) + "'";
  function qualified(t, dialect) { return (t.schema ? quoteIdent(t.schema, dialect) + '.' : '') + quoteIdent(t.name, dialect); }

  function columnDDL(c, dialect, opts) {
    opts = opts || {};
    const q = quoteIdent(c.name, dialect);
    if (c.computed && dialect === 'tsql' && c.computedExpr && !opts.portable) return `${q} AS ${c.computedExpr}`;
    let s = `${q} ${opts.portable ? 'text' : c.type || 'text'}`;
    if (!opts.portable) {
      if (c.computed && c.computedExpr) s += dialect === 'postgres' ? ` GENERATED ALWAYS AS ${c.computedExpr} STORED` : ` AS ${c.computedExpr}`;
      if (c.identity) {
        if (dialect === 'tsql') s += ' IDENTITY' + (c.identitySpec || '(1,1)');
        else if (dialect === 'postgres' && !/serial/i.test(c.type)) s += ' GENERATED BY DEFAULT AS IDENTITY';
      }
    }
    s += c.nullable ? ' NULL' : ' NOT NULL';
    if (!opts.portable && c.default != null && !c.computed) s += (dialect === 'tsql' && c.defaultName ? ` CONSTRAINT ${quoteIdent(c.defaultName, dialect)}` : '') + ' DEFAULT ' + c.default;
    if (!opts.portable && c.identity && dialect === 'mysql') s += ' AUTO_INCREMENT';
    if (!opts.portable && dialect === 'mysql' && c.comment) s += ' COMMENT ' + sqlStr(c.comment, dialect);
    return s;
  }

  function toDDL(model, dialect, opts) {
    opts = opts || {};
    dialect = dialect || model.dialect;
    const out = [];
    const sep = dialect === 'tsql' ? ';\nGO\n' : ';\n';
    const D = DIALECTS[dialect];
    const schemas = [...new Set(model.tables.map((t) => t.schema).filter((s) => s && s !== D.defaultSchema))];
    if (dialect !== 'mysql') for (const s of schemas) out.push(dialect === 'postgres' ? `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(s, dialect)}` : `CREATE SCHEMA ${quoteIdent(s, dialect)}`);
    const tables = model.tables.map((t) => (dialect === 'mysql' && opts.dropSchemaForMysql ? Object.assign({}, t, { schema: '' }) : t));
    for (const t of tables) {
      const lines = t.columns.map((c) => '  ' + columnDDL(c, dialect, opts));
      if (t.pk) lines.push('  ' + (t.pk.name ? `CONSTRAINT ${quoteIdent(t.pk.name, dialect)} ` : '') + `PRIMARY KEY (${t.pk.columns.map((c) => quoteIdent(c, dialect)).join(', ')})`);
      for (const u of t.uniques) if (u.source !== 'index') lines.push('  ' + (u.name ? `CONSTRAINT ${quoteIdent(u.name, dialect)} ` : '') + `UNIQUE (${u.columns.map((c) => quoteIdent(c, dialect)).join(', ')})`);
      let stmt = `CREATE TABLE ${qualified(t, dialect)} (\n${lines.join(',\n')}\n)`;
      if (!opts.portable && dialect === 'mysql' && t.comment) stmt += ' COMMENT=' + sqlStr(t.comment, dialect);
      out.push(stmt);
    }
    for (const t of tables) {
      for (const u of t.uniques) if (u.source === 'index') {
        let s = `CREATE UNIQUE INDEX ${quoteIdent(u.name || `ux_${t.name}_${u.columns.join('_')}`, dialect)} ON ${qualified(t, dialect)} (${u.columns.map((c) => quoteIdent(c, dialect)).join(', ')})`;
        if (u.where && !opts.portable) s += ' WHERE ' + u.where;
        out.push(s);
      }
    }
    for (const t of tables) {
      for (const f of t.fks) {
        if (opts.skipUnresolved && f.unresolved) continue;
        const ref = { schema: dialect === 'mysql' && opts.dropSchemaForMysql ? '' : f.refSchema, name: f.refTable };
        let s = `ALTER TABLE ${qualified(t, dialect)}${dialect === 'tsql' && f.trusted === false ? ' WITH NOCHECK' : ''} ADD ${f.name ? `CONSTRAINT ${quoteIdent(f.name, dialect)} ` : ''}FOREIGN KEY (${f.columns.map((c) => quoteIdent(c, dialect)).join(', ')}) REFERENCES ${qualified(ref, dialect)} (${f.refColumns.map((c) => quoteIdent(c, dialect)).join(', ')})`;
        if (f.onDelete) s += ' ON DELETE ' + f.onDelete;
        if (f.onUpdate) s += ' ON UPDATE ' + f.onUpdate;
        if (dialect === 'postgres' && f.trusted === false && !opts.portable) s += ' NOT VALID';
        out.push(s);
        if (dialect === 'tsql' && f.disabled && f.name) out.push(`ALTER TABLE ${qualified(t, dialect)} NOCHECK CONSTRAINT ${quoteIdent(f.name, dialect)}`);
      }
    }
    if (!opts.portable) {
      for (const t of tables) {
        if (dialect === 'postgres') {
          if (t.comment) out.push(`COMMENT ON TABLE ${qualified(t, dialect)} IS ${sqlStr(t.comment, dialect)}`);
          for (const c of t.columns) if (c.comment) out.push(`COMMENT ON COLUMN ${qualified(t, dialect)}.${quoteIdent(c.name, dialect)} IS ${sqlStr(c.comment, dialect)}`);
        } else if (dialect === 'tsql') {
          const ep = (val, colName) => `EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = ${sqlStr(val, dialect)}, @level0type = N'SCHEMA', @level0name = ${sqlStr(t.schema || 'dbo', dialect)}, @level1type = N'TABLE', @level1name = ${sqlStr(t.name, dialect)}` + (colName ? `, @level2type = N'COLUMN', @level2name = ${sqlStr(colName, dialect)}` : '');
          if (t.comment) out.push(ep(t.comment));
          for (const c of t.columns) if (c.comment) out.push(ep(c.comment, c.name));
        }
      }
    }
    return out.length ? out.join(sep) + sep.trimEnd() + '\n' : '';
  }

  // Manual changes → migration script. Conflicting items are listed as comments, not emitted.
  function overlayToDDL(overlay, merged, conflicts, dialect) {
    const out = [];
    const conflictIds = new Set((conflicts || []).map((c) => c.id));
    const sep = dialect === 'tsql' ? ';\nGO' : ';';
    out.push(`-- Manual changes from the Mermaid diagram builder (${DIALECTS[dialect].label})`);
    out.push('-- Review before running. Generated ' + new Date().toISOString().slice(0, 10));
    for (const t of overlay.tables || []) {
      if (conflictIds.has(t.id)) { out.push(`-- SKIPPED table ${t.name}: it already exists in the SQL.`); continue; }
      const lines = (t.columns || []).map((c) => '  ' + columnDDL(c, dialect));
      const pk = (t.columns || []).filter((c) => c.pk).map((c) => quoteIdent(c.name, dialect));
      if (pk.length) lines.push(`  PRIMARY KEY (${pk.join(', ')})`);
      out.push(`CREATE TABLE ${qualified(t, dialect)} (\n${lines.join(',\n') || '  -- add columns'}\n)${sep}`);
    }
    for (const mc of overlay.columns || []) {
      if (conflictIds.has(mc.id)) { out.push(`-- SKIPPED column ${mc.table}.${mc.column.name}: ${(conflicts.find((c) => c.id === mc.id) || {}).kind}.`); continue; }
      const t = { schema: mc.schema, name: mc.table };
      if (!mc.column.nullable && mc.column.default == null) out.push(`-- NOTE: ${mc.column.name} is NOT NULL with no DEFAULT; this fails if ${mc.table} already has rows.`);
      out.push(`ALTER TABLE ${qualified(t, dialect)} ADD ${dialect === 'tsql' ? '' : 'COLUMN '}${columnDDL(mc.column, dialect)}${sep}`);
    }
    for (const r of overlay.relationships || []) {
      if (conflictIds.has(r.id)) { out.push(`-- SKIPPED relationship ${r.table} → ${r.refTable}: ${(conflicts.find((c) => c.id === r.id) || {}).kind}.`); continue; }
      out.push(`ALTER TABLE ${qualified({ schema: r.schema, name: r.table }, dialect)} ADD ${r.name ? `CONSTRAINT ${quoteIdent(r.name, dialect)} ` : ''}FOREIGN KEY (${r.columns.map((c) => quoteIdent(c, dialect)).join(', ')}) REFERENCES ${qualified({ schema: r.refSchema, name: r.refTable }, dialect)} (${r.refColumns.map((c) => quoteIdent(c, dialect)).join(', ')})${sep}`);
    }
    return out.join('\n') + '\n';
  }

  // Canonical form used for golden files and round-trip comparison (no line numbers, logs or sources).
  function canonicalModel(model) {
    const col = (c) => {
      const o = { name: c.name, type: c.type, nullable: !!c.nullable };
      if (c.default != null) o.default = c.default;
      if (c.defaultName) o.defaultName = c.defaultName;
      if (c.identity) o.identity = true;
      if (c.computed) { o.computed = true; if (c.computedExpr) o.computedExpr = c.computedExpr; }
      if (c.comment) o.comment = c.comment;
      return o;
    };
    return {
      dialect: model.dialect,
      tables: model.tables.map((t) => ({
        schema: t.schema, name: t.name, comment: t.comment || '',
        columns: t.columns.map(col),
        pk: t.pk ? { name: t.pk.name || null, columns: t.pk.columns } : null,
        uniques: t.uniques.map((u) => ({ name: u.name || null, columns: u.columns, kind: u.source === 'index' ? 'index' : 'constraint', where: u.where || null })).sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.columns.join().localeCompare(b.columns.join())),
        fks: t.fks.map((f) => ({ name: f.name || null, columns: f.columns, refSchema: f.refSchema, refTable: f.refTable, refColumns: f.refColumns, onDelete: f.onDelete || null, onUpdate: f.onUpdate || null, disabled: !!f.disabled, trusted: f.trusted !== false })).sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.columns.join().localeCompare(b.columns.join())),
      })).sort((a, b) => tkey(a.schema, a.name).localeCompare(tkey(b.schema, b.name))),
    };
  }

  function summarize(model) {
    const by = (lvl) => model.log.filter((r) => r.status === lvl).length;
    return {
      statements: model.log.length, applied: by('applied'), partial: by('partial'), ignored: by('ignored'), unread: by('unread'),
      tables: model.tables.length, columns: model.tables.reduce((a, t) => a + t.columns.length, 0),
      fks: model.tables.reduce((a, t) => a + t.fks.length, 0),
      warnings: model.issues.length + model.log.reduce((a, r) => a + r.notes.filter((n) => n.level === 'warning').length, 0) + model.log.filter((r) => r.status === 'unread' && !r.notes.some((n) => n.level === 'warning')).length,
    };
  }

  return {
    VERSION, DIALECTS, detectDialect, scan, tokenize, parseSql, guessRelationships, emptyOverlay, applyOverlay,
    toMermaid, buildView, toDDL, overlayToDDL, canonicalModel, summarize, quoteIdent, tkey,
    CATALOG_QUERIES, CATALOG_COLUMNS, parseCatalogText, catalogToModel, compareWithCatalog, fillKeysFromCatalog,
    mermaidType, mermaidAttrName, nspFacts, crossCheck,
  };
});
