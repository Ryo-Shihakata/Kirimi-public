// クリックされた要素から「似た要素」を拾うセレクタを作る。ブラウザDOM上で動く純粋関数群。
// 生成するセレクタは cheerio(css-select) でも同じ意味になるもの（タグ・クラス・:nth-of-type・子結合子）に限る。

const IDENT = /^-?[a-zA-Z_][\w-]*$/;
const OWN = /^__k-/; // エディタが付けるハイライト用クラス

function cssEscape(s) { return globalThis.CSS?.escape ? CSS.escape(s) : s; }

/** 要素1つ分の汎用セグメント（タグ＋安定していそうなクラス） */
export function segment(el, { nth = false, classes } = {}) {
  const tag = el.tagName.toLowerCase();
  const cls = (classes ?? [...el.classList]).filter((c) => IDENT.test(c) && !OWN.test(c) && !/\d{3,}/.test(c));
  let s = tag + cls.map((c) => `.${cssEscape(c)}`).join('');
  if (nth && el.parentElement) {
    const same = [...el.parentElement.children].filter((c) => c.tagName === el.tagName);
    if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return s;
}

/** el から ancestor（含まない）までの要素列（上から順）。ancestor 省略時は body まで。 */
export function chain(el, ancestor) {
  const stop = ancestor ?? el.ownerDocument.body;
  const out = [];
  for (let n = el; n && n !== stop; n = n.parentElement) out.unshift(n);
  return out;
}

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const qsa = (root, sel) => { try { return [...root.querySelectorAll(sel)]; } catch { return []; } };

/** 末尾から短くしていき、full と同じ集合を指す最短の子結合子チェーンを返す */
function minimize(doc, segs) {
  const full = 'body > ' + segs.join(' > ');
  const target = qsa(doc, full);
  for (let k = 1; k <= segs.length; k++) {
    const sel = segs.slice(-k).join(' > ');
    if (sameSet(qsa(doc, sel), target)) return sel;
  }
  return full;
}

/**
 * 「似た要素」用のクラス選び。同じタグの兄弟と共有しているクラスだけ残す
 * （li.product.featured をクリックしても li.product 全体を拾うため）。
 * 共有クラスが1つもなければ、意図的に区別された要素とみなして全クラスを残す。
 */
function sharedClasses(n) {
  const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c !== n && c.tagName === n.tagName) : [];
  const own = [...n.classList];
  const shared = own.filter((c) => sibs.some((s) => s.classList.contains(c)));
  return shared.length ? shared : own;
}

/** el と同じ構造の要素すべてにマッチする絶対セレクタ */
export function similarSelector(el) {
  return minimize(el.ownerDocument, chain(el).map((n) => segment(n, { classes: sharedClasses(n) })));
}

/** el だけを指す（最初の一致が el になる）セレクタ */
export function uniqueSelector(el) {
  const doc = el.ownerDocument;
  const sim = similarSelector(el);
  if (qsa(doc, sim)[0] === el && qsa(doc, sim).length === 1) return sim;
  if (el.id && IDENT.test(el.id) && !/\d{3,}/.test(el.id)) return `#${cssEscape(el.id)}`;
  return minimizeTo(doc, chain(el).map((n) => segment(n, { nth: true })), el);
}

function minimizeTo(doc, segs, el) {
  for (let k = 1; k <= segs.length; k++) {
    const sel = segs.slice(-k).join(' > ');
    const m = qsa(doc, sel);
    if (m.length === 1 && m[0] === el) return sel;
  }
  return 'body > ' + segs.join(' > ');
}

/** 行要素 row から el への相対セレクタ（row 直下からのチェーン。row 自身なら ''） */
export function relativeSelector(row, el) {
  if (row === el) return '';
  return chain(el, row).map((n) => segment(n)).join(' > ');
}

export function queryRows(doc, rowSelector) { return rowSelector ? qsa(doc, rowSelector) : []; }
export function queryInRow(row, rel) { return rel ? row.querySelector(`:scope > ${rel}`) : row; }

/**
 * 1つ目のフィールドから「行」を推定する。
 * 似た要素集合 matches について、el から祖先へ登り、別の一致を含み始める直前の祖先を行とする。
 * @returns {{rowSelector: string, fieldSelector: string, count: number}}
 */
export function inferRows(el, matchSelector = similarSelector(el)) {
  const doc = el.ownerDocument;
  const matches = qsa(doc, matchSelector);
  let row = el;
  let depth = 0;
  if (matches.length > 1) {
    while (row.parentElement && row.parentElement !== doc.body) {
      const p = row.parentElement;
      if (matches.filter((m) => p.contains(m)).length > 1) break;
      row = p; depth++;
    }
  }
  let rowSelector;
  if (matches.length > 1) {
    // 各一致から同じ段数だけ登った要素群をまとめて表すセレクタにする
    const rows = [...new Set(matches.map((m) => { let r = m; for (let i = 0; i < depth && r; i++) r = r.parentElement; return r; }))];
    rowSelector = mergeSelector(...rows) ?? similarSelector(row);
  } else {
    rowSelector = uniqueSelector(row);
  }
  return { rowSelector, fieldSelector: relativeSelector(row, el), count: qsa(doc, rowSelector).length };
}

/**
 * 複数の要素から共通の汎用セレクタを作る（1件しか拾えなかったとき、2つ目のクリックで一般化する）。
 * 深さが同じで各段のタグが一致する必要がある。クラスは共通部分だけ残す。
 */
export function mergeSelector(...els) {
  els = els.filter(Boolean);
  if (!els.length) return null;
  const chains = els.map((e) => chain(e));
  const len = chains[0].length;
  if (chains.some((c) => c.length !== len)) return null;
  const segs = [];
  for (let i = 0; i < len; i++) {
    const level = chains.map((c) => c[i]);
    if (level.some((n) => n.tagName !== level[0].tagName)) return null;
    const common = [...level[0].classList].filter((c) => level.every((n) => n.classList.contains(c)));
    segs.push(segment(level[0], { classes: common }));
  }
  return minimize(els[0].ownerDocument, segs);
}
