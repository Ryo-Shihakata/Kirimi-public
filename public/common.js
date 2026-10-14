// 管理画面共通: fetch ラッパーとログイン
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('ログインが必要です'); }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function ensureLogin() {
  const s = await api('/session');
  if (!s.authed) { showLogin(); return false; }
  return true;
}

function showLogin() {
  if (document.getElementById('login')) return;
  document.body.innerHTML = `
    <form id="login" class="card">
      <h2 style="margin-top:0">Kiri<span style="color:var(--accent)">mi</span></h2>
      <p class="muted">管理パスワードを入力</p>
      <div class="row"><input type="password" name="password" autofocus style="flex:1"><button class="primary">ログイン</button></div>
      <p class="err status"></p>
    </form>`;
  document.getElementById('login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: { password: e.target.password.value } });
      location.reload();
    } catch (err) { e.target.querySelector('.status').textContent = err.message; }
  };
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtTime = (t) => (t ? new Date(t).toLocaleString('ja-JP') : '—');

/** 行配列をテーブルHTMLにする */
export function rowsTable(rows, limit = 200) {
  if (!rows?.length) return '<p class="muted">0 件</p>';
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const body = rows.slice(0, limit).map((r) => `<tr>${cols.map((c) => `<td title="${esc(r[c])}">${esc(r[c])}</td>`).join('')}</tr>`).join('');
  return `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>
    ${rows.length > limit ? `<p class="muted">先頭 ${limit} / ${rows.length} 件を表示</p>` : `<p class="muted">${rows.length} 件</p>`}`;
}
