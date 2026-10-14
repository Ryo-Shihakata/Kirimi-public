// MCP サーバを子プロセスで起動し、ツール経由で 作成→実行→取得 できるか
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createScheduler } from '../src/scheduler.js';
import { startSite } from './helpers.js';

test('MCPツールでAPIを作って取得', { timeout: 60_000 }, async (t) => {
  const site = await startSite();
  const db = openDb(':memory:');
  const server = await new Promise((r) => { const s = createApp({ db, scheduler: createScheduler(db), adminPassword: 'pw', secret: 's' }).listen(0, '127.0.0.1', () => r(s)); });
  const client = new Client({ name: 't', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/mcp.js'],
    env: { ...process.env, KIRIMI_URL: `http://127.0.0.1:${server.address().port}`, KIRIMI_PASSWORD: 'pw' } }));
  t.after(async () => { await client.close(); server.closeAllConnections(); server.close(); await site.close(); });
  const callJson = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content[0].text);
    try { return JSON.parse(r.content[0].text); } catch { return r.content[0].text; }
  };

  const tools = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(tools.includes('kirimi_create_api') && tools.includes('kirimi_fetch_page'));
  assert.match(await callJson('kirimi_fetch_page', { url: `${site.base}/list1.html` }), /class="product featured"/);

  const collections = [{ name: 'items', rowSelector: 'ul.products > li', fields: [{ name: 'title', selector: 'a.link > h2.title', attr: 'text' }, { name: 'url', selector: 'a.link', attr: 'href' }] }];
  const pv = await callJson('kirimi_preview', { url: `${site.base}/list1.html`, collections, nextSelector: 'a.next' });
  assert.equal(pv.collections.items.total, 3);
  assert.equal(pv.next, `${site.base}/list2.html`);

  const created = await callJson('kirimi_create_api', { name: 'Shop', config: { url: `${site.base}/list1.html`, delayMs: 0, collections, pagination: { selector: 'a.next', maxPages: 3 } } });
  const run = await callJson('kirimi_run_api', { id: created.id });
  assert.equal(run.status, 'ok');
  const data = await callJson('kirimi_get_data', { id: created.id, limit: 2 });
  assert.equal(data.data.items.total, 4);
  assert.equal(data.data.items.rows.length, 2);
  assert.equal((await callJson('kirimi_list_apis', {}))[0].last_rows, 4);
});
