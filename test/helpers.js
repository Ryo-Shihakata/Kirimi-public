import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('./fixtures/site/', import.meta.url));
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

/** テスト用の対象サイト。/item/N → itemN.html、/public/* → エディタのJS */
export async function startSite() {
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    let file = path === '/' ? 'list1.html' : path.slice(1);
    const m = /^item\/(\d+)$/.exec(file);
    if (m) file = `item${m[1]}.html`;
    try {
      if (file.startsWith('public/')) {
        const body = await readFile(PUBLIC + file.slice(7));
        res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' });
        return res.end(body);
      }
      const body = await readFile(SITE + file);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch { res.writeHead(404); res.end('nf'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}
