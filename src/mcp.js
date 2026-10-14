#!/usr/bin/env node
// Claude Code などから Kirimi を操作する MCP サーバ（stdio）。動いている Kirimi の管理APIを叩く。
//   KIRIMI_URL      既定 http://127.0.0.1:8790
//   KIRIMI_PASSWORD 管理パスワード（未設定なら ../.env の ADMIN_PASSWORD）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';

// KIRIMI_PASSWORD が無ければ、同じリポの .env の ADMIN_PASSWORD を使う（設定ファイルに秘密を書かずに済む）
function envFilePassword() {
  try {
    const txt = readFileSync(new URL('../.env', import.meta.url), 'utf8');
    return /^ADMIN_PASSWORD=(.*)$/m.exec(txt)?.[1].trim().replace(/^["']|["']$/g, '') || '';
  } catch { return ''; }
}

const BASE = (process.env.KIRIMI_URL || 'http://127.0.0.1:8790').replace(/\/$/, '');
const PASSWORD = process.env.KIRIMI_PASSWORD || envFilePassword();
let cookie = '';

async function call(path, { method = 'GET', body } = {}, retry = true) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry && PASSWORD) {
    const login = await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    if (!login.ok) throw new Error('Kirimi へのログインに失敗（KIRIMI_PASSWORD を確認）');
    cookie = login.headers.get('set-cookie').split(';')[0];
    return call(path, { method, body }, false);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const ok = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] });
const tool = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const field = z.object({
  name: z.string(),
  selector: z.string().describe('一覧: 行の直下からの子結合子チェーン（例 "a.link > h2"、""で行そのもの）。詳細: ページ全体に対するCSSセレクタ（最初の一致）'),
  attr: z.string().default('text').describe('text / href / src / html / 任意の属性名'),
});
const collection = z.object({
  name: z.string(),
  rowSelector: z.string().describe('1行（1件）にあたる要素のCSSセレクタ'),
  fields: z.array(field),
});
const configSchema = z.object({
  url: z.string().url(),
  render: z.boolean().default(false).describe('JSで描画するサイトなら true（Playwright）'),
  waitMs: z.number().int().min(0).max(20000).default(0),
  delayMs: z.number().int().min(0).default(1000).describe('ページ間の待機'),
  collections: z.array(collection).min(1),
  pagination: z.object({ selector: z.string(), maxPages: z.number().int().min(1).max(100) }).nullish(),
  detail: z.object({ collection: z.string(), field: z.string().describe('リンク（href）列の名前'), fields: z.array(field), max: z.number().int().min(1).max(500).default(30) }).nullish(),
});
const schedule = z.enum(['manual', '15min', 'hourly', 'daily', 'weekly']);

const server = new McpServer({ name: 'kirimi', version: '0.1.0' }, {
  instructions: `Kirimi はWebページをスクレイピングしてJSON/CSV/RSSのAPIにするセルフホストツール（${BASE}）。
新しいAPIを作る手順: kirimi_fetch_page で縮約HTMLを見てセレクタを考える → kirimi_preview で抽出結果を確認して直す → kirimi_create_api で保存 → kirimi_run_api で実行 → kirimi_get_data で取得。
一覧の field.selector は「行の直下から」の相対セレクタ（cheerio の find('> sel') と同じ意味）。利用規約と robots.txt を守ること。`,
});

server.registerTool('kirimi_list_apis', { description: '登録済みAPIの一覧（名前・URL・頻度・最終実行・件数）', inputSchema: {} },
  tool(async () => (await call('/apis')).map((a) => ({
    id: a.id, name: a.name, url: a.config.url, schedule: a.schedule, running: a.running,
    last_run_at: a.last_run_at && new Date(a.last_run_at).toISOString(), last_status: a.last_status, last_rows: a.last_rows,
    collections: a.config.collections.map((c) => c.name),
  }))));

server.registerTool('kirimi_get_api', { description: 'APIの設定・トークン・公開エンドポイント・直近の実行履歴', inputSchema: { id: z.string() } },
  tool(async ({ id }) => {
    const a = await call(`/apis/${id}`);
    const runs = await call(`/apis/${id}/runs`);
    return { ...a, endpoint: `${BASE}/v1/${a.id}?token=${a.token}`, runs: runs.slice(0, 10) };
  }));

server.registerTool('kirimi_get_data', {
  description: '最新の成功した実行（または指定の実行）の取得データ',
  inputSchema: { id: z.string(), run: z.number().int().optional(), collection: z.string().optional(), limit: z.number().int().min(1).default(100) },
}, tool(async ({ id, run, collection, limit }) => {
  const runId = run ?? (await call(`/apis/${id}/runs`)).find((r) => r.status === 'ok')?.id;
  if (!runId) throw new Error('成功した実行がまだありません。kirimi_run_api を先に');
  const r = await call(`/runs/${runId}`);
  const data = Object.fromEntries(Object.entries(r.data || {}).filter(([k]) => !collection || k === collection)
    .map(([k, rows]) => [k, { total: rows.length, rows: rows.slice(0, limit) }]));
  return { run: r.id, finished_at: new Date(r.finished_at).toISOString(), data };
}));

server.registerTool('kirimi_run_api', {
  description: 'APIを今すぐ実行する。wait=true なら終わるまで待って結果の要約を返す',
  inputSchema: { id: z.string(), wait: z.boolean().default(true), timeoutSec: z.number().int().default(300) },
}, tool(async ({ id, wait, timeoutSec }) => {
  await call(`/apis/${id}/run`, { method: 'POST' });
  if (!wait) return '実行を開始しました';
  const until = Date.now() + timeoutSec * 1000;
  await sleep(500);
  while (Date.now() < until) {
    const [r] = await call(`/apis/${id}/runs`);
    if (r && r.status !== 'running') return r;
    await sleep(2000);
  }
  return 'まだ実行中です（kirimi_get_api で確認）';
}));

server.registerTool('kirimi_fetch_page', {
  description: 'ページを取得し、セレクタ設計用の縮約HTML（script/style除去・主要属性のみ）を返す',
  inputSchema: { url: z.string().url(), render: z.boolean().default(false), waitMs: z.number().int().default(0), maxChars: z.number().int().default(40000), refresh: z.boolean().default(false) },
}, tool(async (args) => {
  const r = await call('/page', { method: 'POST', body: args });
  return `finalUrl: ${r.finalUrl}\n\n${r.html}`;
}));

server.registerTool('kirimi_preview', {
  description: '保存せずに抽出を試す。collections を渡すと一覧抽出（nextSelector で次ページURLも確認）、fields を渡すと詳細ページとして1件抽出',
  inputSchema: {
    url: z.string().url(), render: z.boolean().default(false), waitMs: z.number().int().default(0),
    collections: z.array(collection).optional(), nextSelector: z.string().optional(), fields: z.array(field).optional(),
    limit: z.number().int().default(20),
  },
}, tool(async ({ limit, ...args }) => {
  const r = await call('/preview', { method: 'POST', body: { ...args, mode: args.fields ? 'detail' : 'list' } });
  if (r.collections) for (const k of Object.keys(r.collections)) r.collections[k] = { total: r.collections[k].length, rows: r.collections[k].slice(0, limit) };
  return r;
}));

server.registerTool('kirimi_create_api', {
  description: 'APIを保存する（作成）。保存後 kirimi_run_api で実行すること',
  inputSchema: { name: z.string(), schedule: schedule.default('manual'), config: configSchema },
}, tool(async (body) => {
  const a = await call('/apis', { method: 'POST', body });
  return { id: a.id, endpoint: `${BASE}/v1/${a.id}?token=${a.token}`, editor: `${BASE}/editor?id=${a.id}` };
}));

server.registerTool('kirimi_update_api', {
  description: 'APIの名前・頻度・設定を更新する（省略した項目は現状維持）',
  inputSchema: { id: z.string(), name: z.string().optional(), schedule: schedule.optional(), config: configSchema.optional() },
}, tool(async ({ id, ...patch }) => {
  const cur = await call(`/apis/${id}`);
  const a = await call(`/apis/${id}`, { method: 'PUT', body: { name: patch.name ?? cur.name, schedule: patch.schedule ?? cur.schedule, config: patch.config ?? cur.config } });
  return { id: a.id, name: a.name, schedule: a.schedule };
}));

server.registerTool('kirimi_delete_api', { description: 'APIと実行履歴を削除する（取り消し不可）', inputSchema: { id: z.string() } },
  tool(async ({ id }) => call(`/apis/${id}`, { method: 'DELETE' })));

await server.connect(new StdioServerTransport());
