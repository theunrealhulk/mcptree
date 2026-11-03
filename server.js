const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const ENTITIES =
  process.env.ENTITIES_JSON || 'D:\\repositories\\myfactory-ai\\scripts\\entities.json';

const ROUTES = {
  '/': path.join(ROOT, 'index.html'),
  '/index.html': path.join(ROOT, 'index.html'),
  '/index.js': path.join(ROOT, 'index.js'),
  '/d3.min.js': path.join(ROOT, 'node_modules', 'd3', 'dist', 'd3.min.js'),
  '/lucide.min.js': path.join(ROOT, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.min.js'),
  '/entities.json': ENTITIES,
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

http
  .createServer((req, res) => {
    const file = ROUTES[new URL(req.url, 'http://localhost').pathname];
    if (!file) {
      res.writeHead(404).end('Not found');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(500).end(`Cannot read ${file}: ${err.message}`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': `${TYPES[path.extname(file)] || 'text/plain'}; charset=utf-8`,
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  })
  .listen(PORT, () => {
    console.log(`Entity tree: http://localhost:${PORT}/`);
    console.log(`Serving entities from ${ENTITIES}`);
  });
