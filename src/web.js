const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AccountStore = require('./store');
const { triggerCacheInvalidation, writeWebPid, clearWebPid } = require('./utils');
const share = require('./share');

const HTML_PATH = path.join(__dirname, 'index.html');
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function startWebServer(port, openBrowser, onReady) {
  let idleTimer = null;
  const cancelIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  process.on('exit', clearWebPid);
  process.on('SIGINT', () => { clearWebPid(); process.exit(0); });
  process.on('SIGTERM', () => { clearWebPid(); process.exit(0); });
  const resetIdle = () => {
    cancelIdle();
    if (share.getShareConfig()?.enabled) return;  // 启用 share（含被动方）后常驻
    idleTimer = setTimeout(() => {
      console.log(`Idle for ${IDLE_TIMEOUT_MS / 1000}s, shutting down.`);
      process.exit(0);
    }, IDLE_TIMEOUT_MS);
  };

  const server = http.createServer(async (req, res) => {
    resetIdle();
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(HTML_PATH, 'utf8'));
    }

    if (req.method === 'GET' && url.pathname === '/api/version') {
      const pkg = require('../package.json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, version: pkg.version }));
    }

    if (url.pathname === '/api/shutdown' && (req.method === 'POST' || req.method === 'GET')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'shutting down' }));
      console.log(`Shutdown requested via ${req.method}.`);
      setTimeout(() => process.exit(0), 100);
      return;
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

    if (req.method === 'POST' && url.pathname === '/api/import') {
      try {
        const body = JSON.parse(await readBody(req));
        const store = new AccountStore();
        const name = body.name || store.getLiveEmail();
        if (!name) throw new Error('无法获取账号名，请手动输入');

        store.importAccount(name);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: `Imported "${name}"` }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/import-apikey') {
      try {
        const body = JSON.parse(await readBody(req));
        const { name, authToken, baseUrl } = body;
        if (!name) throw new Error('name is required');
        if (!authToken) throw new Error('authToken is required');
        const store = new AccountStore();
        store.importApiKeyAccount(name, authToken, baseUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: `Imported API Key account "${name}"` }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/edit') {
      try {
        const body = JSON.parse(await readBody(req));
        const store = new AccountStore();
        store.editAccount(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/remove') {
      try {
        const body = JSON.parse(await readBody(req));
        const name = body.name;
        if (!name) throw new Error('name is required');
        const store = new AccountStore();
        store.removeAccount(name);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: `Removed "${name}"` }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      try {
        const store = new AccountStore();
        store.clearLiveAuth();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, message: '已退出当前账号' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/sync') {
      try {
        const store = new AccountStore();
        const result = store.syncActive();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...result }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // --- Share Sync 配置接口 ---
    if (req.method === 'GET' && url.pathname === '/api/share/config') {
      const cfg = share.getShareConfig() || share.defaultShareConfig();
      const safe = { ...cfg, secret: cfg.secret ? cfg.secret.slice(0, 6) + '...' + cfg.secret.slice(-4) : '' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, config: safe, running: share.isRunning() }));
    }

    if (req.method === 'GET' && url.pathname === '/api/share/secret') {
      const cfg = share.getShareConfig();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, secret: cfg?.secret || '' }));
    }

    if (req.method === 'POST' && url.pathname === '/api/share/config') {
      try {
        const body = JSON.parse(await readBody(req));
        const cfg = share.setShareConfig(body);
        if (cfg.enabled) {
          cancelIdle();              // 启用后立刻取消 idle 计时
          share.startDaemon();        // peerUrl 为空时是被动方，函数内部会跳过 timer
        } else {
          share.stopDaemon();
          resetIdle();                // 禁用后重新进入 idle 倒计时
        }
        // 同步更新 pid 文件里的 share 状态，让 ccs CLI 能立即反映
        try {
          const cur = require('./utils').readWebPid();
          if (cur) writeWebPid({ port: cur.port, bind: cur.bind, shareEnabled: !!cfg.enabled, sharePeerUrl: cfg.peerUrl || '' });
        } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, config: { ...cfg, secret: cfg.secret ? '***' : '' } }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/share/sync-now') {
      try {
        const r = await share.syncOnce((m) => console.log(`[share] ${m}`));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...r }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // --- Share Sync 对端互访接口（必须鉴权）---
    if (url.pathname === '/api/share/snapshot' ||
        url.pathname === '/api/share/account') {
      const cfg = share.getShareConfig();
      if (!cfg?.enabled || !cfg.secret || !share.checkAuth(req, cfg.secret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      }
      if (req.method === 'GET' && url.pathname === '/api/share/snapshot') {
        const snap = share.localSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(snap));
      }
      if (req.method === 'GET' && url.pathname === '/api/share/account') {
        const name = url.searchParams.get('name');
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'name required' }));
        }
        const detail = share.localAccountDetail(name);
        if (!detail) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'no such account' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(detail));
      }
      if (req.method === 'POST' && url.pathname === '/api/share/account') {
        try {
          const body = JSON.parse(await readBody(req));
          share.applyAccountDetail(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/switch') {
      try {
        const body = JSON.parse(await readBody(req));
        const name = body.name;
        if (!name) throw new Error('name is required');

        const store = new AccountStore();
        store.switchAccount(name);

        triggerCacheInvalidation()
          .then((ok) => console.log(`[switch] ${name} cache-invalidate=${ok}`))
          .catch((e) => console.log(`[switch] ${name} cache-invalidate error:`, e.message));

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

  const cfg = share.getShareConfig();
  const bind = (cfg?.enabled && cfg.bindAddress) ? cfg.bindAddress : '127.0.0.1';
  const MAX_PORT_RETRY = 20;

  function onListen(actualPort) {
    resetIdle();
    try {
      const r = new AccountStore().syncActive();
      if (r.synced) console.log(`[boot] synced live -> snapshot of "${r.name}"`);
    } catch (e) {
      console.log(`[boot] sync skipped: ${e.message}`);
    }
    if (cfg?.enabled) share.startDaemon();
    writeWebPid({
      port: actualPort,
      bind,
      shareEnabled: !!cfg?.enabled,
      sharePeerUrl: cfg?.peerUrl || '',
    });
    const url = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${actualPort}`;
    const role = cfg?.enabled ? (cfg.peerUrl ? 'share-sync ACTIVE, no idle timeout' : 'share-sync PASSIVE, no idle timeout') : 'idle ' + (IDLE_TIMEOUT_MS / 60000) + ' min';
    if (actualPort !== port) {
      console.log(`Port ${port} was in use, switched to ${actualPort}.`);
    }
    console.log(`CCS web UI running at ${url}  (bind=${bind}, ${role})`);
    console.log('Press Ctrl+C to stop.');
    if (openBrowser) {
      try {
        const openCmd = process.platform === 'darwin' ? `open ${url}` : `start ${url}`;
        execSync(openCmd, { windowsHide: true, stdio: 'ignore' });
      } catch { /* ignore */ }
    }
    if (typeof onReady === 'function') onReady(actualPort, bind);
  }

  function tryListen(p) {
    const onErr = (e) => {
      server.removeListener('listening', onOk);
      if (e.code === 'EADDRINUSE' && p < port + MAX_PORT_RETRY) {
        return tryListen(p + 1);
      }
      if (e.code === 'EADDRINUSE') {
        console.error(`No free port in range ${port}-${port + MAX_PORT_RETRY}.`);
      } else {
        console.error(e.message);
      }
      process.exit(1);
    };
    const onOk = () => {
      server.removeListener('error', onErr);
      onListen(p);
    };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(p, bind);
  }

  tryListen(port);
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
