// Minimal static server for local testing: node pipeline/serve.mjs web 8765
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const [root, port] = [path.resolve(process.argv[2] || 'web'), +(process.argv[3] || 8765)];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream', '.csv': 'text/csv' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p); if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(d); });
}).listen(port, () => console.log('serving', root, 'on', port));
