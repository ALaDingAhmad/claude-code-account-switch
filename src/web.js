const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AccountStore = require('./store');
const { CREDENTIALS_PATH, triggerCacheInvalidation } = require('./utils');

const HTML_PATH = path.join(__dirname, 'index.html');

function startWebServer(port, openBrowser) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(HTML_PATH, 'utf8'));
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      try {
        const store = new AccountStore();
        const status = store.getStatus();
        const accounts = store.listAccounts();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...status, accounts }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/switch') {
      try {
        const body = JSON.parse(await readBody(req));
        const name = body.name;
        if (!name) throw new Error('name is required');

        const store = new AccountStore();
        store.switchAccount(name);

        triggerCacheInvalidation(CREDENTIALS_PATH).catch(() => {});

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: `Switched to "${name}"` }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}`;
    console.log(`CCS web UI running at ${url}`);
    console.log('Press Ctrl+C to stop.');
    if (openBrowser) {
      try {
        execSync(`start ${url}`, { windowsHide: true, stdio: 'ignore' });
      } catch { /* ignore */ }
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try: ccs web <port>`);
    } else {
      console.error(e.message);
    }
    process.exit(1);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data || '{}'));
    req.on('error', reject);
  });
}

module.exports = { startWebServer };
