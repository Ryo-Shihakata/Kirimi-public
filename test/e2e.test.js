// 画面操作の通し確認: エディタでクリック選択 → 次ページ → 詳細巡回 → 保存 → 実行 → 公開APIで取得
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createScheduler } from '../src/scheduler.js';
import { closeBrowser } from '../src/fetcher.js';
import { startSite } from './helpers.js';

test('エディタからAPIを作って取得する', { timeout: 90_000 }, async (t) => {
  const site = await startSite();
  const db = openDb(':memory:');
  const scheduler = createScheduler(db);
  const server = await new Promise((r) => { const s = createApp({ db, scheduler }).listen(0, '127.0.0.1', () => r(s)); });
  const app = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await closeBrowser(); server.closeAllConnections(); server.close(); await site.close(); });

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('pageerror', (e) => assert.fail(e));
  page.on('dialog', (d) => d.accept('果物ショップ'));
  await page.goto(`${app}/editor`);
  await page.fill('input[name=url]', `${site.base}/list1.html`);
  await page.uncheck('input[name=render]');
  await page.click('#urlbar button.primary');
  const frame = page.frameLocator('#frame');
  await frame.locator('h2.title').first().waitFor();

  await frame.locator('h2.title').nth(1).click();     // タイトル（＋リンクURLも自動追加）
  await frame.locator('span.price').first().click();  // 価格
  await page.waitForFunction(() => document.querySelectorAll('#preview tbody tr').length === 3);
  const preview = await page.locator('#preview tbody').innerText();
  assert.match(preview, /Apple[\s\S]*¥100[\s\S]*Cherry/);

  await page.click('#modes [data-mode=next]');
  await frame.locator('a.next').click();
  await page.waitForFunction(() => /list2\.html/.test(document.getElementById('preview')?.textContent || ''));

  await page.click('#modes [data-mode=detail]');
  await page.selectOption('#dField', 'field1_url');
  await page.click('#openDetail');
  await frame.locator('h1').waitFor();
  await frame.locator('p.desc').click();
  await page.waitForFunction(() => /説明 1/.test(document.getElementById('preview')?.textContent || ''));
  await page.screenshot({ path: 'docs/screenshot-editor.png' });

  await page.click('#save');
  await page.waitForURL(/\/detail\?id=/);
  await page.click('#run');
  await page.waitForFunction(() => /説明 4/.test(document.getElementById('data')?.textContent || ''), null, { timeout: 30_000 });
  await page.screenshot({ path: 'docs/screenshot-detail.png', fullPage: true });

  const a = db.listApis()[0];
  assert.equal(a.name, '果物ショップ');
  const out = await (await fetch(`${app}/v1/${a.id}?token=${a.token}`)).json();
  assert.equal(out.count, 4);
  assert.deepEqual(out.results.items[3], { field1: 'Durian', field1_url: `${site.base}/item/4`, field2: '¥400', _page: 2, detail1: '説明 4' });
});
