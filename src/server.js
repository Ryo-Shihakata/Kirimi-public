import { openDb } from './db.js';
import { createApp } from './app.js';
import { createScheduler } from './scheduler.js';
import { closeBrowser } from './fetcher.js';

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '0.0.0.0';
const db = openDb(process.env.KIRIMI_DB || 'data/kirimi.db');
db.failStaleRuns();

const scheduler = createScheduler(db);
const app = createApp({ db, scheduler });

if (!process.env.ADMIN_PASSWORD) {
  console.warn('[kirimi] ADMIN_PASSWORD 未設定: 管理画面は認証なしで開きます。信頼できるネットワーク内だけで使ってください。');
}

const server = app.listen(PORT, HOST, () => {
  console.log(`[kirimi] http://${HOST}:${PORT}`);
  scheduler.start();
});

async function shutdown() {
  scheduler.stop();
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
