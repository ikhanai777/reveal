#!/usr/bin/env node
//
// Minimal static server for local use.
//
//   node tools/serve.mjs [PORT]        # default 8080
//
// The app is built from ES modules, so it must be served over HTTP — opening
// index.html as a file:// URL fails on module loading and CORS. Any static
// server works; this one exists so the repo has no dependencies at all.
//
// It binds to localhost only. Nothing here is hardened for exposure to a
// network.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(ROOT, rel);
  // Never serve outside the app directory, whatever the request path says.
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(`Not found: ${rel}`);
    return;
  }

  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Footprint Terminal → http://localhost:${PORT}/`);
  console.log('Ctrl-C to stop.');
});
