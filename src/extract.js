// 抽出エンジン。エディタのプレビューと定期実行の両方がこれを使う（結果の食い違いを防ぐため）。
import * as cheerio from 'cheerio';

/** 相対URLを絶対URLにする。解決できなければ元の値を返す。 */
function absolutize(value, baseUrl) {
  if (!value) return value;
  try { return new URL(value, baseUrl).href; } catch { return value; }
}

/** 1要素から field.attr に応じた値を取り出す。 */
function readValue($, el, attr, baseUrl) {
  if (!el || el.length === 0) return null;
  switch (attr || 'text') {
    case 'text': return el.text().replace(/\s+/g, ' ').trim();
    case 'html': return el.html()?.trim() ?? null;
    case 'href':
    case 'src': {
      const v = el.attr(attr) ?? el.find(`[${attr}]`).first().attr(attr);
      return v == null ? null : absolutize(v, baseUrl);
    }
    default: return el.attr(attr) ?? null;
  }
}

/**
 * 行要素からの相対セレクタで要素を探す。selector が空なら行そのもの。
 * 相対セレクタは「行の直下から」の子結合子チェーン（エディタ側の :scope > と同じ意味）。
 */
function findInRow(row, selector) {
  if (!selector) return row;
  return row.find(`> ${selector}`).first();
}

/** collections 定義に従って一覧を抽出する。 */
export function extractCollections(html, baseUrl, collections = []) {
  const $ = cheerio.load(html);
  const out = {};
  for (const col of collections) {
    const rows = [];
    if (!col.rowSelector) { out[col.name] = rows; continue; }
    $(col.rowSelector).each((_, rowEl) => {
      const row = $(rowEl);
      const obj = {};
      let filled = 0;
      for (const f of col.fields || []) {
        const v = readValue($, findInRow(row, f.selector), f.attr, baseUrl);
        obj[f.name] = v;
        if (v != null && v !== '') filled++;
      }
      // 全フィールドが空の行（区切り・広告枠など）は捨てる
      if (filled > 0) rows.push(obj);
    });
    out[col.name] = rows;
  }
  return out;
}

/** 詳細ページのように1ページ1件の値を抽出する（各セレクタの最初の一致）。 */
export function extractSingle(html, baseUrl, fields = []) {
  const $ = cheerio.load(html);
  const obj = {};
  for (const f of fields) {
    obj[f.name] = readValue($, f.selector ? $(f.selector).first() : $('body'), f.attr, baseUrl);
  }
  return obj;
}

/** 「次へ」リンクのURLを返す。見つからなければ null。 */
export function findNextUrl(html, baseUrl, selector) {
  if (!selector) return null;
  const $ = cheerio.load(html);
  const el = $(selector).first();
  if (!el.length) return null;
  const href = el.attr('href') ?? el.closest('a').attr('href') ?? el.find('a').first().attr('href');
  if (!href || href.startsWith('javascript:') || href === '#') return null;
  return absolutize(href, baseUrl);
}

/** エディタ表示用に HTML を無害化する: スクリプト・イベント属性・meta refresh を除去し <base> を入れる。 */
export function sanitizeForEditor(html, baseUrl) {
  const $ = cheerio.load(html);
  $('script, noscript, iframe, object, embed').remove();
  $('meta[http-equiv]').remove();
  $('base').remove();
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      const v = el.attribs[name];
      if (name.startsWith('on')) $(el).removeAttr(name);
      else if ((name === 'href' || name === 'src' || name === 'action') && /^\s*javascript:/i.test(v)) $(el).removeAttr(name);
    }
  });
  $('head').prepend(`<base href="${baseUrl.replace(/"/g, '&quot;')}">`);
  return $.html();
}

/** AIエージェントがセレクタを考えるための縮約HTML（スクリプト・スタイル・SVG・コメントを除き、空白を詰める） */
export function compactHtml(html, maxChars = 60_000) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, link, meta, template').remove();
  $('*').contents().filter((_, n) => n.type === 'comment').remove();
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      if (!['id', 'class', 'href', 'src', 'alt', 'title', 'rel', 'datetime'].includes(name) && !name.startsWith('data-')) $(el).removeAttr(name);
    }
  });
  const out = ($('body').html() || '').replace(/\s+/g, ' ').replace(/> </g, '>\n<');
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n<!-- …${out.length - maxChars}文字省略 -->` : out;
}
