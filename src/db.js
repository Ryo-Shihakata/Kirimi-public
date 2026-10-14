import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS apis (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      schedule TEXT NOT NULL DEFAULT 'manual',
      token TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_id TEXT NOT NULL REFERENCES apis(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      status TEXT NOT NULL,
      pages INTEGER NOT NULL DEFAULT 0,
      row_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_api ON runs(api_id, id DESC);
  `);
  return wrap(db);
}

const newId = () => randomBytes(5).toString('hex');
const newToken = () => randomBytes(18).toString('base64url');
const KEEP_RUNS = Number(process.env.KIRIMI_KEEP_RUNS || 50);

function rowToApi(r) {
  return r && { ...r, config: JSON.parse(r.config) };
}
function rowToRun(r, withData = false) {
  if (!r) return r;
  const { data, ...rest } = r;
  return withData ? { ...rest, data: data ? JSON.parse(data) : null } : rest;
}

function wrap(db) {
  return {
    raw: db,
    listApis() {
      return db.prepare(`SELECT a.*, (SELECT status FROM runs WHERE api_id=a.id ORDER BY id DESC LIMIT 1) AS last_status,
        (SELECT row_count FROM runs WHERE api_id=a.id AND status='ok' ORDER BY id DESC LIMIT 1) AS last_rows
        FROM apis a ORDER BY updated_at DESC`).all().map(rowToApi);
    },
    getApi(id) { return rowToApi(db.prepare('SELECT * FROM apis WHERE id=?').get(id)); },
    createApi({ name, config, schedule = 'manual' }) {
      const now = Date.now();
      const id = newId();
      db.prepare('INSERT INTO apis (id,name,config,schedule,token,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, name, JSON.stringify(config), schedule, newToken(), now, now);
      return this.getApi(id);
    },
    updateApi(id, { name, config, schedule }) {
      const cur = this.getApi(id);
      if (!cur) return null;
      db.prepare('UPDATE apis SET name=?, config=?, schedule=?, updated_at=? WHERE id=?')
        .run(name ?? cur.name, JSON.stringify(config ?? cur.config), schedule ?? cur.schedule, Date.now(), id);
      return this.getApi(id);
    },
    rotateToken(id) {
      db.prepare('UPDATE apis SET token=? WHERE id=?').run(newToken(), id);
      return this.getApi(id);
    },
    deleteApi(id) { return db.prepare('DELETE FROM apis WHERE id=?').run(id).changes > 0; },

    startRun(apiId) {
      const now = Date.now();
      db.prepare('UPDATE apis SET last_run_at=? WHERE id=?').run(now, apiId);
      return db.prepare("INSERT INTO runs (api_id, started_at, status) VALUES (?,?,'running')").run(apiId, now).lastInsertRowid;
    },
    finishRun(runId, { status, pages = 0, rowCount = 0, error = null, data = null }) {
      db.prepare('UPDATE runs SET finished_at=?, status=?, pages=?, row_count=?, error=?, data=? WHERE id=?')
        .run(Date.now(), status, pages, rowCount, error, data && JSON.stringify(data), runId);
      const apiId = db.prepare('SELECT api_id FROM runs WHERE id=?').get(runId)?.api_id;
      if (apiId) {
        db.prepare(`DELETE FROM runs WHERE api_id=? AND id NOT IN (SELECT id FROM runs WHERE api_id=? ORDER BY id DESC LIMIT ?)`)
          .run(apiId, apiId, KEEP_RUNS);
      }
    },
    /** 再起動で中断された実行を失敗扱いにする */
    failStaleRuns() {
      db.prepare("UPDATE runs SET status='error', error='サーバ再起動で中断', finished_at=? WHERE status='running'").run(Date.now());
    },
    listRuns(apiId, limit = 30) {
      return db.prepare('SELECT * FROM runs WHERE api_id=? ORDER BY id DESC LIMIT ?').all(apiId, limit).map((r) => rowToRun(r));
    },
    getRun(runId) { return rowToRun(db.prepare('SELECT * FROM runs WHERE id=?').get(runId), true); },
    latestOkRun(apiId) {
      return rowToRun(db.prepare("SELECT * FROM runs WHERE api_id=? AND status='ok' ORDER BY id DESC LIMIT 1").get(apiId), true);
    },
  };
}
