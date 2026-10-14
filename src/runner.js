// 1回のクロール: 一覧ページ（＋ページ送り）→ 必要なら各行の詳細ページを巡回してマージ。
import { fetchPage } from './fetcher.js';
import { extractCollections, extractSingle, findNextUrl } from './extract.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_PAGES_LIMIT = 100;
const MAX_DETAIL_LIMIT = 500;

/**
 * @param {object} config API定義
 * @param {{fetch?: typeof fetchPage, log?: (msg: string) => void}} deps
 * @returns {Promise<{data: object, pages: number, rowCount: number}>}
 */
export async function crawl(config, { fetch = fetchPage, log = () => {} } = {}) {
  const opts = { render: !!config.render, waitMs: config.waitMs || 0 };
  const delay = Math.max(0, config.delayMs ?? 1000);
  const maxPages = Math.min(Math.max(1, config.pagination?.maxPages || 1), MAX_PAGES_LIMIT);
  const collections = config.collections || [];

  const data = Object.fromEntries(collections.map((c) => [c.name, []]));
  const seen = new Set();
  let url = config.url;
  let pages = 0;

  while (url && pages < maxPages && !seen.has(url)) {
    seen.add(url);
    if (pages > 0) await sleep(delay);
    log(`一覧 ${pages + 1}: ${url}`);
    const { html, finalUrl } = await fetch(url, opts);
    pages++;
    const got = extractCollections(html, finalUrl, collections);
    for (const [name, rows] of Object.entries(got)) {
      data[name].push(...rows.map((r) => (pages > 1 || config.pagination?.selector ? { ...r, _page: pages } : r)));
    }
    url = config.pagination?.selector ? findNextUrl(html, finalUrl, config.pagination.selector) : null;
  }

  const d = config.detail;
  if (d?.collection && d?.field && d.fields?.length && data[d.collection]) {
    const rows = data[d.collection];
    const limit = Math.min(d.max || 50, MAX_DETAIL_LIMIT);
    let n = 0;
    for (const row of rows) {
      if (n >= limit) break;
      const link = row[d.field];
      if (!link || !/^https?:/i.test(link)) continue;
      if (n > 0) await sleep(delay);
      n++;
      log(`詳細 ${n}: ${link}`);
      try {
        const { html, finalUrl } = await fetch(link, opts);
        pages++;
        Object.assign(row, prefixKeys(extractSingle(html, finalUrl, d.fields), row));
      } catch (e) {
        row._detail_error = String(e.message || e);
      }
    }
  }

  const rowCount = Object.values(data).reduce((s, rows) => s + rows.length, 0);
  return { data, pages, rowCount };
}

/** 詳細側のキーが一覧側と衝突したら detail_ を付ける */
function prefixKeys(obj, existing) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k in existing ? `detail_${k}` : k] = v;
  return out;
}

/** 設定の最低限の妥当性チェック。問題があればメッセージ配列を返す。 */
export function validateConfig(c) {
  const errs = [];
  if (!c || typeof c !== 'object') return ['config がありません'];
  try { new URL(c.url); } catch { errs.push('url が不正です'); }
  if (!Array.isArray(c.collections) || c.collections.length === 0) errs.push('コレクションが1つ以上必要です');
  const names = new Set();
  for (const col of c.collections || []) {
    if (!col.name) errs.push('コレクション名が空です');
    if (names.has(col.name)) errs.push(`コレクション名が重複: ${col.name}`);
    names.add(col.name);
    if (!col.rowSelector) errs.push(`${col.name}: 行セレクタがありません`);
    if (!col.fields?.length) errs.push(`${col.name}: フィールドがありません`);
    const fnames = new Set();
    for (const f of col.fields || []) {
      if (!f.name) errs.push(`${col.name}: フィールド名が空です`);
      if (fnames.has(f.name)) errs.push(`${col.name}: フィールド名が重複: ${f.name}`);
      fnames.add(f.name);
    }
  }
  if (c.detail?.collection && !names.has(c.detail.collection)) errs.push('詳細巡回の対象コレクションがありません');
  return errs;
}
