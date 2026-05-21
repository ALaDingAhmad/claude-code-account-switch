const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AccountStore = require('./store');
const { triggerCacheInvalidation, writeWebPid, readWebPid, clearWebPid } = require('./utils');
const share = require('./share');
const statusline = require('./statusline');
const monitor = require('./monitor');

const HTML_PATH = path.join(__dirname, 'index.html');
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function startWebServer(port, openBrowser, onReady) {
  // 已有活 Web 就拒绝启动，避免污染 web.pid 和端口偏移。
  // readWebPid 已内置存活检查：返 null = 文件不存在 / pid 已死；任一种都清掉陈旧记录后正常启动。
  const existing = readWebPid();
  if (existing) {
    console.error(`ccs web already running (pid=${existing.pid}, port=${existing.port}). Use "ccs web stop" first.`);
    process.exit(1);
  }
  clearWebPid();  // pid 死了就清掉文件，避免后面误判

  let idleTimer = null;
  let actualBoundPort = port;  // /api/web/restart 用：实际监听的端口（可能因冲突偏移）
  const cancelIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  // 只清自己写下的 web.pid（重启 spawn 时新进程已覆盖了文件，旧进程别清新进程的记录）
  const clearOwnWebPid = () => {
    try {
      const cur = readWebPid();
      if (cur && cur.pid === process.pid) clearWebPid();
    } catch { /* ignore */ }
  };
  process.on('exit', clearOwnWebPid);
  process.on('SIGINT', () => { clearOwnWebPid(); process.exit(0); });
  process.on('SIGTERM', () => { clearOwnWebPid(); process.exit(0); });
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

    // 无鉴权：用于配置 peer 前对端身份探活，避免主节点 URL 指向自己
    if (req.method === 'GET' && url.pathname === '/api/share/whoami') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, nodeId: share.getNodeId() }));
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
        // 用量表（守护和切换核心在维护）：让前端在账号卡片上展示每个号的 5h / reset
        let usageTable = {};
        try {
          const usagePath = path.join(require('os').homedir(), '.ccs', 'account-usage.json');
          if (fs.existsSync(usagePath)) {
            usageTable = JSON.parse(fs.readFileSync(usagePath, 'utf8')) || {};
          }
        } catch { /* ignore */ }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...status, accounts, usageTable }));
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
        if (body && typeof body.peerUrl === 'string' && body.peerUrl.trim()) {
          const check = await probePeerSelf(body.peerUrl.trim(), share.getNodeId());
          if (check.isSelf) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: `主节点 URL 不能指向本机自己（nodeId 相同：${check.peerNodeId}）` }));
          }
          if (check.warn) console.log(`[share] peer 探活失败（${check.warn}），按宽松策略放行`);
        }
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

    if (req.method === 'GET' && url.pathname === '/api/statusline/status') {
      try {
        const s = statusline.getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...s }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/statusline/install') {
      try {
        const s = statusline.install();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...s }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/statusline/uninstall') {
      try {
        const s = statusline.uninstall();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...s }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/monitor/status') {
      try {
        // 兜底看门狗：发现 enabled 但守护没在跑，立刻拉起来
        const r = monitor.revive();
        const s = monitor.getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...s, revived: !!r.revived }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/monitor/enable') {
      try {
        const s = monitor.enable();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...s }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/monitor/disable') {
      try {
        const s = monitor.disable();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, ...s }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // v3.11.0：重启 Web 服务（方案 B：spawn+wait）
    //   1. 立刻 202 响应
    //   2. 立刻 spawn 新进程，带 --wait-for-pid <旧pid>；新进程自己 wait 旧 pid 死 + 端口可绑
    //   3. 旧进程 clearWebPid + server.close + exit
    // 关键：新进程负责 wait + 绕开 already-running 守卫；旧进程只管干净退出。
    // spawn 失败时旧进程不退出，至少保住服务。新进程启动失败浏览器 15s 超时报错。
    if (req.method === 'POST' && url.pathname === '/api/web/restart') {
      try {
        const oldPid = process.pid;
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, restarting: true, oldPid, port: actualBoundPort }));
        setTimeout(() => {
          let spawned = false;
          try {
            const { spawn } = require('child_process');
            const ccsBin = path.join(__dirname, '..', 'bin', 'ccs.js');
            const logPath = path.join(require('os').homedir(), '.ccs', 'web.log');
            const out = fs.openSync(logPath, 'a');
            const err = fs.openSync(logPath, 'a');
            const child = spawn(process.execPath,
              [ccsBin, 'web', String(actualBoundPort), '--wait-for-pid', String(oldPid)],
              { detached: true, stdio: ['ignore', out, err], windowsHide: true });
            child.unref();
            spawned = true;
            console.log(`[restart] spawned new web pid=${child.pid} (waits for old pid=${oldPid}), exiting old`);
          } catch (e) {
            console.error(`[restart] spawn failed, keeping old alive: ${e.message}`);
          }
          if (!spawned) return;
          try { clearWebPid(); } catch { /* ignore */ }
          try { server.close(); } catch { /* ignore */ }
          setTimeout(() => process.exit(0), 100);
        }, 100);
        return;
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }

    // v3.11.0：升级 ccs。跑 npm install -g claude-code-account-switch@latest，不自动重启
    if (req.method === 'POST' && url.pathname === '/api/web/upgrade') {
      try {
        const { spawn } = require('child_process');
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const child = spawn(npmCmd, ['install', '-g', 'claude-code-account-switch@latest'], {
          windowsHide: true,
        });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        const code = await new Promise((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        // 升级成功后读新的 package.json 版本号（注意：当前进程仍是旧代码，需重启才生效）
        let newVersion = null;
        try {
          const pkgPath = path.join(__dirname, '..', 'package.json');
          // 清掉 require cache 以拿到最新 version（npm install -g 可能更新到同一路径或新路径）
          delete require.cache[require.resolve(pkgPath)];
          newVersion = require(pkgPath).version;
        } catch { /* ignore */ }
        res.writeHead(code === 0 ? 200 : 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: code === 0,
          exitCode: code,
          version: newVersion,
          stdout: stdout.slice(-2000),
          stderr: stderr.slice(-2000),
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
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
        url.pathname === '/api/share/account' ||
        url.pathname === '/api/share/delete') {
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
      if (req.method === 'POST' && url.pathname === '/api/share/delete') {
        try {
          const body = JSON.parse(await readBody(req));
          if (!body.name) throw new Error('name required');
          const store = new AccountStore();
          store.applyDeleteAccount(body.name, body.deletedAt);
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
    actualBoundPort = actualPort;  // /api/web/restart 需要拿到实际端口
    resetIdle();
    try { share.getNodeId(); } catch { /* ignore */ }
    try {
      const r = new AccountStore().syncActive();
      if (r.synced) console.log(`[boot] synced live -> snapshot of "${r.name}"`);
    } catch (e) {
      console.log(`[boot] sync skipped: ${e.message}`);
    }
    if (cfg?.enabled) share.startDaemon();
    try { share.setLastWebPort(actualPort); } catch { /* ignore */ }
    writeWebPid({
      port: actualPort,
      bind,
      shareEnabled: !!cfg?.enabled,
      sharePeerUrl: cfg?.peerUrl || '',
    });
    const url = `http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${actualPort}`;
    const role = cfg?.enabled ? (cfg.peerUrl ? 'share-sync 从节点, no idle timeout' : 'share-sync 主节点, no idle timeout') : 'idle ' + (IDLE_TIMEOUT_MS / 60000) + ' min';
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

// 探 peer 的 nodeId，判断 peerUrl 是否指向本机自己
// 返回：{ isSelf, peerNodeId, warn }；探活失败不阻塞，返回 warn 让调用方放行
async function probePeerSelf(peerUrl, localNodeId) {
  const { URL } = require('url');
  const https = require('https');
  let u;
  try { u = new URL(peerUrl.replace(/\/$/, '') + '/api/share/whoami'); }
  catch (e) { return { isSelf: false, warn: `peerUrl 无法解析: ${e.message}` }; }
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'GET',
      timeout: 3000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return resolve({ isSelf: false, warn: `whoami HTTP ${res.statusCode}` });
        try {
          const j = JSON.parse(text);
          const peerNodeId = j && j.nodeId;
          if (!peerNodeId) return resolve({ isSelf: false, warn: 'whoami 缺少 nodeId（对端可能为旧版 ccs）' });
          return resolve({ isSelf: peerNodeId === localNodeId, peerNodeId });
        } catch (e) { resolve({ isSelf: false, warn: `whoami 响应非 JSON: ${e.message}` }); }
      });
    });
    req.on('error', (e) => resolve({ isSelf: false, warn: `whoami 请求失败: ${e.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ isSelf: false, warn: 'whoami 超时' }); });
    req.end();
  });
}

module.exports = { startWebServer };
