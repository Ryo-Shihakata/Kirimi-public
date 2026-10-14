// エディタ（ブラウザ）で作ったセレクタを、サーバ（cheerio）の抽出に渡して同じ結果になるかを確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startSite } from './helpers.js';
import { extractCollections, findNextUrl } from '../src/extract.js';

test('クリック→行推定→サーバ抽出が一致', async (t) => {
  const { base, close } = await startSite();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await close(); });
  const page = await browser.newPage();
  await page.goto(`${base}/list1.html`);
  const sel = await page.evaluate(async (base) => {
    const s = await import(`${base}/public/selector.js`);
    const title = document.querySelectorAll('h2.title')[1]; // featured の行をクリック
    const r = s.inferRows(title);
    const row = title.closest('li');
    return {
      ...r,
      price: s.relativeSelector(row, row.querySelector('.price')),
      link: s.relativeSelector(row, row.querySelector('a')),
      next: s.uniqueSelector(document.querySelector('a.next')),
      rowsInBrowser: s.queryRows(document, r.rowSelector).length,
    };
  }, base);
  assert.equal(sel.count, 3, JSON.stringify(sel));
  const html = await (await fetch(`${base}/list1.html`)).text();
  const out = extractCollections(html, base, [{ name: 'x', rowSelector: sel.rowSelector, fields: [
    { name: 'title', selector: sel.fieldSelector, attr: 'text' },
    { name: 'price', selector: sel.price, attr: 'text' },
    { name: 'url', selector: sel.link, attr: 'href' },
  ] }]);
  assert.deepEqual(out.x.map((r) => r.title), ['Apple', 'Banana', 'Cherry']);
  assert.deepEqual(out.x.map((r) => r.price), ['¥100', '¥200', '¥300']);
  assert.equal(out.x[2].url, `${base}/item/3`);
  assert.equal(findNextUrl(html, base, sel.next), `${base}/list2.html`);

  // 1件しか拾えない構造でも、2つ目のクリックで一般化できる
  await page.setContent('<div><section class="a"><p>one</p></section><section class="b"><p>two</p></section><section class="c"><p>three</p></section></div>');
  const merged = await page.evaluate(async (base) => {
    const s = await import(`${base}/public/selector.js`);
    const ps = document.querySelectorAll('p');
    const first = s.inferRows(ps[0]);
    const m = s.mergeSelector(ps[0], ps[1]);
    return { firstCount: first.count, merged: s.inferRows(ps[1], m).count };
  }, base);
  assert.equal(merged.firstCount, 1);
  assert.equal(merged.merged, 3);
});
