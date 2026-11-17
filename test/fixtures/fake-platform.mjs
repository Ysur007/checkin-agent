/**
 * 仅用于本地联调的假平台：https://127.0.0.1:9443
 * 不连接任何真实服务；用来验证「浏览器登录 → Cookie 捕获 → 真实 HTTP 签到 → 复核」链路。
 *
 * 用法：
 *   openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=127.0.0.1" \
 *     -keyout /tmp/fake-platform/key.pem -out /tmp/fake-platform/cert.pem
 *   CERT_FILE=/tmp/fake-platform/cert.pem KEY_FILE=/tmp/fake-platform/key.pem node test/fixtures/fake-platform.mjs
 */
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';

const port = Number(process.env.PORT || 9443);
const certFile = process.env.CERT_FILE;
const keyFile = process.env.KEY_FILE;
if (!certFile || !keyFile) {
  console.error('CERT_FILE and KEY_FILE are required');
  process.exit(1);
}

const sessions = new Map();

function stateFor(token) {
  if (!sessions.has(token)) {
    sessions.set(token, { balance: 500, checked: false, createdAt: Date.now() });
  }
  return sessions.get(token);
}

function cookieToken(req) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)demo_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const loginPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demo Provider · 登录</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f5f5f4;
    font:14px/1.5 -apple-system,"Segoe UI","Noto Sans SC",sans-serif; color:#18181b; }
  .card { width:380px; padding:28px; background:#fff; border:1px solid #e4e4e7; border-radius:14px;
    box-shadow:0 20px 50px -30px rgba(0,0,0,.25); }
  .logo { width:38px; height:38px; border-radius:10px; background:#18181b; color:#fff; display:grid;
    place-items:center; font-weight:700; margin-bottom:16px; }
  h1 { margin:0 0 4px; font-size:19px; letter-spacing:-.02em; }
  p.sub { margin:0 0 20px; color:#71717a; font-size:12px; }
  label { display:block; font-size:12px; color:#3f3f46; margin-bottom:6px; }
  input { width:100%; height:38px; padding:0 11px; margin-bottom:13px; border:1px solid #d4d4d8;
    border-radius:8px; font-size:13px; }
  button { width:100%; height:42px; margin-top:6px; border:0; border-radius:8px; background:#18181b;
    color:#fff; font-size:13px; font-weight:600; cursor:pointer; }
  .tip { margin-top:14px; font-size:11px; color:#a1a1aa; text-align:center; }
</style></head>
<body>
  <form class="card" method="post" action="/api/login">
    <div class="logo">D</div>
    <h1>Demo Provider</h1>
    <p class="sub">本地联调平台 · 不会连接任何真实账号</p>
    <label for="u">账号</label>
    <input id="u" name="username" value="demo" autocomplete="username">
    <label for="p">密码</label>
    <input id="p" name="password" type="password" value="demo1234" autocomplete="current-password">
    <button type="submit">登录并继续</button>
    <div class="tip">测试账号 demo / demo1234</div>
  </form>
</body></html>`;

const appPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Demo Provider · 已登录</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f5f5f4;
    font:14px/1.6 -apple-system,"Segoe UI","Noto Sans SC",sans-serif; color:#18181b; }
  .box { text-align:center; padding:36px 44px; background:#fff; border:1px solid #e4e4e7; border-radius:14px; }
  .ok { width:44px; height:44px; border-radius:50%; background:#e9f5ef; color:#16794f; display:grid;
    place-items:center; margin:0 auto 14px; font-size:22px; }
  h1 { margin:0 0 6px; font-size:18px; }
  p { margin:0; color:#71717a; font-size:12px; }
</style></head>
<body><div class="box"><div class="ok">✓</div><h1>已登录 Demo Provider</h1>
<p>这个窗口可以关闭了，Cookie 已经被执行台捕获。</p></div></body></html>`;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = https.createServer(
  { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
  (req, res) => {
    const url = new URL(req.url ?? '/', 'https://127.0.0.1');
    const token = cookieToken(req);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/login')) {
      if (token) {
        res.writeHead(302, { location: '/app', 'cache-control': 'no-store' });
        return res.end();
      }
      return send(res, 200, loginPage);
    }

    if (req.method === 'POST' && url.pathname === '/api/login') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 10_000) req.destroy();
      });
      req.on('end', () => {
        const params = new URLSearchParams(raw);
        if (params.get('username') !== 'demo' || params.get('password') !== 'demo1234') {
          return send(res, 401, '<p>账号或密码不正确</p>');
        }
        const next = crypto.randomBytes(18).toString('base64url');
        stateFor(next);
        res.writeHead(302, {
          location: '/app',
          'set-cookie': `demo_session=${next}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`,
          'cache-control': 'no-store',
        });
        res.end();
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/app') {
      if (!token) {
        res.writeHead(302, { location: '/login' });
        return res.end();
      }
      return send(res, 200, appPage);
    }

    if (req.method === 'GET' && url.pathname === '/api/summary') {
      if (!token) return json(res, 401, { ok: false, code: 'AUTH_REQUIRED' });
      const state = stateFor(token);
      return json(res, 200, {
        balance: state.balance,
        checked_today: state.checked,
        available: !state.checked,
        amount: 100,
        next_reset_at: new Date(Date.now() + 12 * 3600_000).toISOString(),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/checkin') {
      if (!token) return json(res, 401, { ok: false, code: 'AUTH_REQUIRED' });
      const state = stateFor(token);
      if (state.checked) return json(res, 200, { claimed: false, code: 'ALREADY_CLAIMED', balance: state.balance });
      state.checked = true;
      state.balance += 100;
      return json(res, 200, { claimed: true, credits_issued: 100, balance: state.balance });
    }

    if (url.pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    return send(res, 404, 'not found');
  },
);

server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`fake platform listening on https://127.0.0.1:${port}`);
});
