import test from 'node:test';
import assert from 'node:assert/strict';
import { startSite } from './helpers.js';
import { crawl } from '../src/runner.js';
import { extractCollections, findNextUrl, sanitizeForEditor } from '../src/extract.js';
import { closeBrowser } from '../src/fetcher.js';

const config = (base, extra = {}) => ({
  url: `${base}/list1.html`,
  render: false,
  delayMs: 0,
  collections: [{ name: 'items', rowSelector: 'ul.products > li', fields: [
    { name: 'title', selector: 'a.link > h2.title', attr: 'text' },
    { name: 'url', selector: 'a.link', attr: 'href' },
    { name: 'price', selector: 'span.price', attr: 'text' },
    { name: 'img', selector: 'img', attr: 'src' },
  ] }],
  ...extra,
});

test('相対セレクタは行の直下から・空行は捨てる・URLは絶対化', async () => {
  const { base, close } = await startSite();
  const html = await (await fetch(`${base}/list1.html`)).text();
  const out = extractCollections(html, `${base}/list1.html`, config(base).collections);
  assert.equal(out.items.length, 3);
  assert.deepEqual(out.items[0], { title: 'Apple', url: `${base}/item/1`, price: '¥100', img: `${base}/img/1.png` });
  assert.equal(findNextUrl(html, `${base}/list1.html`, 'a.next'), `${base}/list2.html`);
  await close();
});

test('ページ送り＋詳細巡回', async () => {
  const { base, close } = await startSite();
  const res = await crawl(config(base, {
    pagination: { selector: 'a.next', maxPages: 5 },
    detail: { collection: 'items', field: 'url', max: 10, fields: [
      { name: 'origin', selector: 'table.spec tr:nth-of-type(1) > td', attr: 'text' },
      { name: 'title', selector: 'h1', attr: 'text' },
    ] },
  }));
  assert.equal(res.rowCount, 4);
  assert.equal(res.pages, 2 + 4);
  assert.deepEqual(res.data.items.map((r) => r.title), ['Apple', 'Banana', 'Cherry', 'Durian']);
  assert.deepEqual(res.data.items.map((r) => r._page), [1, 1, 1, 2]);
  assert.equal(res.data.items[3].origin, 'place4');
  assert.equal(res.data.items[0].detail_title, 'Item 1', '衝突キーは detail_ 付き');
  await close();
});

test('maxPages で止まる・ループしない', async () => {
  const { base, close } = await startSite();
  const one = await crawl(config(base, { pagination: { selector: 'a.next', maxPages: 1 } }));
  assert.equal(one.pages, 1);
  // list2 の「前へ」を次ページ扱いにしても、既訪問URLで止まる
  const loop = await crawl(config(base, { pagination: { selector: '.pager a', maxPages: 10 } }));
  assert.equal(loop.pages, 2);
  await close();
});

test('Playwright描画モードでも取得できる', async () => {
  const { base, close } = await startSite();
  const res = await crawl(config(base, { render: true }));
  assert.equal(res.rowCount, 3);
  await closeBrowser();
  await close();
});

test('エディタ用の無害化', () => {
  const out = sanitizeForEditor('<html><head><meta http-equiv="refresh" content="0;url=x"></head><body><script>alert(1)</script><a href="javascript:x()" onclick="y()">a</a></body></html>', 'https://e.com/p');
  assert.ok(!/script|onclick|javascript:|refresh/.test(out), out);
  assert.match(out, /<base href="https:\/\/e\.com\/p">/);
});
