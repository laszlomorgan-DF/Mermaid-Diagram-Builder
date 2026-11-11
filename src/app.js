/* UI for the SQL ER Diagram Builder. All model logic lives in core.js (window.SqlErd). */
(function () {
  'use strict';
  const E = window.SqlErd;
  const NSP = window.__NSP || {};
  const SAMPLES = window.__SAMPLES || {};
  const $ = (id) => document.getElementById(id);
  const STORE_KEY = 'sqlerd.v1';
  const lc = (s) => String(s == null ? '' : s).toLowerCase();

  const TYPE_HINTS = {
    tsql: ['int', 'bigint', 'smallint', 'tinyint', 'bit', 'decimal(18,2)', 'money', 'nvarchar(50)', 'nvarchar(255)', 'nvarchar(max)', 'varchar(255)', 'char(10)', 'date', 'datetime2(7)', 'datetimeoffset', 'uniqueidentifier', 'varbinary(max)'],
    postgres: ['integer', 'bigint', 'smallint', 'boolean', 'numeric(12,2)', 'text', 'varchar(255)', 'char(10)', 'date', 'timestamp', 'timestamptz', 'uuid', 'jsonb', 'bytea'],
    mysql: ['int', 'bigint', 'tinyint(1)', 'decimal(12,2)', 'varchar(255)', 'char(10)', 'text', 'date', 'datetime', 'timestamp', 'json', 'blob'],
  };

  const state = {
    sql: '', dialect: 'auto', fileName: '', overlay: E.emptyOverlay(),
    view: { hiddenSchemas: [], focus: '', depth: 1, showGuesses: true, keysOnly: false, showComments: false, showNullable: false, direction: 'TB', hidden: [] },
    catalogText: '', fillKeys: false, selected: null, showAllLog: false,
  };
  let base = null, merged = null, conflicts = [], lastOut = null, lastSvg = '', catalogAdded = [], renderSeq = 0, needFit = true, lastTableSig = '';
  let saveWarned = false;

  // ───────── helpers ─────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; el.append(kid instanceof Node ? kid : document.createTextNode(String(kid))); }
    return el;
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const newId = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const tkey = (t) => E.tkey(t.schema, t.name);
  const label = (t) => (t.schema ? t.schema + '.' : '') + t.name;
  function toast(msg, ms) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms || 2600); }
  function download(content, name, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function baseName() { return (state.fileName || 'diagram').replace(/\.[^.]+$/, ''); }
  const dialectNow = () => (base ? base.dialect : state.dialect === 'auto' ? E.detectDialect(state.sql || '').dialect : state.dialect);

  // ───────── persistence (per-browser convenience; projects are the durable format) ─────────
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(projectData())); }
    catch (e) { if (!saveWarned) { saveWarned = true; toast('This script is too large to auto-save in the browser. Use “Save project” to keep your work.', 5000); } }
  }
  function load() {
    try { const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); if (s) applyProject(s, true); } catch (e) { /* storage unavailable */ }
  }
  function projectData() {
    return { app: 'sql-erd-builder', version: 1, savedAt: new Date().toISOString(), sql: state.sql, dialect: state.dialect, fileName: state.fileName, overlay: state.overlay, view: state.view, catalogText: state.catalogText, fillKeys: state.fillKeys };
  }
  function applyProject(p, quiet) {
    if (!p || (p.app && p.app !== 'sql-erd-builder')) { if (!quiet) toast('That file is not a project saved by this tool.'); return false; }
    state.sql = p.sql || ''; state.dialect = p.dialect || 'auto'; state.fileName = p.fileName || '';
    state.overlay = Object.assign(E.emptyOverlay(), p.overlay || {});
    state.view = Object.assign({}, state.view, p.view || {});
    state.catalogText = p.catalogText || ''; state.fillKeys = !!p.fillKeys;
    syncInputs(); needFit = true;
    return true;
  }
  function syncInputs() {
    $('sql').value = state.sql; $('dialect').value = state.dialect; $('catalogText').value = state.catalogText; $('fillKeys').checked = state.fillKeys;
    $('optGuesses').checked = state.view.showGuesses; $('optKeysOnly').checked = state.view.keysOnly; $('optComments').checked = state.view.showComments;
    $('optNullable').checked = state.view.showNullable; $('optDirection').value = state.view.direction; $('depth').value = String(state.view.depth);
  }

  // ───────── pipeline ─────────
  function recompute(parse) {
    if (parse) {
      base = state.sql.trim() ? E.parseSql(state.sql, { dialect: state.dialect }) : null;
      scheduleCrossCheck();
    }
    let working = base;
    catalogAdded = [];
    if (base && state.fillKeys && state.catalogText.trim()) {
      const rows = E.parseCatalogText(state.catalogText).rows;
      if (rows.length) { const r = E.fillKeysFromCatalog(base, rows); working = r.model; catalogAdded = r.added; }
    }
    const empty = { version: 1, dialect: dialectNow(), schemas: [], tables: [], log: [], issues: [] };
    const r = E.applyOverlay(working || empty, state.overlay);
    merged = r.model; conflicts = r.conflicts;
    if (state.view.focus && !merged.tables.some((t) => tkey(t) === state.view.focus)) state.view.focus = '';
    const sig = merged.tables.map(tkey).join('|') + '#' + state.view.focus + '#' + state.view.depth + '#' + state.view.hiddenSchemas.join(',') + '#' + state.view.hidden.join(',') + '#' + state.view.direction + '#' + state.view.keysOnly;
    if (sig !== lastTableSig) { needFit = true; lastTableSig = sig; }
    renderAll();
    save();
  }
  const recomputeParseDebounced = debounce(() => recompute(true), 350);

  let ccTimer = null;
  function scheduleCrossCheck() {
    clearTimeout(ccTimer);
    const target = base;
    if (!target) return;
    ccTimer = setTimeout(() => {
      if (target !== base) return;
      const P = NSP[E.DIALECTS[target.dialect].nsp];
      if (!P) return;
      try { E.crossCheck(target, P, target.dialect); } catch (e) { /* cross-check is advisory */ }
      renderSummary(); renderProblems();
    }, 60);
  }

  function viewOpts() {
    const schemas = [...new Set(merged.tables.map((t) => t.schema || ''))];
    return {
      schemas: schemas.filter((s) => !state.view.hiddenSchemas.includes(s)),
      focus: state.view.focus || null, depth: +state.view.depth || 1,
      showGuesses: state.view.showGuesses, keysOnly: state.view.keysOnly, showComments: state.view.showComments,
      showNullable: state.view.showNullable, direction: state.view.direction, hideTables: state.view.hidden,
    };
  }

  function renderAll() {
    renderDialectHint(); renderSummary(); renderTypeHints(); renderSchemaChips(); renderFocusOptions(); renderTables(); renderVerify(); renderDiagram(); renderProblems();
  }

  // ───────── header / summary ─────────
  function renderDialectHint() {
    const el = $('dialectHint');
    if (!base) { el.textContent = ''; return; }
    if (state.dialect === 'auto') {
      const d = base.detected;
      el.textContent = `Detected ${E.DIALECTS[base.dialect].label}` + (d.confident ? '' : ' — not sure; pick the right one if this is wrong');
      el.className = 'hint' + (d.confident ? '' : ' warn');
    } else { el.textContent = ''; el.className = 'hint'; }
  }
  function renderSummary() {
    const el = $('parseSummary'); el.textContent = '';
    if (!base) { el.append(h('span', null, 'Nothing parsed yet.')); return; }
    const s = E.summarize(base);
    el.append(
      h('span', null, h('b', null, s.tables), ' tables'), h('span', null, h('b', null, s.columns), ' columns'), h('span', null, h('b', null, s.fks), ' foreign keys'),
      h('span', null, h('b', null, s.statements), ` statements: ${s.applied + s.partial} read`, s.partial ? ` (${s.partial} partly)` : '', `, ${s.ignored} not structural, `, h('b', { style: s.unread ? 'color:var(--err)' : '' }, s.unread), ' unread'),
    );
    const cc = base.crossCheck;
    if (cc) el.append(h('span', { title: 'node-sql-parser is a second, independent SQL parser. Where it can read a statement, its tables/columns/keys are compared with this tool\'s reading.' },
      `Cross-check: ${cc.confirmed}/${cc.checked} confirmed by node-sql-parser`, cc.disagreed ? h('b', { style: 'color:var(--err)' }, ` · ${cc.disagreed} disagree`) : '', cc.grammarFailed + cc.misread ? ` · ${cc.grammarFailed + cc.misread} it can't read` : ''));
  }
  function renderTypeHints() {
    const dl = $('typeList'); dl.textContent = '';
    for (const t of TYPE_HINTS[dialectNow()] || []) dl.append(h('option', { value: t }));
    const sl = $('schemaList'); sl.textContent = '';
    for (const s of [...new Set(merged.tables.map((t) => t.schema).filter(Boolean))]) sl.append(h('option', { value: s }));
  }

  // ───────── toolbar ─────────
  function renderSchemaChips() {
    const el = $('schemaFilter'); el.textContent = '';
    const schemas = [...new Set(merged.tables.map((t) => t.schema || ''))];
    if (schemas.length < 2) return;
    el.append(h('span', { class: 'muted', style: 'font-size:12px' }, 'Schemas'));
    for (const s of schemas) {
      const on = !state.view.hiddenSchemas.includes(s);
      el.append(h('button', { class: 'chip' + (on ? ' on' : ''), 'aria-pressed': String(on), onclick: () => {
        state.view.hiddenSchemas = on ? state.view.hiddenSchemas.concat([s]) : state.view.hiddenSchemas.filter((x) => x !== s);
        recompute(false);
      } }, s || '(no schema)'));
    }
  }
  function renderFocusOptions() {
    const sel = $('focus'); const cur = state.view.focus;
    sel.textContent = '';
    sel.append(h('option', { value: '' }, 'All tables'));
    for (const t of [...merged.tables].sort((a, b) => label(a).localeCompare(label(b)))) sel.append(h('option', { value: tkey(t) }, label(t)));
    sel.value = cur || '';
    $('depthWrap').hidden = !cur;
  }

  // ───────── diagram ─────────
  const vt = { x: 20, y: 20, k: 1 };
  function applyTransform() { $('diagram').style.transform = `translate(${vt.x}px, ${vt.y}px) scale(${vt.k})`; }
  function svgSize() {
    const svg = $('diagram').querySelector('svg'); if (!svg) return null;
    const vb = svg.viewBox && svg.viewBox.baseVal;
    return vb && vb.width ? { w: vb.width, hgt: vb.height } : { w: svg.clientWidth, hgt: svg.clientHeight };
  }
  function fit() {
    const sz = svgSize(); if (!sz) return;
    const wrap = $('diagramWrap'); const W = wrap.clientWidth, H = wrap.clientHeight;
    const k = Math.min(W / sz.w, H / sz.hgt, 1.25) * 0.94;
    vt.k = Math.max(0.05, k); vt.x = (W - sz.w * vt.k) / 2; vt.y = Math.max(8, (H - sz.hgt * vt.k) / 2);
    applyTransform();
  }
  function zoomBy(f, cx, cy) {
    const wrap = $('diagramWrap'); const r = wrap.getBoundingClientRect();
    const px = cx == null ? r.width / 2 : cx - r.left, py = cy == null ? r.height / 2 : cy - r.top;
    const k2 = Math.min(6, Math.max(0.05, vt.k * f));
    vt.x = px - (px - vt.x) * (k2 / vt.k); vt.y = py - (py - vt.y) * (k2 / vt.k); vt.k = k2; applyTransform();
  }

  let renderTimer = null;
  function renderDiagram() {
    const out = E.toMermaid(merged, viewOpts());
    lastOut = out;
    $('mermaidCode').textContent = out.text;
    const has = merged.tables.length > 0;
    $('emptyState').hidden = has;
    if (!has) { $('diagram').textContent = ''; lastSvg = ''; $('renderError').hidden = true; return; }
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => drawMermaid(out), 30);
  }
  async function drawMermaid(out) {
    const seq = ++renderSeq;
    const id = 'erd' + seq;
    try {
      const { svg } = await window.mermaid.render(id, out.text);
      if (seq !== renderSeq) return;
      const host = $('diagram');
      host.innerHTML = svg; // produced by Mermaid in strict security mode
      const el = host.querySelector('svg');
      if (el) {
        const vb = el.viewBox && el.viewBox.baseVal;
        if (vb && vb.width) { el.setAttribute('width', vb.width); el.setAttribute('height', vb.height); }
        el.style.maxWidth = 'none';
      }
      lastSvg = host.innerHTML;
      $('renderError').hidden = true;
      wireEntityClicks(out.ids);
      if (needFit) { fit(); needFit = false; } else applyTransform();
    } catch (e) {
      if (seq !== renderSeq) return;
      const stray = document.getElementById('d' + id); if (stray) stray.remove();
      $('renderError').hidden = false;
      $('renderError').textContent = 'Mermaid could not draw this diagram:\n' + String(e && e.message || e).slice(0, 600) + '\n\nThe generated text is in the Mermaid tab. Please report this — every output is meant to be valid.';
    }
  }
  function wireEntityClicks(ids) {
    const rev = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
    const svg = $('diagram').querySelector('svg'); if (!svg) return;
    for (const g of svg.querySelectorAll('g[id]')) {
      const m = /entity-(.+)-\d+$/.exec(g.id) || /^(?:[^-]+-)?(.+?)(?:-\d+)?$/.exec(g.id);
      const key = m && rev.get(m[1]);
      if (!key) continue;
      g.dataset.table = key;
    }
  }

  // pan & zoom
  (function wirePanZoom() {
    const wrap = $('diagramWrap');
    let drag = null;
    wrap.addEventListener('wheel', (e) => { if (!lastSvg) return; e.preventDefault(); zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.empty, .render-error')) return;
      drag = { x: e.clientX, y: e.clientY, vx: vt.x, vy: vt.y, moved: false };
      wrap.setPointerCapture(e.pointerId);
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; wrap.classList.add('panning'); }
      if (drag.moved) { vt.x = drag.vx + dx; vt.y = drag.vy + dy; applyTransform(); }
    });
    wrap.addEventListener('pointerup', (e) => {
      const d = drag; drag = null; wrap.classList.remove('panning');
      if (!d || d.moved) return;
      wrap.releasePointerCapture(e.pointerId);
      const hit = document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest && n.closest('[data-table]')).find(Boolean);
      if (hit) { selectTable(hit.dataset.table, true); }
    });
    wrap.addEventListener('dblclick', (e) => {
      const hit = document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest && n.closest('[data-table]')).find(Boolean);
      if (hit) { state.view.focus = hit.dataset.table; recompute(false); }
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') zoomBy(1.2); else if (e.key === '-') zoomBy(1 / 1.2); else if (e.key === '0') fit();
      else if (e.key.startsWith('Arrow')) { const s = 40; if (e.key === 'ArrowLeft') vt.x += s; if (e.key === 'ArrowRight') vt.x -= s; if (e.key === 'ArrowUp') vt.y += s; if (e.key === 'ArrowDown') vt.y -= s; applyTransform(); }
      else return;
      e.preventDefault();
    });
    $('zoomIn').onclick = () => zoomBy(1.25); $('zoomOut').onclick = () => zoomBy(0.8); $('zoomFit').onclick = fit;
    window.addEventListener('resize', debounce(() => { if (lastSvg) fit(); }, 200));
  })();

  // ───────── tables tab ─────────
  function selectTable(key, switchTab) {
    state.selected = key; renderTables();
    if (switchTab) showTab('tables');
  }
  function overlayTableFor(t) { return state.overlay.tables.find((x) => E.tkey(x.schema, x.name) === tkey(t)); }
  function findOverlayItem(id) {
    for (const t of state.overlay.tables) { if (t.id === id) return { kind: 'table', item: t }; const c = (t.columns || []).find((x) => x.id === id); if (c) return { kind: 'tablecol', item: c, table: t }; }
    const c = state.overlay.columns.find((x) => x.id === id); if (c) return { kind: 'column', item: c };
    const r = state.overlay.relationships.find((x) => x.id === id); if (r) return { kind: 'rel', item: r };
    return null;
  }
  function removeOverlayItem(id) {
    const f = findOverlayItem(id); if (!f) return;
    if (f.kind === 'table') {
      state.overlay.tables = state.overlay.tables.filter((x) => x !== f.item);
      state.overlay.relationships = state.overlay.relationships.filter((r) => !(lc(r.table) === lc(f.item.name) && lc(r.schema) === lc(f.item.schema)) && !(lc(r.refTable) === lc(f.item.name) && lc(r.refSchema) === lc(f.item.schema)));
    } else if (f.kind === 'tablecol') f.table.columns = f.table.columns.filter((x) => x !== f.item);
    else if (f.kind === 'column') state.overlay.columns = state.overlay.columns.filter((x) => x !== f.item);
    else state.overlay.relationships = state.overlay.relationships.filter((x) => x !== f.item);
    recompute(false);
  }
  function columnOverlayId(t, colName) {
    const ot = overlayTableFor(t);
    if (ot && t.source === 'manual') { const c = (ot.columns || []).find((x) => lc(x.name) === lc(colName)); if (c) return c.id; }
    const c = state.overlay.columns.find((x) => E.tkey(x.schema, x.table) === tkey(t) && lc(x.column.name) === lc(colName));
    if (c) return c.id;
    if (ot) { const c2 = (ot.columns || []).find((x) => lc(x.name) === lc(colName)); if (c2) return c2.id; }
    return null;
  }

  function renderTables() {
    $('tablesCount').textContent = merged.tables.length || '';
    const q = lc($('tableSearch').value);
    const list = $('tableList'); list.textContent = '';
    const orphanCount = conflicts.filter((c) => c.kind === 'orphan').length;
    for (const t of merged.tables) {
      if (q && !lc(label(t)).includes(q) && !t.columns.some((c) => lc(c.name).includes(q))) continue;
      const k = tkey(t);
      const manualCols = t.columns.filter((c) => c.source === 'manual').length;
      list.append(h('li', { class: state.selected === k ? 'selected' : '', role: 'option', 'aria-selected': String(state.selected === k), onclick: () => selectTable(k) },
        t.schema ? h('span', { class: 'schema' }, t.schema + '.') : null, h('span', null, t.name),
        t.source === 'manual' ? h('span', { class: 'badge manual' }, 'manual') : manualCols ? h('span', { class: 'badge manual' }, '+' + manualCols) : null,
        state.view.hidden.includes(k) ? h('span', { class: 'badge' }, 'hidden') : null,
        h('span', { class: 'count' }, t.columns.length + ' cols')));
    }
    if (orphanCount) list.append(h('li', { class: state.selected === '__orphans' ? 'selected' : '', onclick: () => selectTable('__orphans') }, h('span', { class: 'badge conflict' }, orphanCount), ' Manual items whose table is gone'));
    if (!merged.tables.length) list.append(h('li', { class: 'muted' }, 'No tables yet — parse some SQL or create one.'));
    renderTableDetail();
  }

  function renderTableDetail() {
    const box = $('tableDetail'); box.textContent = '';
    if (state.selected === '__orphans') { renderOrphans(box); return; }
    const t = merged.tables.find((x) => tkey(x) === state.selected);
    if (!t) { box.append(h('p', { class: 'muted' }, merged.tables.length ? 'Pick a table to see its columns and add your own. Tip: click a table in the diagram.' : '')); return; }
    const k = tkey(t);
    const hidden = state.view.hidden.includes(k);
    const ot = overlayTableFor(t);
    box.append(h('div', { class: 'detail-head' },
      h('h3', null, t.name), t.schema ? h('span', { class: 'badge' }, t.schema) : null,
      h('span', { class: 'badge' + (t.source === 'manual' ? ' manual' : '') }, t.source === 'manual' ? 'manual table' : 'from SQL' + (t.line ? ` · line ${t.line}` : '')),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => { state.view.focus = k; recompute(false); } }, 'Focus'),
      h('button', { class: 'btn small', onclick: () => { state.view.hidden = hidden ? state.view.hidden.filter((x) => x !== k) : state.view.hidden.concat([k]); recompute(false); } }, hidden ? 'Show in diagram' : 'Hide from diagram'),
      t.source === 'manual' && ot ? h('button', { class: 'btn small danger', onclick: () => { if (confirm(`Delete manual table ${t.name} and its links?`)) removeOverlayItem(ot.id); } }, 'Delete table') : null));
    if (t.comment) box.append(h('div', { class: 'muted' }, t.comment));
    const conflictById = new Map(conflicts.map((c) => [c.id, c]));
    if (ot && conflictById.has(ot.id)) box.append(h('div', { class: 'prob conflict' }, h('span', { class: 'lvl' }, 'conflict'), h('span'), h('span', { class: 'msg' }, conflictById.get(ot.id).message)));

    // columns grid
    const pk = new Set((t.pk ? t.pk.columns : []).map(lc));
    const fkOf = new Map(); for (const f of t.fks) for (const c of f.columns) fkOf.set(lc(c), f);
    const uk = new Set(t.uniques.flatMap((u) => u.columns.map(lc)));
    const tbody = h('tbody');
    for (const c of t.columns) {
      const manual = c.source === 'manual';
      const oid = manual ? columnOverlayId(t, c.name) : null;
      const keys = [];
      if (pk.has(lc(c.name)) && !(manual && t.source === 'manual')) keys.push(h('span', { class: 'badge key' }, 'PK'));
      const f = fkOf.get(lc(c.name));
      if (f) keys.push(h('span', { class: 'badge key' + (f.source === 'manual' ? ' manual' : f.source === 'catalog' ? ' catalog' : ''), title: (f.name || '') + (f.source && f.source !== 'sql' ? ` (${f.source})` : '') }, 'FK → ' + f.refTable));
      if (uk.has(lc(c.name))) keys.push(h('span', { class: 'badge key' }, 'UK'));
      if (c.alsoManual) {
        const dupId = columnOverlayId(t, c.name);
        keys.push(h('span', { class: 'badge conflict', title: (conflicts.find((x) => x.id === dupId) || {}).message || '' }, 'also manual'));
        if (dupId) keys.push(h('button', { class: 'btn link', onclick: () => removeOverlayItem(dupId) }, 'remove manual copy'));
      }
      if (manual && oid) {
        const f2 = findOverlayItem(oid);
        const col = f2.kind === 'column' ? f2.item.column : f2.item;
        const upd = (patch) => { Object.assign(col, patch); if (patch.name && f2.kind === 'column') { /* keep relationships pointing at renamed column */ for (const r of state.overlay.relationships) if (E.tkey(r.schema, r.table) === k) r.columns = r.columns.map((x) => (lc(x) === lc(c.name) ? patch.name : x)); } recompute(false); };
        tbody.append(h('tr', { class: 'manual' },
          h('td', null, h('input', { type: 'text', value: c.name, 'aria-label': 'Column name', onchange: (e) => { const v = e.target.value.trim(); if (!v) { e.target.value = c.name; return; } if (t.columns.some((x) => x !== c && lc(x.name) === lc(v))) { toast(`${t.name} already has a column ${v}.`); e.target.value = c.name; return; } upd({ name: v }); } })),
          h('td', null, h('input', { type: 'text', value: c.type, list: 'typeList', 'aria-label': 'Type', onchange: (e) => upd({ type: e.target.value.trim() || 'text' }) })),
          h('td', null, h('input', { type: 'checkbox', checked: c.nullable, title: 'Nullable', 'aria-label': 'Nullable', onchange: (e) => upd({ nullable: e.target.checked }) })),
          h('td', null, t.source === 'manual' ? h('label', { class: 'check', title: 'Part of primary key' }, h('input', { type: 'checkbox', checked: !!col.pk, onchange: (e) => upd({ pk: e.target.checked }) }), 'PK') : null, keys),
          h('td', null, h('button', { class: 'btn small danger', title: 'Delete this manual column', onclick: () => removeOverlayItem(oid) }, '✕'))));
      } else {
        tbody.append(h('tr', null,
          h('td', null, c.name), h('td', { class: 'mono' }, c.type), h('td', null, c.nullable ? 'null' : ''),
          h('td', null, keys, c.comment && state.view.showComments ? h('div', { class: 'muted' }, c.comment) : null), h('td')));
      }
    }
    box.append(h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, 'Column'), h('th', null, 'Type'), h('th', null, 'Null'), h('th', null, 'Keys'), h('th'))), tbody));

    // add column
    const refOptions = merged.tables.filter((x) => x.pk && x.pk.columns.length === 1).map((x) => ({ value: tkey(x), text: `${label(x)} (${x.pk.columns[0]})` }));
    const nameIn = h('input', { type: 'text', placeholder: 'e.g. LoyaltyTier', 'aria-label': 'New column name' });
    const typeIn = h('input', { type: 'text', list: 'typeList', placeholder: TYPE_HINTS[dialectNow()][0], 'aria-label': 'New column type' });
    const nullIn = h('input', { type: 'checkbox', checked: true });
    const refIn = h('select', { 'aria-label': 'References' }, h('option', { value: '' }, '— no link —'), refOptions.map((o) => h('option', { value: o.value }, o.text)));
    const err = h('div', { class: 'hint warn' });
    const add = () => {
      const name = nameIn.value.trim(), type = typeIn.value.trim() || TYPE_HINTS[dialectNow()][0];
      if (!name) { err.textContent = 'Give the column a name.'; nameIn.focus(); return; }
      if (t.columns.some((x) => lc(x.name) === lc(name))) { err.textContent = `${t.name} already has a column called ${name}.`; nameIn.focus(); return; }
      const col = { id: newId(), name, type, nullable: nullIn.checked };
      if (t.source === 'manual' && ot) ot.columns.push(col);
      else state.overlay.columns.push({ id: col.id, schema: t.schema, table: t.name, column: { name, type, nullable: nullIn.checked } });
      if (refIn.value) {
        const target = merged.tables.find((x) => tkey(x) === refIn.value);
        if (target) state.overlay.relationships.push({ id: newId(), schema: t.schema, table: t.name, columns: [name], refSchema: target.schema, refTable: target.name, refColumns: [target.pk.columns[0]], name: null });
      }
      recompute(false);
      toast(`Added ${t.name}.${name}`);
      const again = $('tableDetail').querySelector('.addcol input'); if (again) again.focus();
    };
    for (const i of [nameIn, typeIn]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    box.append(h('div', { class: 'section-title' }, 'Add a column'),
      h('div', { class: 'addcol' },
        h('label', { class: 'field' }, 'Name', nameIn), h('label', { class: 'field' }, 'Type', typeIn),
        h('label', { class: 'check', style: 'padding-bottom:5px' }, nullIn, 'Nullable'),
        h('label', { class: 'field full' }, 'Links to (optional)', refIn),
        h('div', { class: 'full row gap' }, h('button', { class: 'btn primary small', onclick: add }, 'Add column'), h('span', { class: 'muted', style: 'font-size:12px' }, 'Press Enter to add; kept separately from the SQL.')),
        h('div', { class: 'full' }, err)));

    // relationships: manual + guessed
    const rels = [];
    for (const f of t.fks) {
      if (f.source === 'manual') rels.push(h('li', null, `${f.columns.join(', ')} → ${f.refTable}(${f.refColumns.join(', ')}) `, h('span', { class: 'badge manual' }, 'manual'), ' ', h('button', { class: 'btn link', onclick: () => removeOverlayItem(f.overlayId) }, 'delete')));
    }
    const guesses = state.view.showGuesses ? E.guessRelationships(merged).filter((g) => lc(g.from.table) === lc(t.name) && lc(g.from.schema) === lc(t.schema)) : [];
    for (const g of guesses) rels.push(h('li', null, `${g.columns[0]} → ${g.refTable}(${g.refColumns[0]}) `, h('span', { class: 'badge' }, 'guess: ' + g.reason), ' ',
      h('button', { class: 'btn link', onclick: () => { state.overlay.relationships.push({ id: newId(), schema: t.schema, table: t.name, columns: g.columns.slice(), refSchema: g.refSchema, refTable: g.refTable, refColumns: g.refColumns.slice(), name: null }); recompute(false); toast('Link kept as a manual relationship.'); } }, 'make it a real link')));
    const colSel = h('select', { 'aria-label': 'Column' }, t.columns.map((c) => h('option', { value: c.name }, c.name)));
    const tgtSel = h('select', { 'aria-label': 'Target' }, refOptions.map((o) => h('option', { value: o.value }, o.text)));
    box.append(h('div', { class: 'section-title' }, 'Manual & guessed links'),
      rels.length ? h('ul', { style: 'margin:0;padding-left:18px;font-size:13px' }, rels) : h('div', { class: 'muted', style: 'font-size:13px' }, 'None.'),
      t.columns.length && refOptions.length ? h('div', { class: 'row gap wrap' }, h('span', { style: 'font-size:13px' }, 'Link'), colSel, h('span', null, '→'), tgtSel,
        h('button', { class: 'btn small', onclick: () => { const target = merged.tables.find((x) => tkey(x) === tgtSel.value); if (!target) return; state.overlay.relationships.push({ id: newId(), schema: t.schema, table: t.name, columns: [colSel.value], refSchema: target.schema, refTable: target.name, refColumns: [target.pk.columns[0]], name: null }); recompute(false); } }, 'Add link')) : null);
  }

  function renderOrphans(box) {
    box.append(h('h3', { style: 'margin:0;font-size:15px' }, 'Manual items whose table is no longer in the SQL'),
      h('p', { class: 'muted' }, 'They are kept so nothing you typed is lost. Delete them, or re-import SQL that contains the table again.'));
    for (const c of conflicts.filter((x) => x.kind === 'orphan')) box.append(h('div', { class: 'prob conflict' }, h('span', { class: 'lvl' }, 'orphan'), h('span'), h('span', { class: 'msg' }, c.message, h('div', { class: 'actions' }, h('button', { class: 'btn link', onclick: () => removeOverlayItem(c.id) }, 'delete it')))));
  }

  // ───────── verify tab ─────────
  function renderVerify() {
    const d = dialectNow();
    $('catalogDialect').textContent = 'Query for ' + E.DIALECTS[d].label;
    $('catalogQuery').textContent = E.CATALOG_QUERIES[d];
    const box = $('verifyResult'); box.textContent = '';
    if (!state.catalogText.trim()) return;
    const { rows, errors } = E.parseCatalogText(state.catalogText);
    for (const e of errors) box.append(h('div', { class: 'verdict bad' }, e));
    if (!rows.length) return;
    if (!base) { box.append(h('p', { class: 'muted' }, 'Parse some SQL first.')); return; }
    const cmp = E.compareWithCatalog(base, rows);
    box.append(h('div', { class: 'verdict ' + (cmp.ok ? 'ok' : 'bad') }, cmp.ok ? '✓ The diagram matches the database: same tables, columns and keys.' : `✗ ${cmp.diffs.filter((x) => x.severity === 'error').length} difference(s) between the SQL and the database.`));
    box.append(h('table', { class: 'verify-table' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'From SQL'), h('th', null, 'In database'))),
      h('tbody', null, cmp.counts.map((c) => h('tr', null, h('td', null, c.label), h('td', { class: c.ok ? 'ok' : 'bad' }, c.model), h('td', { class: c.ok ? 'ok' : 'bad' }, c.catalog))))));
    if (cmp.diffs.length) {
      const shown = cmp.diffs.slice(0, 300);
      box.append(h('ul', { class: 'diff-list' }, shown.map((d2) => h('li', { class: d2.severity }, d2.message))));
      if (cmp.diffs.length > shown.length) box.append(h('p', { class: 'muted' }, `…and ${cmp.diffs.length - shown.length} more.`));
    }
    const mc = state.overlay.columns.length + state.overlay.tables.length + state.overlay.relationships.length;
    if (mc) box.append(h('p', { class: 'muted' }, `Not compared: your ${mc} manual addition(s) — they are not expected to be in the database yet. Export them with Export → Manual changes as SQL.`));
    if (state.fillKeys && catalogAdded.length) box.append(h('div', { class: 'section-title' }, 'Keys taken from the catalog'), h('ul', { class: 'diff-list' }, catalogAdded.map((a) => h('li', null, a))));
  }

  // ───────── problems panel ─────────
  function goToLine(line) {
    showTab('sql');
    const ta = $('sql'); const lines = ta.value.split('\n');
    let start = 0; for (let i = 0; i < line - 1 && i < lines.length; i++) start += lines[i].length + 1;
    const end = start + (lines[line - 1] || '').length;
    ta.focus(); ta.setSelectionRange(start, end);
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, (line - 4) * lh);
  }
  function probRow(level, line, msg, snippet, actions) {
    return h('div', { class: 'prob ' + level },
      h('span', { class: 'lvl' }, level),
      line ? h('button', { class: 'btn link', onclick: () => goToLine(line), title: 'Show in SQL' }, 'line ' + line) : h('span'),
      h('span', { class: 'msg' }, msg, snippet ? h('span', { class: 'snip' }, snippet) : null, actions && actions.length ? h('div', { class: 'actions' }, actions) : null));
  }
  function renderProblems() {
    const body = $('problemsBody'); body.textContent = '';
    if (!merged) return;
    let count = 0;
    const add = (...a) => { body.append(probRow(...a)); };
    if (conflicts.length) {
      body.append(h('div', { class: 'group-title' }, 'Manual changes that need attention'));
      for (const c of conflicts) { count++; add('conflict', null, c.message, null, [h('button', { class: 'btn link', onclick: () => removeOverlayItem(c.id) }, 'delete the manual copy')]); }
    }
    if (base) {
      const unread = base.log.filter((r) => r.status === 'unread');
      if (unread.length) body.append(h('div', { class: 'group-title' }, `Statements not read (${unread.length})`));
      for (const r of unread) { count++; const w = r.notes.find((n) => n.level === 'warning'); add('warning', r.line, w ? w.message : 'Not read.', r.snippet); }
      const partial = base.log.filter((r) => r.status !== 'unread' && r.notes.some((n) => n.level === 'warning'));
      if (partial.length) body.append(h('div', { class: 'group-title' }, 'Read, with something skipped'));
      for (const r of partial) for (const n of r.notes.filter((x) => x.level === 'warning')) { count++; add('warning', r.line, n.message, r.snippet); }
      if (base.issues.length) body.append(h('div', { class: 'group-title' }, 'Model checks'));
      for (const i of base.issues) { count++; add(i.level || 'warning', i.line, i.message); }
    }
    if (lastOut) {
      const hidden = lastOut.view.hiddenRels.length;
      if (hidden || state.view.hidden.length) body.append(h('div', { class: 'group-title' }, 'Hidden by your view settings'));
      if (hidden) add('info', null, `${hidden} relationship(s) are not drawn because the table at the other end is filtered out.`, lastOut.view.hiddenRels.slice(0, 6).map((r) => `${r.from.name} → ${r.fk.refTable}`).join(', ') + (hidden > 6 ? ' …' : ''));
      if (state.view.hidden.length) add('info', null, `${state.view.hidden.length} table(s) hidden by you.`, null, [h('button', { class: 'btn link', onclick: () => { state.view.hidden = []; recompute(false); } }, 'show all')]);
    }
    if (state.showAllLog && base) {
      body.append(h('div', { class: 'group-title' }, `Every statement (${base.log.length})`));
      for (const r of base.log) {
        const lvl = r.status === 'unread' ? 'warning' : r.status === 'ignored' ? 'ignored' : r.status === 'partial' ? 'warning' : 'ok';
        const notes = r.notes.map((n) => `${n.level}: ${n.message}`).join(' · ');
        const check = r.check ? ` [cross-check: ${r.check.status}]` : '';
        add(lvl, r.line, `${r.status} · ${r.kind}${r.target ? ' ' + r.target : ''}${check}${notes ? ' — ' + notes : ''}`, r.snippet);
      }
    }
    if (!body.childNodes.length) body.append(h('div', { class: 'muted', style: 'padding:6px 4px' }, base ? 'Everything in the SQL that describes tables was read. Tick “Show every statement” to see what was skipped as non-structural.' : 'No SQL yet.'));
    $('problemsTitle').textContent = count ? `Problems (${count})` : 'Problems (none)';
  }

  // ───────── tabs, splitter, menus ─────────
  function showTab(name) {
    for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
    for (const p of document.querySelectorAll('.tabpanel')) p.classList.toggle('active', p.dataset.panel === name);
  }
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));
  (function wireSplitter() {
    const sp = $('splitter'), left = $('leftPane');
    try { const w = +localStorage.getItem('sqlerd.leftWidth'); if (w > 250) left.style.width = w + 'px'; } catch (e) { /* ignore */ }
    let on = false;
    sp.addEventListener('pointerdown', (e) => { on = true; sp.setPointerCapture(e.pointerId); });
    sp.addEventListener('pointermove', (e) => { if (on) left.style.width = Math.max(300, Math.min(window.innerWidth * 0.75, e.clientX)) + 'px'; });
    sp.addEventListener('pointerup', () => { on = false; try { localStorage.setItem('sqlerd.leftWidth', parseInt(left.style.width, 10)); } catch (e) { /* ignore */ } if (lastSvg) fit(); });
    sp.addEventListener('keydown', (e) => { const w = left.getBoundingClientRect().width; if (e.key === 'ArrowLeft') left.style.width = Math.max(300, w - 30) + 'px'; else if (e.key === 'ArrowRight') left.style.width = (w + 30) + 'px'; });
  })();

  const exportMenu = $('exportMenu');
  $('btnExport').addEventListener('click', (e) => { e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; $('btnExport').setAttribute('aria-expanded', String(!exportMenu.hidden)); });
  document.addEventListener('click', () => { exportMenu.hidden = true; $('btnExport').setAttribute('aria-expanded', 'false'); });
  exportMenu.addEventListener('click', (e) => { const b = e.target.closest('button[data-export]'); if (b) doExport(b.dataset.export); });

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) { const ta = h('textarea', { style: 'position:fixed;left:-9999px' }); ta.value = text; document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; }
  }
  function svgForExport() {
    if (!lastSvg) return null;
    let s = lastSvg;
    if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(s)) s = s.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    return s;
  }
  async function doExport(kind) {
    if (!merged || !merged.tables.length) { toast('Nothing to export yet.'); return; }
    const d = dialectNow();
    if (kind === 'mmd') download(lastOut.text, baseName() + '.mmd');
    else if (kind === 'copy') toast((await copyText(lastOut.text)) ? 'Mermaid copied to clipboard.' : 'Copy failed — use the Mermaid tab.');
    else if (kind === 'svg') { const s = svgForExport(); if (s) download(s, baseName() + '.svg', 'image/svg+xml'); else toast('The diagram has not been drawn yet.'); }
    else if (kind === 'png') {
      const s = svgForExport(); if (!s) { toast('The diagram has not been drawn yet.'); return; }
      const sz = svgSize(); const scale = Math.min(3, Math.max(1, 6000 / Math.max(sz.w, sz.hgt)));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = Math.ceil(sz.w * scale); c.height = Math.ceil(sz.hgt * scale);
        const ctx = c.getContext('2d'); ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob((b) => { if (b) download(b, baseName() + '.png'); else toast('PNG export failed; use SVG.'); }, 'image/png');
      };
      img.onerror = () => toast('PNG export failed; use SVG.');
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
    }
    else if (kind === 'json') download(JSON.stringify({ generatedBy: 'SQL ER Diagram Builder ' + E.VERSION, model: E.canonicalModel(merged), manualChanges: state.overlay, conflicts }, null, 2), baseName() + '.model.json', 'application/json');
    else if (kind === 'migration') {
      const n = state.overlay.columns.length + state.overlay.tables.length + state.overlay.relationships.length;
      if (!n) { toast('You have not added anything manually yet.'); return; }
      download(E.overlayToDDL(state.overlay, merged, conflicts, d), baseName() + '.manual-changes.sql');
    }
    else if (kind === 'ddl') download(E.toDDL(merged, d), baseName() + '.schema.sql');
  }

  // ───────── file open / drop / project ─────────
  function readFile(file) {
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result || '');
      if (/\.json$/i.test(file.name)) {
        try { if (applyProject(JSON.parse(text))) { recompute(true); toast('Project opened.'); } } catch (e) { toast('Could not read that project file: ' + e.message); }
        return;
      }
      const hadManual = state.overlay.columns.length + state.overlay.tables.length + state.overlay.relationships.length;
      state.sql = text.replace(/^﻿/, ''); state.fileName = file.name; $('sql').value = state.sql; needFit = true;
      recompute(true);
      showTab('sql');
      toast(hadManual ? `Opened ${file.name}. Your ${hadManual} manual change(s) were kept${conflicts.length ? ` — ${conflicts.length} need attention (see Problems)` : ''}.` : `Opened ${file.name}.`, 4500);
    };
    r.onerror = () => toast('Could not read ' + file.name);
    r.readAsText(file);
  }
  $('btnOpenSql').onclick = () => $('fileSql').click();
  $('btnOpenProject').onclick = () => $('fileProject').click();
  $('fileSql').onchange = (e) => { if (e.target.files[0]) readFile(e.target.files[0]); e.target.value = ''; };
  $('fileProject').onchange = (e) => { if (e.target.files[0]) readFile(e.target.files[0]); e.target.value = ''; };
  $('btnSaveProject').onclick = () => download(JSON.stringify(projectData(), null, 2), baseName() + '.erd-project.json', 'application/json');
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('btnSaveProject').click(); } });
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragover'); } });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragover'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragover'); const f = e.dataTransfer.files[0]; if (f) readFile(f); });

  // ───────── inputs ─────────
  $('sql').addEventListener('input', (e) => { state.sql = e.target.value; recomputeParseDebounced(); });
  $('sql').addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const ta = e.target; const s = ta.selectionStart; ta.setRangeText('    ', s, ta.selectionEnd, 'end'); state.sql = ta.value; recomputeParseDebounced(); }
  });
  $('dialect').onchange = (e) => { state.dialect = e.target.value; recompute(true); };
  $('focus').onchange = (e) => { state.view.focus = e.target.value; recompute(false); };
  $('depth').onchange = (e) => { state.view.depth = +e.target.value; recompute(false); };
  $('optGuesses').onchange = (e) => { state.view.showGuesses = e.target.checked; recompute(false); };
  $('optKeysOnly').onchange = (e) => { state.view.keysOnly = e.target.checked; recompute(false); };
  $('optComments').onchange = (e) => { state.view.showComments = e.target.checked; recompute(false); };
  $('optNullable').onchange = (e) => { state.view.showNullable = e.target.checked; recompute(false); };
  $('optDirection').onchange = (e) => { state.view.direction = e.target.value; recompute(false); };
  $('tableSearch').addEventListener('input', () => renderTables());
  $('catalogText').addEventListener('input', debounce((e) => { state.catalogText = e.target.value; recompute(false); }, 300));
  $('fillKeys').onchange = (e) => { state.fillKeys = e.target.checked; recompute(false); };
  $('btnCopyQuery').onclick = async () => toast((await copyText($('catalogQuery').textContent)) ? 'Query copied.' : 'Copy failed.');
  $('btnCopyMermaid').onclick = async () => toast((await copyText($('mermaidCode').textContent)) ? 'Mermaid copied.' : 'Copy failed.');
  $('showAllLog').onchange = (e) => { state.showAllLog = e.target.checked; renderProblems(); };
  $('problemsToggle').onclick = () => { const p = $('problems'); p.classList.toggle('collapsed'); $('problemsToggle').setAttribute('aria-expanded', String(!p.classList.contains('collapsed'))); };
  $('btnNewTable').onclick = () => { $('newTableForm').hidden = false; $('ntSchema').value = E.DIALECTS[dialectNow()].defaultSchema || ''; $('ntName').value = ''; $('ntName').focus(); };
  $('ntCancel').onclick = () => { $('newTableForm').hidden = true; };
  const createTable = () => {
    const schema = $('ntSchema').value.trim(), name = $('ntName').value.trim();
    if (!name) { $('ntName').focus(); return; }
    if (merged.tables.some((t) => E.tkey(t.schema, t.name) === E.tkey(schema, name))) { toast(`${schema ? schema + '.' : ''}${name} already exists.`); return; }
    const t = { id: newId(), schema, name, comment: '', columns: [{ id: newId(), name: 'Id', type: TYPE_HINTS[dialectNow()][0], nullable: false, pk: true }] };
    state.overlay.tables.push(t);
    $('newTableForm').hidden = true;
    state.selected = E.tkey(schema, name);
    recompute(false);
    toast(`Created ${name}. Add its columns below.`);
  };
  $('ntCreate').onclick = createTable;
  $('ntName').addEventListener('keydown', (e) => { if (e.key === 'Enter') createTable(); });

  // samples
  for (const [name, sql] of Object.entries(SAMPLES)) {
    $('sampleButtons').append(h('button', { class: 'btn small', onclick: () => { state.sql = sql; state.fileName = name.replace(/\W+/g, '-').toLowerCase() + '.sql'; state.dialect = 'auto'; syncInputs(); needFit = true; recompute(true); } }, name));
  }

  // ───────── start ─────────
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const initMermaid = () => window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: darkQuery && darkQuery.matches ? 'dark' : 'default', maxTextSize: 5e6, maxEdges: 20000, htmlLabels: false, er: { htmlLabels: false, useMaxWidth: false } });
  initMermaid();
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', () => { initMermaid(); if (merged) renderDiagram(); });
  load();
  syncInputs();
  recompute(true);
  window.__erdApp = { state, get merged() { return merged; }, get base() { return base; }, get conflicts() { return conflicts; }, get lastOut() { return lastOut; }, get lastSvg() { return lastSvg; }, recompute };
})();
