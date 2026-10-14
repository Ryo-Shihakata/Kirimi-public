import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createScheduler } from '../src/scheduler.js';
import { startSite } from './helpers.js';

async function setup(adminPassword, t) {
  const site = await startSite();
  const db = openDb(':memory:');
  const scheduler = createScheduler(db);
  const app = createApp({ db, scheduler, adminPassword, secret: 's' });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => { server.closeAllConnections(); server.close(); await site.close(); };
  t.after(close);
  return { site, db, scheduler, base };
}
const json = (method, body, headers = {}) => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('API作成→実行→JSON/CSV/RSSで取得', async (ctx) => {
  const t = await setup(undefined, ctx);
  const config = { url: `${t.site.base}/list1.html`, render: false, delayMs: 0,
    collections: [{ name: 'items', rowSelector: 'ul.products > li', fields: [
      { name: 'title', selector: 'a.link > h2.title', attr: 'text' }, { name: 'url', selector: 'a.link', attr: 'href' }, { name: 'price', selector: 'span.price', attr: 'text' }] }] };
  let res = await fetch(`${t.base}/api/apis`, json('POST', { name: 'x', config: { ...config, collections: [] } }));
  assert.equal(res.status, 400, '不正な設定は弾く');
  res = await fetch(`${t.base}/api/apis`, json('POST', { name: 'Shop', config, schedule: 'daily' }));
  assert.equal(res.status, 201);
  const a = await res.json();
  assert.equal((await fetch(`${t.base}/v1/${a.id}?token=${a.token}`)).status, 404, '未実行は404');
  assert.equal((await fetch(`${t.base}/api/apis/${a.id}/run`, { method: 'POST' })).status, 202);
  assert.equal((await fetch(`${t.base}/api/apis/${a.id}/run`, { method: 'POST' })).status, 409, '二重実行しない');
  while (t.scheduler.isRunning(a.id)) await new Promise((r) => setTimeout(r, 50));

  const out = await (await fetch(`${t.base}/v1/${a.id}?token=${a.token}`)).json();
  assert.equal(out.count, 3);
  assert.equal(out.results.items[1].price, '¥200');
  assert.equal((await fetch(`${t.base}/v1/${a.id}?token=wrong`)).status, 404);
  const bearer = await fetch(`${t.base}/v1/${a.id}`, { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(bearer.status, 200);
  const csvBuf = Buffer.from(await (await fetch(`${t.base}/v1/${a.id}?token=${a.token}&format=csv`)).arrayBuffer());
  assert.deepEqual([...csvBuf.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Excel向けBOM付き');
  assert.match(csvBuf.toString('utf8', 3), /^title,url,price\r\nApple,/);
  const rss = await (await fetch(`${t.base}/v1/${a.id}?token=${a.token}&format=rss`)).text();
  assert.match(rss, /<item><title>Apple<\/title><link>http:\/\/127\.0\.0\.1:\d+\/item\/1<\/link>/);
  const runs = await (await fetch(`${t.base}/api/apis/${a.id}/runs`)).json();
  assert.equal(runs[0].status, 'ok');
});

test('ADMIN_PASSWORD 設定時は管理APIに認証が必要', async (ctx) => {
  const t = await setup('pw', ctx);
  assert.equal((await fetch(`${t.base}/api/apis`)).status, 401);
  assert.equal((await fetch(`${t.base}/api/login`, json('POST', { password: 'bad' }))).status, 401);
  const ok = await fetch(`${t.base}/api/login`, json('POST', { password: 'pw' }));
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${t.base}/api/apis`, { headers: { cookie } })).status, 200);
  assert.equal((await fetch(`${t.base}/api/apis`, { headers: { cookie: 'kirimi=1.forged' } })).status, 401);
  assert.equal((await fetch(`${t.base}/detail`)).status, 200, '画面HTML自体は配信');
});
