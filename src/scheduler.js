// 定期実行と、手動実行を含む実行の一元管理（同一APIの二重実行を防ぐ）。
import { crawl } from './runner.js';

export const SCHEDULES = {
  manual: null,
  '15min': 15 * 60_000,
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

export function createScheduler(db, { crawlFn = crawl, tickMs = 60_000 } = {}) {
  const running = new Set();
  let timer = null;

  async function runApi(apiId) {
    if (running.has(apiId)) throw new Error('実行中です');
    const api = db.getApi(apiId);
    if (!api) throw new Error('APIが見つかりません');
    running.add(apiId);
    const runId = db.startRun(apiId);
    try {
      const { data, pages, rowCount } = await crawlFn(api.config, { log: (m) => console.log(`[${apiId}#${runId}] ${m}`) });
      db.finishRun(runId, { status: 'ok', pages, rowCount, data });
    } catch (e) {
      console.error(`[${apiId}#${runId}]`, e);
      db.finishRun(runId, { status: 'error', error: String(e.message || e) });
    } finally {
      running.delete(apiId);
    }
    return db.getRun(runId);
  }

  function tick() {
    const now = Date.now();
    for (const api of db.listApis()) {
      const interval = SCHEDULES[api.schedule];
      if (!interval || running.has(api.id)) continue;
      if (!api.last_run_at || now - api.last_run_at >= interval) {
        runApi(api.id).catch(() => {});
      }
    }
  }

  return {
    runApi,
    isRunning: (id) => running.has(id),
    start() { timer ??= setInterval(tick, tickMs); tick(); },
    stop() { clearInterval(timer); timer = null; },
  };
}
