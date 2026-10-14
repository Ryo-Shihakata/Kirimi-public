import { api, ensureLogin, esc, rowsTable } from '/common.js';
import { similarSelector, uniqueSelector, relativeSelector, inferRows, mergeSelector, queryRows, queryInRow } from '/selector.js';

const frame = document.getElementById('frame');
const side = document.getElementById('side');
const urlbar = document.getElementById('urlbar');
const params = new URLSearchParams(location.search);

const state = {
  id: params.get('id'),
  name: '',
  schedule: 'manual',
  config: {
    url: params.get('url') || '',
    render: true,
    waitMs: 0,
    delayMs: 1000,
    collections: [{ name: 'items', rowSelector: '', fields: [] }],
    pagination: { selector: '', maxPages: 5 },
    detail: { collection: 'items', field: '', fields: [], max: 30 },
  },
  mode: 'list',
  active: 0,          // 編集中のコレクション
  loaded: null,       // { url, kind: 'list' | 'detail' }
  preview: null,
  status: '',
};
const doc = () => frame.contentDocument;
const col = () => state.config.collections[state.active];

// ---------- ページ読み込み ----------
async function loadPage(url, kind, refresh = false) {
  setStatus('読み込み中…（JS描画ありだと数秒かかります）');
  try {
    const { html, finalUrl } = await api('/snapshot', { method: 'POST', body: { url, render: state.config.render, waitMs: state.config.waitMs, refresh } });
    state.loaded = { url: finalUrl, kind };
    if (kind === 'list') state.config.url = finalUrl;
    await new Promise((resolve) => { frame.onload = resolve; frame.srcdoc = html; });
    attachFrame();
    setStatus('');
    await updatePreview();
  } catch (e) {
    setStatus(e.message, true);
  }
}

function attachFrame() {
  const d = doc();
  const style = d.createElement('style');
  style.textContent = `
    .__k-hover { outline: 2px solid #f97316 !important; outline-offset: 1px; cursor: crosshair !important; }
    .__k-row { outline: 1px dashed #f97316 !important; outline-offset: 2px; }
    .__k-hit { background: rgba(251,191,36,.45) !important; box-shadow: 0 0 0 1px #d97706 !important; }
    .__k-next { background: rgba(59,130,246,.35) !important; box-shadow: 0 0 0 2px #2563eb !important; }`;
  d.head.appendChild(style);
  let hovered = null;
  d.addEventListener('mouseover', (e) => { hovered?.classList.remove('__k-hover'); hovered = e.target; hovered.classList.add('__k-hover'); }, true);
  d.addEventListener('mouseout', () => { hovered?.classList.remove('__k-hover'); hovered = null; }, true);
  const block = (e) => { e.preventDefault(); e.stopPropagation(); };
  d.addEventListener('submit', block, true);
  d.addEventListener('mousedown', block, true);
  d.addEventListener('click', (e) => { block(e); onPick(e.target, e); }, true);
  highlight();
}

// ---------- クリック処理 ----------
function onPick(el, e) {
  if (!el || el === doc().body || el === doc().documentElement) return;
  // 画像・リンクの内側の細かい要素をクリックしても、意味のある単位で拾う
  if (e.altKey && el.parentElement) el = el.parentElement;
  if (state.mode === 'list') pickListField(el);
  else if (state.mode === 'next') pickNext(el);
  else pickDetailField(el);
  render();
  highlight();
  schedulePreview();
}

function defaultAttr(el) {
  if (el.tagName === 'IMG') return 'src';
  return 'text';
}
function nextFieldName(fields, base = 'field') {
  let i = 1;
  while (fields.some((f) => f.name === `${base}${i}`)) i++;
  return `${base}${i}`;
}

function addField(fields, selector, el) {
  const name = nextFieldName(fields);
  fields.push({ name, selector, attr: defaultAttr(el) });
  const a = el.closest('a');
  if (a && el.tagName !== 'IMG') fields.push({ name: `${name}_url`, selector: relSelectorFor(a, selector, el), attr: 'href' });
}
// リンクの内側をクリックした場合、href 用のセレクタはリンク要素側に寄せる
function relSelectorFor(a, selector, el) {
  if (a === el) return selector;
  const parts = selector.split(' > ');
  let n = el; let drop = 0;
  while (n && n !== a) { n = n.parentElement; drop++; }
  return n === a ? parts.slice(0, Math.max(0, parts.length - drop)).join(' > ') : selector;
}

function pickListField(el) {
  const c = col();
  const d = doc();
  if (!c.rowSelector || c.fields.length === 0) {
    const r = inferRows(el);
    c.rowSelector = r.rowSelector;
    c.fields = [];
    addField(c.fields, r.fieldSelector, el);
    setStatus(r.count > 1 ? `${r.count} 件の似た要素を検出しました。他の項目もクリックして追加できます。` : '1件だけ見つかりました。同じ種類の別の要素をクリックすると一般化します。');
    return;
  }
  const rows = queryRows(d, c.rowSelector);
  const row = rows.find((r) => r.contains(el));
  if (!row) {
    // 1件しか拾えていない状態なら、2つ目のクリックで一般化を試みる
    const first = rows[0] && queryInRow(rows[0], c.fields[0]?.selector);
    if (rows.length === 1 && first) {
      const merged = mergeSelector(first, el);
      if (merged) {
        const r = inferRows(el, merged);
        const keep = c.fields.slice(1);
        c.rowSelector = r.rowSelector;
        c.fields = [{ ...c.fields[0], selector: r.fieldSelector }, ...keep.filter((f) => queryInRow(queryRows(d, r.rowSelector)[0] || d.body, f.selector))];
        setStatus(`${r.count} 件に一般化しました。`);
        return;
      }
    }
    setStatus('選択中の行の外です。別の表を取るなら「＋コレクション」で新しく作ってください。', true);
    return;
  }
  const rel = relativeSelector(row, el);
  const idx = c.fields.findIndex((f) => f.selector === rel);
  if (idx >= 0) { c.fields.splice(idx, 1); setStatus('フィールドを外しました。'); return; }
  addField(c.fields, rel, el);
  setStatus('');
}

function pickNext(el) {
  const a = el.closest('a') || el;
  const sel = a.getAttribute('rel') === 'next' ? 'a[rel="next"]' : uniqueSelector(a);
  state.config.pagination.selector = sel;
  setStatus(`次ページ: ${sel}`);
}

function pickDetailField(el) {
  if (state.loaded?.kind !== 'detail') { setStatus('先に「詳細ページを開く」を押してください。', true); return; }
  const f = state.config.detail.fields;
  const sel = uniqueSelector(el);
  const idx = f.findIndex((x) => x.selector === sel);
  if (idx >= 0) { f.splice(idx, 1); return; }
  f.push({ name: nextFieldName(f, 'detail'), selector: sel, attr: defaultAttr(el) });
}

// ---------- ハイライト ----------
function highlight() {
  const d = doc();
  if (!d?.body) return;
  d.querySelectorAll('.__k-row, .__k-hit, .__k-next').forEach((n) => n.classList.remove('__k-row', '__k-hit', '__k-next'));
  const mark = (n, cls) => n?.classList?.add(cls);
  try {
    if (state.loaded?.kind === 'detail') {
      for (const f of state.config.detail.fields) mark(f.selector ? d.querySelector(f.selector) : null, '__k-hit');
      return;
    }
    const c = col();
    for (const row of queryRows(d, c.rowSelector)) {
      mark(row, '__k-row');
      for (const f of c.fields) if (f.selector) mark(queryInRow(row, f.selector), '__k-hit');
    }
    if (state.config.pagination.selector) mark(d.querySelector(state.config.pagination.selector), '__k-next');
  } catch { /* 手入力の不正なセレクタは無視 */ }
}

// ---------- プレビュー（サーバの抽出エンジンで実行） ----------
let previewTimer = null;
function schedulePreview() { clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 300); }
async function updatePreview() {
  if (!state.loaded) return;
  try {
    const c = state.config;
    state.preview = state.loaded.kind === 'detail'
      ? await api('/preview', { method: 'POST', body: { url: state.loaded.url, render: c.render, waitMs: c.waitMs, mode: 'detail', fields: c.detail.fields } })
      : await api('/preview', { method: 'POST', body: { url: state.loaded.url, render: c.render, waitMs: c.waitMs, collections: c.collections.filter((x) => x.rowSelector), nextSelector: c.pagination.selector } });
  } catch (e) { state.preview = { error: e.message }; }
  renderPreview();
}

// ---------- サイドパネル ----------
function setStatus(msg, isErr = false) {
  state.status = msg; state.statusErr = isErr;
  const el = side.querySelector('.status');
  if (el) { el.textContent = msg; el.className = `status ${isErr ? 'err' : ''}`; }
}

const ATTRS = ['text', 'href', 'src', 'html'];
function fieldEditor(f, i, scope) {
  const custom = !ATTRS.includes(f.attr);
  return `<div class="field" data-scope="${scope}" data-i="${i}">
    <div class="row"><input name="name" value="${esc(f.name)}" aria-label="フィールド名">
      <select name="attr">${ATTRS.map((a) => `<option ${a === f.attr ? 'selected' : ''}>${a}</option>`).join('')}<option value="__custom" ${custom ? 'selected' : ''}>属性…</option></select>
      ${custom ? `<input name="customAttr" value="${esc(f.attr)}" style="width:90px" placeholder="data-id">` : ''}
      <button class="small danger" data-act="del">×</button></div>
    <input name="selector" class="mono" value="${esc(f.selector)}" placeholder="（行そのもの）" aria-label="セレクタ">
  </div>`;
}

function render() {
  const c = state.config;
  const mode = state.mode;
  let body = '';
  if (mode === 'list') {
    body = `
      <div class="hint">ページ上の取りたい項目（タイトル・価格など）をクリック。似た要素がまとめて選ばれます。もう一度クリックで解除、Alt+クリックで親要素を選択。</div>
      <div class="row">${c.collections.map((x, i) => `<button class="small ${i === state.active ? 'primary' : ''}" data-col="${i}">${esc(x.name)}</button>`).join('')}
        <button class="small" id="addCol">＋コレクション</button></div>
      <div class="col">
        <div class="row"><input id="colName" value="${esc(col().name)}" style="flex:1" aria-label="コレクション名">
          ${c.collections.length > 1 ? '<button class="small danger" id="delCol">削除</button>' : ''}<button class="small" id="clearCol">クリア</button></div>
        <h3 style="margin-top:8px">行セレクタ</h3>
        <input id="rowSel" class="mono" value="${esc(col().rowSelector)}" style="width:100%" placeholder="最初のクリックで自動設定">
        <h3 style="margin-top:8px">フィールド</h3>
        ${col().fields.map((f, i) => fieldEditor(f, i, 'list')).join('') || '<p class="muted">まだありません</p>'}
      </div>`;
  } else if (mode === 'next') {
    body = `
      <div class="hint">ページ上の「次へ」「›」などのリンクをクリック。一覧を複数ページにわたって取得します。</div>
      <h3>次ページリンクのセレクタ</h3>
      <div class="row"><input id="nextSel" class="mono" value="${esc(c.pagination.selector)}" style="flex:1" placeholder="未設定（1ページのみ）"><button class="small" id="clearNext">解除</button></div>
      <label class="row">最大ページ数 <input type="number" id="maxPages" value="${c.pagination.maxPages}" min="1" max="100" style="width:80px"></label>
      <label class="row">ページ間の待機 <input type="number" id="delayMs" value="${c.delayMs}" min="0" step="500" style="width:90px">ms</label>`;
  } else {
    const cols = c.collections.filter((x) => x.rowSelector);
    const dcol = c.collections.find((x) => x.name === c.detail.collection) || cols[0];
    const urlFields = (dcol?.fields || []).filter((f) => f.attr === 'href');
    body = `
      <div class="hint">一覧の各行のリンク先（詳細ページ）を巡回して、追加の項目を取得します。リンク列を選んで詳細ページを開き、取りたい項目をクリック。</div>
      <label class="row">対象 <select id="dCol">${cols.map((x) => `<option ${x === dcol ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label class="row">リンク列 <select id="dField"><option value="">（詳細巡回しない）</option>${urlFields.map((f) => `<option ${f.name === c.detail.field ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <label class="row">最大件数 <input type="number" id="dMax" value="${c.detail.max}" min="1" max="500" style="width:80px"></label>
      <div class="row"><button id="openDetail" ${c.detail.field ? '' : 'disabled'}>詳細ページを開く</button><button id="backList" class="small">一覧に戻る</button></div>
      <h3>詳細フィールド</h3>
      ${c.detail.fields.map((f, i) => fieldEditor(f, i, 'detail')).join('') || '<p class="muted">まだありません</p>'}`;
  }
  side.innerHTML = `
    <p class="status ${state.statusErr ? 'err' : ''}">${esc(state.status)}</p>
    ${body}
    <div id="preview"></div>
    <div class="card" style="margin:0">
      <h3>保存</h3>
      <div class="row"><input id="apiName" value="${esc(state.name)}" placeholder="API名" style="flex:1">
      <select id="schedule">${Object.entries({ manual: '手動', '15min': '15分ごと', hourly: '1時間ごと', daily: '毎日', weekly: '毎週' }).map(([k, v]) => `<option value="${k}" ${k === state.schedule ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      <label class="row muted" style="margin-top:6px">JS描画後の待機・描画の有無は上のバーで設定</label>
    </div>`;
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  bindSide();
  renderPreview();
}

function renderPreview() {
  const box = document.getElementById('preview');
  if (!box) return;
  const p = state.preview;
  if (!p) { box.innerHTML = ''; return; }
  if (p.error) { box.innerHTML = `<p class="err">${esc(p.error)}</p>`; return; }
  if (p.detail) { box.innerHTML = `<h3>プレビュー（詳細）</h3>${rowsTable([p.detail])}`; return; }
  const rows = p.collections?.[col().name] || [];
  box.innerHTML = `<h3>プレビュー（${esc(col().name)}）</h3>${rowsTable(rows, 50)}` +
    (state.config.pagination.selector ? `<p class="muted">次ページ: ${p.next ? `<code>${esc(p.next)}</code>` : '<span class="err">見つかりません</span>'}</p>` : '');
}

function bindSide() {
  const $ = (id) => document.getElementById(id);
  const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
  const changed = () => { highlight(); schedulePreview(); };

  side.querySelectorAll('[data-col]').forEach((b) => (b.onclick = () => { state.active = Number(b.dataset.col); render(); changed(); }));
  on('addCol', 'onclick', () => {
    const names = state.config.collections.map((x) => x.name);
    let i = 2; while (names.includes(`items${i}`)) i++;
    state.config.collections.push({ name: `items${i}`, rowSelector: '', fields: [] });
    state.active = state.config.collections.length - 1; render(); changed();
  });
  on('delCol', 'onclick', () => { state.config.collections.splice(state.active, 1); state.active = 0; render(); changed(); });
  on('clearCol', 'onclick', () => { col().rowSelector = ''; col().fields = []; render(); changed(); });
  on('colName', 'onchange', (e) => {
    const old = col().name; col().name = e.target.value.trim() || old;
    if (state.config.detail.collection === old) state.config.detail.collection = col().name;
    render(); changed();
  });
  on('rowSel', 'onchange', (e) => { col().rowSelector = e.target.value.trim(); changed(); });
  on('nextSel', 'onchange', (e) => { state.config.pagination.selector = e.target.value.trim(); changed(); });
  on('clearNext', 'onclick', () => { state.config.pagination.selector = ''; render(); changed(); });
  on('maxPages', 'onchange', (e) => { state.config.pagination.maxPages = Number(e.target.value) || 1; });
  on('delayMs', 'onchange', (e) => { state.config.delayMs = Number(e.target.value) || 0; });
  on('dCol', 'onchange', (e) => { state.config.detail.collection = e.target.value; state.config.detail.field = ''; render(); });
  on('dField', 'onchange', (e) => { state.config.detail.field = e.target.value; render(); });
  on('dMax', 'onchange', (e) => { state.config.detail.max = Number(e.target.value) || 1; });
  on('openDetail', 'onclick', async () => {
    const d = state.config.detail;
    if (state.loaded?.kind !== 'list') await loadPage(state.config.url, 'list');
    const link = state.preview?.collections?.[d.collection]?.find((r) => r[d.field])?.[d.field];
    if (!link) { setStatus('プレビューにリンクがありません。', true); return; }
    await loadPage(link, 'detail');
    render();
  });
  on('backList', 'onclick', async () => { await loadPage(state.config.url, 'list'); render(); });
  on('apiName', 'oninput', (e) => { state.name = e.target.value; });
  on('schedule', 'onchange', (e) => { state.schedule = e.target.value; });

  side.querySelectorAll('.field').forEach((box) => {
    const list = box.dataset.scope === 'detail' ? state.config.detail.fields : col().fields;
    const f = list[Number(box.dataset.i)];
    box.querySelector('[name=name]').onchange = (e) => {
      const old = f.name; f.name = e.target.value.trim() || old;
      if (box.dataset.scope === 'list' && state.config.detail.field === old) state.config.detail.field = f.name;
      schedulePreview();
    };
    box.querySelector('[name=attr]').onchange = (e) => { f.attr = e.target.value === '__custom' ? 'data-id' : e.target.value; render(); schedulePreview(); };
    const ca = box.querySelector('[name=customAttr]');
    if (ca) ca.onchange = (e) => { f.attr = e.target.value.trim() || 'text'; schedulePreview(); };
    box.querySelector('[name=selector]').onchange = (e) => { f.selector = e.target.value.trim(); changed(); };
    box.querySelector('[data-act=del]').onclick = () => { list.splice(Number(box.dataset.i), 1); render(); changed(); };
  });
}

// ---------- 上部操作 ----------
document.querySelectorAll('#modes button').forEach((b) => (b.onclick = async () => {
  state.mode = b.dataset.mode;
  if (state.mode !== 'detail' && state.loaded?.kind === 'detail') await loadPage(state.config.url, 'list');
  setStatus('');
  render(); highlight();
}));

urlbar.onsubmit = async (e) => {
  e.preventDefault();
  readUrlbar();
  state.mode = state.mode === 'detail' ? 'list' : state.mode;
  render();
  await loadPage(state.config.url, 'list');
  render();
};
document.getElementById('reload').onclick = async () => {
  readUrlbar();
  if (state.config.url) { await loadPage(state.loaded?.url || state.config.url, state.loaded?.kind || 'list', true); render(); }
};
function readUrlbar() {
  state.config.url = urlbar.url.value.trim();
  state.config.render = urlbar.render.checked;
  state.config.waitMs = Number(urlbar.waitMs.value) || 0;
}
function fillUrlbar() {
  urlbar.url.value = state.config.url;
  urlbar.render.checked = state.config.render;
  urlbar.waitMs.value = state.config.waitMs;
}

document.getElementById('save').onclick = async () => {
  readUrlbar();
  if (state.loaded?.kind === 'list') state.config.url = state.loaded.url;
  if (!state.name.trim()) {
    state.name = prompt('APIの名前', new URL(state.config.url).hostname) || '';
    if (!state.name.trim()) return;
  }
  const config = structuredClone(state.config);
  config.collections = config.collections.filter((x) => x.rowSelector && x.fields.length);
  if (!config.pagination.selector) config.pagination = null;
  if (!config.detail.field || !config.detail.fields.length) config.detail = null;
  const body = { name: state.name.trim(), schedule: state.schedule, config };
  try {
    const saved = state.id
      ? await api(`/apis/${state.id}`, { method: 'PUT', body })
      : await api('/apis', { method: 'POST', body });
    location.href = `/detail?id=${saved.id}`;
  } catch (e) { setStatus(e.message, true); }
};

// ---------- 起動 ----------
if (await ensureLogin()) {
  if (state.id) {
    const a = await api(`/apis/${state.id}`);
    state.name = a.name; state.schedule = a.schedule;
    Object.assign(state.config, a.config);
    state.config.pagination ??= { selector: '', maxPages: 5 };
    state.config.detail ??= { collection: a.config.collections[0]?.name, field: '', fields: [], max: 30 };
  }
  fillUrlbar();
  render();
  if (state.config.url) { await loadPage(state.config.url, 'list'); render(); }
  else setStatus('取得したいページのURLを入力して「開く」を押してください。');
}
