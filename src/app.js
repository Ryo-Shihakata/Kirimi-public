import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchPageCached } from './fetcher.js';
import { extractCollections, extractSingle, findNextUrl, sanitizeForEditor, compactHtml } from './extract.js';
import { validateConfig } from './runner.js';
import { SCHEDULES } from './scheduler.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

// ---- 認証（管理画面用。ADMIN_PASSWORD 未設定なら認証なし） ----
function makeAuth(password, secret) {
  const sign = (v) => createHmac('sha256', secret).update(v).digest('base64url');
  const cookieValue = () => { const exp = String(Date.now() + 30 * 864e5); return `${exp}.${sign(exp)}`; };
  const valid = (raw) => {
    if (!raw) return false;
    const [exp, sig] = raw.split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const a = Buffer.from(sig), b = Buffer.from(sign(exp));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const readCookie = (req) => /(?:^|;\s*)kirimi=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  return {
    enabled: !!password,
    check(pw) {
      const a = Buffer.from(String(pw || '')), b = Buffer.from(password);
      return a.length === b.length && timingSafeEqual(a, b);
    },
    setCookie(res) {
      res.setHeader('Set-Cookie', `kirimi=${cookieValue()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}`);
    },
    isAuthed: (req) => !password || valid(readCookie(req)),
    required(req, res, next) {
      if (!password || valid(readCookie(req))) return next();
      res.status(401).json({ error: 'unauthorized' });
    },
  };
}

// ---- 出力形式 ----
function toCsv(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

const xmlEsc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

function toRss(api, rows, run) {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const titleKey = keys.find((k) => /title|name|タイトル|名前/i.test(k)) || keys[0];
  const linkKey = keys.find((k) => rows.some((r) => /^https?:/.test(r[k] || '')));
  const items = rows.map((r) => `<item><title>${xmlEsc(r[titleKey])}</title>${linkKey ? `<link>${xmlEsc(r[linkKey])}</link><guid>${xmlEsc(r[linkKey])}</guid>` : ''}<description>${xmlEsc(keys.map((k) => `${k}: ${r[k] ?? ''}`).join('\n'))}</description></item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${xmlEsc(api.name)}</title><link>${xmlEsc(api.config.url)}</link><description>Kirimi</description><lastBuildDate>${new Date(run.finished_at).toUTCString()}</lastBuildDate>${items}</channel></rss>`;
}

function publicApi(api, scheduler) {
  return { ...api, running: scheduler.isRunning(api.id) };
}

export function createApp({ db, scheduler, adminPassword = process.env.ADMIN_PASSWORD, secret = process.env.SESSION_SECRET || adminPassword || 'dev' }) {
  const app = express();
  const auth = makeAuth(adminPassword, secret);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // ---- 公開API（トークン認証） ----
  app.get('/v1/:id', (req, res) => {
    const api = db.getApi(req.params.id);
    const token = req.query.token || req.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!api || token !== api.token) return res.status(404).json({ error: 'not found' });
    const run = req.query.run ? db.getRun(Number(req.query.run)) : db.latestOkRun(api.id);
    if (!run || run.api_id !== api.id || run.status !== 'ok') return res.status(404).json({ error: 'まだ成功した実行がありません' });
    const format = req.query.format || 'json';
    const colName = req.query.collection || api.config.collections[0]?.name;
    res.set('Access-Control-Allow-Origin', '*');
    if (format === 'json') {
      return res.json({ name: api.name, source: api.config.url, run: run.id, lastSuccess: new Date(run.finished_at).toISOString(), count: run.row_count, results: run.data });
    }
    const rows = run.data?.[colName];
    if (!rows) return res.status(404).json({ error: `collection が見つかりません: ${colName}` });
    if (format === 'csv') {
      res.type('text/csv; charset=utf-8').set('Content-Disposition', `inline; filename="${api.id}-${colName}.csv"`);
      return res.send(toCsv(rows));
    }
    if (format === 'rss') return res.type('application/rss+xml; charset=utf-8').send(toRss(api, rows, run));
    res.status(400).json({ error: 'format は json / csv / rss' });
  });

  // ---- ログイン ----
  app.get('/api/session', (req, res) => {
    res.json({ authed: auth.isAuthed(req), authEnabled: auth.enabled });
  });
  app.post('/api/login', (req, res) => {
    if (!auth.enabled) return res.json({ ok: true });
    if (!auth.check(req.body?.password)) return res.status(401).json({ error: 'パスワードが違います' });
    auth.setCookie(res);
    res.json({ ok: true });
  });
  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'kirimi=; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  // ---- 管理API ----
  const admin = express.Router();
  admin.use(auth.required);
  const wrapAsync = (fn) => (req, res) => fn(req, res).catch((e) => res.status(400).json({ error: String(e.message || e) }));

  admin.get('/apis', (req, res) => res.json(db.listApis().map((a) => publicApi(a, scheduler))));
  admin.get('/apis/:id', (req, res) => {
    const api = db.getApi(req.params.id);
    api ? res.json(publicApi(api, scheduler)) : res.status(404).json({ error: 'not found' });
  });
  const checkBody = (b) => {
    const errs = validateConfig(b.config);
    if (!b.name?.trim()) errs.unshift('名前が必要です');
    if (b.schedule && !(b.schedule in SCHEDULES)) errs.push('schedule が不正です');
    return errs;
  };
  admin.post('/apis', (req, res) => {
    const errs = checkBody(req.body || {});
    if (errs.length) return res.status(400).json({ error: errs.join(' / ') });
    res.status(201).json(db.createApi(req.body));
  });
  admin.put('/apis/:id', (req, res) => {
    const errs = checkBody(req.body || {});
    if (errs.length) return res.status(400).json({ error: errs.join(' / ') });
    const api = db.updateApi(req.params.id, req.body);
    api ? res.json(api) : res.status(404).json({ error: 'not found' });
  });
  admin.delete('/apis/:id', (req, res) => res.json({ ok: db.deleteApi(req.params.id) }));
  admin.post('/apis/:id/token', (req, res) => res.json(db.rotateToken(req.params.id)));
  admin.post('/apis/:id/run', (req, res) => {
    if (!db.getApi(req.params.id)) return res.status(404).json({ error: 'not found' });
    if (scheduler.isRunning(req.params.id)) return res.status(409).json({ error: '実行中です' });
    scheduler.runApi(req.params.id).catch(() => {});
    res.status(202).json({ ok: true });
  });
  admin.get('/apis/:id/runs', (req, res) => res.json(db.listRuns(req.params.id)));
  admin.get('/runs/:runId', (req, res) => {
    const run = db.getRun(Number(req.params.runId));
    run ? res.json(run) : res.status(404).json({ error: 'not found' });
  });

  // エディタ: ページを取得して無害化したHTMLを返す
  admin.post('/snapshot', wrapAsync(async (req, res) => {
    const { url, render, waitMs, refresh } = req.body || {};
    const { html, finalUrl } = await fetchPageCached(url, { render, waitMs, refresh });
    res.json({ finalUrl, html: sanitizeForEditor(html, finalUrl) });
  }));

  // エディタ: 本番と同じ抽出エンジンでプレビュー（キャッシュ済みスナップショットに対して）
  admin.post('/preview', wrapAsync(async (req, res) => {
    const { url, render, waitMs, mode, collections, fields, nextSelector } = req.body || {};
    const { html, finalUrl } = await fetchPageCached(url, { render, waitMs });
    if (mode === 'detail') return res.json({ detail: extractSingle(html, finalUrl, fields || []) });
    res.json({
      collections: extractCollections(html, finalUrl, collections || []),
      next: nextSelector ? findNextUrl(html, finalUrl, nextSelector) : null,
    });
  }));

  // AIエージェント用: セレクタ設計のための縮約HTML
  admin.post('/page', wrapAsync(async (req, res) => {
    const { url, render, waitMs, refresh, maxChars } = req.body || {};
    const { html, finalUrl } = await fetchPageCached(url, { render, waitMs, refresh });
    res.json({ finalUrl, html: compactHtml(html, maxChars) });
  }));

  app.use('/api', admin);
  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  return app;
}
