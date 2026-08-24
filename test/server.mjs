// Diffuzz 本地靶机：验收用，node test/server.mjs [端口]
// 端点：
//   GET /login                    设置会话 Cookie
//   GET /api/user/:id             id 1000-1099 -> 200 user；1337 -> 200 admin（正文异常）；1 -> 302；其余 404
//   GET /api/secure               需登录 Cookie，否则 302
//   GET /api/echo?x=..            响应含每次变化的时间戳与 CSRF token（验收归一化）
//   GET /api/slow?ms=3000         固定延迟（验收耗时信号）
//   GET /api/ratelimit            第 11 个请求起 429（验收自动暂停）

import { createServer } from 'node:http';

const port = Number(process.argv[2]) || 8787;
let rlCount = 0;

const server = createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(u.pathname);

  if (path === '/login') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'set-cookie': 'session=dffz_demo_session; Path=/; HttpOnly',
    });
    return res.end('logged in');
  }

  if (path.startsWith('/api/user/')) {
    const id = path.split('/').pop();
    if (!/^\d+$/.test(id)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad id' }));
    }
    if (id === '1') {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    if (id === '1337') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 1337, name: 'root', role: 'admin', secret: 'FLAG{diffuzz_anomaly_found}', note: 'this response is intentionally much longer than the normal user profile so that both length and simhash signals fire' }));
    }
    const n = Number(id);
    if (n >= 1000 && n <= 1099) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: n, name: 'user' + n, role: 'user' }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'not found' }));
  }

  if (path === '/api/secure') {
    const cookie = req.headers.cookie || '';
    if (!cookie.includes('session=')) {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, data: 'secured content' }));
  }

  if (path === '/api/echo') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      echo: u.searchParams.get('x') || '',
      ts: Date.now(),
      csrf_token: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      stable: 'this-part-never-changes',
    }));
  }

  if (path === '/api/slow') {
    const ms = Math.min(10000, Number(u.searchParams.get('ms')) || 3000);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ slow: true, ms }));
    }, ms);
    return;
  }

  if (path === '/api/ratelimit') {
    rlCount++;
    if (rlCount > 10) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
      return res.end(JSON.stringify({ error: 'rate limited', count: rlCount }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, count: rlCount }));
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Diffuzz 靶机</title><p>Diffuzz test target is running.</p><ul>
    <li><a href="/login">/login</a> 设置会话</li>
    <li><a href="/api/user/1001">/api/user/1001</a>（1337=IDOR 异常，1=302，其余 404）</li>
    <li><a href="/api/secure">/api/secure</a>（需登录）</li>
    <li><a href="/api/echo">/api/echo</a>（噪声）</li></ul>`);
});

server.listen(port, () => {
  console.log(`Diffuzz 靶机已启动: http://127.0.0.1:${port}`);
});
