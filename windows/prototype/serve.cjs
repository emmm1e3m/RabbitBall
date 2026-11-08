const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const clients = new Set();
const root = __dirname;
const reload = '<script>(()=>{const s=new EventSource("/__reload");s.onmessage=()=>location.reload();s.onerror=()=>s.close();})()</script>';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  const file = url.pathname === '/' ? path.join(root, 'index.html') : path.resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404); res.end('Not found'); return; }
    const extension = path.extname(file);
    res.writeHead(200, { 'Content-Type': (mime[extension] || 'application/octet-stream') + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(extension === '.html' ? data.toString().replace('</body>', reload + '</body>') : data);
  });
});

// 热更新只用于本地预览，独立 HTML 不依赖此服务。
let pending;
const watcher = fs.watch(root, (_, name) => {
  if (!name || !/\.(html|js|svg)$/.test(name)) return;
  clearTimeout(pending);
  pending = setTimeout(() => clients.forEach(client => client.write('data: reload\n\n')), 150);
});
server.on('close', () => watcher.close());
server.listen(8674, '127.0.0.1', () => console.log('Local: http://127.0.0.1:8674/'));
