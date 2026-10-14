// ページ取得。render=true なら Playwright(Chromium) でJS実行後のDOMを、false なら素のHTTP取得。
import { chromium } from 'playwright';

const USER_AGENT = process.env.KIRIMI_UA
  || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Kirimi/0.1';
const TIMEOUT_MS = 30_000;

let browserPromise = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true }).catch((e) => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  await b?.close();
}

function assertHttpUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`http(s) のURLのみ対応: ${url}`);
  return u.href;
}

/** @returns {Promise<{html: string, finalUrl: string}>} */
export async function fetchPage(url, { render = false, waitMs = 0 } = {}) {
  url = assertHttpUrl(url);
  if (!render) {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, 'accept-language': 'ja,en;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return { html: await res.text(), finalUrl: res.url || url };
  }
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'ja-JP' });
  try {
    const page = await context.newPage();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()} ${url}`);
    // networkidle にならないサイトもあるので上限付きで待つ
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    if (waitMs > 0) await page.waitForTimeout(Math.min(waitMs, 20_000));
    return { html: await page.content(), finalUrl: page.url() };
  } finally {
    await context.close();
  }
}

// エディタ用の短期キャッシュ（プレビューの度に再取得しない）
const cache = new Map();
const CACHE_TTL = 10 * 60_000;
const CACHE_MAX = 30;

export async function fetchPageCached(url, opts = {}) {
  const key = `${opts.render ? 1 : 0}|${opts.waitMs || 0}|${url}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL && !opts.refresh) return hit.value;
  const value = await fetchPage(url, opts);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return value;
}
