#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');

const AccountStore = require(path.join(__dirname, '..', 'src', 'store'));
const {
  CREDENTIALS_PATH,
  liveCredentialsExist,
  IS_MAC,
  CLAUDE_STATE_PATH,
  CONFIG_PATH,
  findClaudeExe,
  formatExpiry,
  triggerCacheInvalidation,
  readWebPid,
} = require(path.join(__dirname, '..', 'src', 'utils'));
const share = require(path.join(__dirname, '..', 'src', 'share'));
const { startWebServer } = require(path.join(__dirname, '..', 'src', 'web'));

const args = process.argv.slice(2);
const cmd = args[0];

const WEB_DEFAULT_PORT = 7899;

const COMMANDS = new Set([
  'import', 'switch', 'status', 'accounts',
  'clear-current', 'logout', 'remove', 'doctor', 'web', 'sync', 'share',
]);

async function main() {
  if (!cmd) {
    printStatus(new AccountStore().getStatus());
    console.log('');
    printAccounts(new AccountStore().listAccounts());
    console.log('');
    printRuntimeInfo();
    return;
  }

  if (cmd === '-') { cmdClearCurrent(); return; }
  if (cmd === '-h' || cmd === '--help') { printHelp(); return; }

  if (COMMANDS.has(cmd)) {
    await dispatch(cmd, args.slice(1));
  } else {
    await cmdSwitch([cmd]);
  }
}

async function dispatch(cmd, rest) {
  switch (cmd) {
    case 'import':       return cmdImport(rest);
    case 'switch':       return cmdSwitch(rest);
    case 'status':       return printStatus(new AccountStore().getStatus());
    case 'accounts':     return printAccounts(new AccountStore().listAccounts());
    case 'clear-current':
    case 'logout':       return cmdClearCurrent();
    case 'remove':       return cmdRemove(rest);
    case 'doctor':       return cmdDoctor();
    case 'web':          return cmdWeb(rest);
    case 'sync':         return cmdSync();
    case 'share':        return cmdShare(rest);
  }
}

function cmdImport(rest) {
  const name = rest[0];
  const sourcePath = rest[1] || null;
  if (!name) throw new Error('Usage: ccs import <name> [credentials-path]');

  const store = new AccountStore();
  const account = store.importAccount(name, sourcePath);
  printAccountSummary(`Imported "${name}"`, account);
  console.log(`"${name}" is now the active account.`);
}

async function cmdSwitch(rest) {
  const name = rest[0];
  if (!name) throw new Error('Usage: ccs switch <name>');

  const store = new AccountStore();
  const account = store.switchAccount(name);
  printAccountSummary(`Switched to "${name}"`, account);

  process.stdout.write('正在清除旧账号缓存... ');
  const ok = await triggerCacheInvalidation();
  console.log(ok ? '完成，状态栏将立即显示新账号。' : '完成。（API 探活失败，不影响切换；状态栏在下次刷新时生效）');
}

function cmdRemove(rest) {
  const name = rest[0];
  if (!name) throw new Error('Usage: ccs remove <name>');
  new AccountStore().removeAccount(name);
  console.log(`Removed "${name}".`);
}

function cmdClearCurrent() {
  new AccountStore().clearLiveAuth();
  console.log('Cleared current Claude auth state.');
  console.log('Removed live credentials and cleared userID/oauthAccount from .claude.json.');
  console.log('Session and history files were left untouched. You can now run /login in Claude.');
}

function cmdSync() {
  const result = new AccountStore().syncActive();
  if (result.synced) {
    console.log(`Synced live credentials -> snapshot of "${result.name}".`);
  } else {
    console.log(`Sync skipped: ${result.reason}.`);
  }
}

async function cmdShare(rest) {
  const sub = rest[0] || 'status';
  if (sub === 'status') return shareStatus();
  if (sub === 'enable') return shareEnable(rest.slice(1));
  if (sub === 'disable') return shareDisable();
  if (sub === 'secret') return shareShowSecret();
  if (sub === 'sync') return shareSyncNow();
  throw new Error(
    'Usage: ccs share <status|enable|disable|secret|sync> [options]\n' +
    '  enable [--peer URL] [--secret X] [--bind 127.0.0.1|0.0.0.0] [--interval MS]'
  );
}

function shareStatus() {
  const cfg = share.getShareConfig() || share.defaultShareConfig();
  console.log('Share sync 配置：');
  console.log(`  enabled   : ${cfg.enabled}`);
  console.log(`  bind      : ${cfg.bindAddress}`);
  console.log(`  peer      : ${cfg.peerUrl || '(none，本机为主节点)'}`);
  console.log(`  secret    : ${cfg.secret ? cfg.secret.slice(0, 6) + '...' + cfg.secret.slice(-4) : '(empty)'}`);
  console.log(`  interval  : ${cfg.intervalMs}ms`);
  console.log(`  last sync : ${cfg.lastSyncAt || 'never'}`);
  if (cfg.lastResult) {
    console.log(`  last result: pulled=${cfg.lastResult.pulled || 0}, pushed=${cfg.lastResult.pushed || 0}`);
  }
  if (cfg.lastError) {
    console.log(`  last error: ${cfg.lastError}`);
  }
}

function shareEnable(opts) {
  const patch = { enabled: true };
  for (let i = 0; i < opts.length; i++) {
    const k = opts[i], v = opts[i + 1];
    if (k === '--peer') { patch.peerUrl = v || ''; i++; }
    else if (k === '--secret') { patch.secret = v || ''; i++; }
    else if (k === '--bind') { patch.bindAddress = v || '127.0.0.1'; i++; }
    else if (k === '--interval') { patch.intervalMs = parseInt(v, 10) || 30000; i++; }
    else throw new Error(`unknown option: ${k}`);
  }
  const cfg = share.setShareConfig(patch);
  console.log('Share sync 已启用：');
  console.log(`  bind     : ${cfg.bindAddress}`);
  console.log(`  peer     : ${cfg.peerUrl || '(none，本机为主节点，等待从节点访问)'}`);
  console.log(`  interval : ${cfg.intervalMs}ms`);
  if (!cfg.peerUrl) {
    console.log('  当前为主节点，仅响应从节点请求，不主动发起。');
  }
  console.log('');
  console.log('Secret（复制到从节点 --secret 参数）:');
  console.log(cfg.secret);
}

function shareDisable() {
  share.setShareConfig({ enabled: false, peerUrl: '', secret: '' });
  console.log('Share sync 已禁用，secret 和 peer URL 已清除。');
}

function shareShowSecret() {
  const cfg = share.getShareConfig();
  if (!cfg?.secret) {
    console.log('(没有 secret，请先 ccs share enable)');
    return;
  }
  console.log(cfg.secret);
}

async function shareSyncNow() {
  const r = await share.syncOnce((m) => console.log(`[share] ${m}`));
  if (r.skipped) console.log(`跳过: ${r.skipped}`);
  else if (r.error) console.log(`错误: ${r.error}`);
  else console.log(`同步完成：拉取 ${r.pulled || 0}，推送 ${r.pushed || 0}`);
}

async function cmdWeb(rest) {
  if (rest[0] === 'stop') return cmdWebStop();
  let isShare = false;
  if (rest[0] === 'share') { isShare = true; rest = rest.slice(1); }

  let port = WEB_DEFAULT_PORT;
  let peer = null;
  let bind = null;
  let secret = null;
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (/^\d+$/.test(k)) port = parseInt(k, 10);
    else if (k === '--peer') { peer = rest[++i] || ''; }
    else if (k === '--bind') { bind = rest[++i] || null; }
    else if (k === '--secret') { secret = rest[++i] || null; }
    else throw new Error(`unknown option: ${k}`);
  }
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  if (isShare) {
    const cur = share.getShareConfig() || {};
    const patch = { enabled: true };
    if (peer !== null) patch.peerUrl = peer;
    if (bind !== null) patch.bindAddress = bind;
    else if (!cur.bindAddress) patch.bindAddress = '0.0.0.0';
    if (secret !== null) patch.secret = secret;

    const running = readWebPid();
    if (running) {
      // 复用现有 web 服务：HTTP patch 配置即可，不再 spawn 新进程
      const portArgGiven = rest.some((a) => /^\d+$/.test(a));
      if (portArgGiven && port !== running.port) {
        console.log(`⚠ 已有 ccs web 在端口 ${running.port} 运行，忽略指定的端口 ${port}（如需换端口，先 ccs web stop 再启动）。`);
      }
      if (bind !== null && bind !== running.bind) {
        console.log(`⚠ bindAddress 改为 "${bind}" 已写入配置，但对运行中的服务不生效，需 ccs web stop 后重启才会切换监听地址。`);
      }
      // 自指校验由 web 服务端兜底（POST /api/share/config）
      return reuseRunningWeb(running, patch);
    }

    if (peer) {
      const localNodeId = share.getNodeId();
      const check = await probePeerSelf(peer, localNodeId);
      if (check.isSelf) {
        throw new Error(`主节点 URL 不能指向本机自己（nodeId 相同：${check.peerNodeId}）`);
      }
      if (check.warn) console.log(`⚠ peer 探活失败（${check.warn}），按宽松策略继续。`);
    }

    share.setShareConfig(patch);
    return spawnDetachedWeb(port);
  }

  startWebServer(port, true, null);
}

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

async function reuseRunningWeb(info, patch) {
  const host = info.bind === '0.0.0.0' ? '127.0.0.1' : (info.bind || '127.0.0.1');
  const url = `http://${host}:${info.port}/api/share/config`;
  const body = JSON.stringify(patch);
  const resp = await new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  }).catch((e) => { throw new Error(`无法访问现有 web 服务 ${url}: ${e.message}`); });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`现有 web 服务拒绝配置更新 (HTTP ${resp.status}): ${resp.text.slice(0, 200)}`);
  }

  console.log(`复用运行中的 ccs web 服务（PID ${info.pid}, ${info.bind}:${info.port}），已通过 API 启用 share。`);
  printShareInvite(info.port, info.bind);
  console.log(`停止服务       : ccs web stop`);
}

async function spawnDetachedWeb(port) {
  const { spawn } = require('child_process');
  const { CCS_DIR, readWebPid } = require(path.join(__dirname, '..', 'src', 'utils'));
  const logPath = path.join(CCS_DIR, 'web.log');
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [__filename, 'web', String(port)], {
    detached: true,
    stdio: ['ignore', out, err],
    windowsHide: true,
  });
  child.unref();

  // 轮询 web.pid，等 web 启动完成（最多 10 秒）
  let info = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const cur = readWebPid();
    if (cur && cur.pid === child.pid) { info = cur; break; }
  }
  if (!info) {
    console.error(`Failed to confirm web start within 10s. Check log: ${logPath}`);
    process.exit(1);
  }
  printShareInvite(info.port, info.bind);
  console.log(`Background PID : ${child.pid}`);
  console.log(`Log file       : ${logPath}`);
  console.log(`停止服务       : ccs web stop`);
  console.log(`               或: 浏览器访问 http://127.0.0.1:${info.port}/api/shutdown`);
  console.log(`               或: kill ${child.pid}`);
}

function cmdWebStop() {
  const { readWebPid } = require(path.join(__dirname, '..', 'src', 'utils'));
  const info = readWebPid();
  if (!info) {
    console.log('No running ccs web service.');
    return;
  }
  try {
    process.kill(info.pid, 'SIGTERM');
    console.log(`Stopped ccs web (PID ${info.pid}, was running on ${info.bind}:${info.port}).`);
  } catch (e) {
    console.error(`Failed to stop PID ${info.pid}: ${e.message}`);
    process.exit(1);
  }
}

function printShareInvite(actualPort, bindAddr) {
  const cfg = share.getShareConfig();
  const ip = bindAddr === '0.0.0.0' ? getLocalIPv4() : (bindAddr || '127.0.0.1');
  const localUrl = `http://${ip}:${actualPort}`;
  console.log('');
  console.log('=== 共享同步信息 ===');

  if (cfg.peerUrl) {
    // 本机是从节点
    const peerPort = (() => { try { return new URL(cfg.peerUrl).port || 7899; } catch { return 7899; } })();
    console.log(`本机角色  : 从节点（每 ${cfg.intervalMs / 1000}s 轮询主节点）`);
    console.log(`本机地址  : ${localUrl}`);
    console.log(`主节点 URL: ${cfg.peerUrl}`);
    console.log(`共享密钥  : ${cfg.secret}`);
    console.log('');
    console.log(`⚠ 请确保主节点 ${cfg.peerUrl} 已启动并使用同一密钥。`);
    console.log('  若主节点尚未启动，在主节点那台机器上一行命令：');
    console.log(`    ccs web share ${peerPort} --secret ${cfg.secret}`);
  } else {
    // 本机是主节点
    console.log(`本机角色  : 主节点（被动响应，等待从节点访问）`);
    console.log(`本机 URL  : ${localUrl}`);
    console.log(`共享密钥  : ${cfg.secret}`);
    console.log('');
    console.log('在从节点那台机器上一行命令：');
    console.log(`  ccs web share --peer ${localUrl} --secret ${cfg.secret}`);
  }
  console.log('');
}

function getLocalIPv4() {
  const os = require('os');
  const cands = [];
  for (const ifaces of Object.values(os.networkInterfaces() || {})) {
    for (const a of ifaces || []) {
      if (a.family === 'IPv4' && !a.internal) cands.push(a.address);
    }
  }
  // 优先 LAN 真实网段：192.168.* > 10.* > 其他 > 172.x（多为 WSL/Docker 虚拟）
  const score = (ip) => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 3 : 2;
  cands.sort((a, b) => score(a) - score(b));
  return cands[0] || '127.0.0.1';
}

function cmdDoctor() {
  const store = new AccountStore();
  const status = store.getStatus();
  console.log('CCS doctor');
  console.log(`  Claude executable : ${findClaudeExe() || 'not found'}`);
  console.log(`  Credentials       : ${liveCredentialsExist() ? 'present' : 'missing'} (${IS_MAC ? 'macOS Keychain: Claude Code-credentials' : CREDENTIALS_PATH})`);
  console.log(`  State file        : ${fs.existsSync(CLAUDE_STATE_PATH) ? 'present' : 'missing'} (${CLAUDE_STATE_PATH})`);
  console.log(`  Config file       : ${fs.existsSync(CONFIG_PATH) ? 'present' : 'missing'} (${CONFIG_PATH})`);
  console.log(`  Active account    : ${status.activeAccount || 'none'}`);
  console.log(`  Imported accounts : ${status.accountCount}`);
  console.log('');
  printRuntimeInfo();
}

function printRuntimeInfo() {
  const web = readWebPid();
  if (web) {
    const role = web.shareEnabled
      ? (web.sharePeerUrl ? 'share-sync 从节点' : 'share-sync 主节点')
      : 'normal';
    const url = `http://${web.bind === '0.0.0.0' ? '127.0.0.1' : web.bind}:${web.port}`;
    console.log(`Web service       : running ${url} (PID ${web.pid}, ${role})`);
  } else {
    console.log(`Web service       : not running`);
  }
  const cfg = share.getShareConfig();
  if (cfg?.enabled) {
    const peer = cfg.peerUrl ? `从节点 peer=${cfg.peerUrl}` : '主节点（无 peer，被访问方）';
    console.log(`Share sync        : enabled, ${peer}, interval=${cfg.intervalMs}ms`);
    if (cfg.lastSyncAt) {
      const r = cfg.lastResult ? `pulled=${cfg.lastResult.pulled || 0}, pushed=${cfg.lastResult.pushed || 0}` : 'none';
      const err = cfg.lastError ? `, error=${cfg.lastError}` : '';
      console.log(`  last sync       : ${cfg.lastSyncAt} (${r})${err}`);
    } else {
      console.log(`  last sync       : never`);
    }
  } else {
    console.log(`Share sync        : disabled`);
  }
}

// ── Printers ────────────────────────────────────────────────────────────────

function printAccountSummary(prefix, account) {
  console.log(prefix);
  if (account.type === 'apikey') {
    console.log(`  Type         : API Key`);
    console.log(`  Token        : ${account.authTokenMasked || 'N/A'}`);
    if (account.baseUrl) console.log(`  Base URL     : ${account.baseUrl}`);
    return;
  }
  console.log(`  Subscription : ${account.subscriptionType}`);
  console.log(`  Token        : ${account.accessTokenMasked}`);
  if (account.displayName || account.emailAddress) {
    console.log(`  Identity     : ${account.displayName || 'unknown'} <${account.emailAddress || 'unknown'}>`);
  }
  if (account.organizationName) console.log(`  Organization : ${account.organizationName}`);
  console.log(`  Expires      : ${formatExpiry(account.expiresAt)}`);
}

function printStatus(status) {
  console.log(`Active account    : ${status.activeAccount || 'none'}`);
  console.log(`Imported accounts : ${status.accountCount}`);
  if (status.active) {
    if (status.active.type === 'apikey') {
      console.log(`Type              : API Key`);
      console.log(`Token             : ${status.active.authTokenMasked || 'N/A'}`);
      if (status.active.baseUrl) console.log(`Base URL          : ${status.active.baseUrl}`);
    } else {
      console.log(`Subscription      : ${status.active.subscriptionType}`);
      console.log(`Token             : ${status.active.accessTokenMasked}`);
      if (status.active.displayName || status.active.emailAddress) {
        console.log(`Identity          : ${status.active.displayName || 'unknown'} <${status.active.emailAddress || 'unknown'}>`);
      }
      if (status.active.organizationName) console.log(`Organization      : ${status.active.organizationName}`);
      console.log(`Expires           : ${status.active.expiresIn}`);
    }
  }
}

function printAccounts(accounts) {
  const names = Object.keys(accounts);
  if (names.length === 0) { console.log('No imported accounts.'); return; }

  for (const name of names) {
    const a = accounts[name];
    const tag = a.isActive ? ' [active]' : '';
    if (a.type === 'apikey') {
      console.log(`${name}${tag} (API Key)`);
      console.log(`  Token        : ${a.authTokenMasked || 'N/A'}`);
      if (a.baseUrl) console.log(`  Base URL     : ${a.baseUrl}`);
      continue;
    }
    console.log(`${name}${tag}`);
    console.log(`  Subscription : ${a.subscriptionType}`);
    console.log(`  Token        : ${a.accessTokenMasked}`);
    if (a.displayName || a.emailAddress) {
      console.log(`  Identity     : ${a.displayName || 'unknown'} <${a.emailAddress || 'unknown'}>`);
    }
    if (a.organizationName) console.log(`  Organization : ${a.organizationName}`);
    console.log(`  Expires      : ${formatExpiry(a.expiresAt)}`);
  }
}

function printHelp() {
  console.log(`
CCS - Claude Code 多账号切换工具

总览：
  ccs                                显示当前状态、账号列表、web/share 运行信息
  ccs <name>                         切换到账号 <name>（switch 简写）
  ccs -                              清除当前登录状态（同 logout）
  ccs -h / --help                    显示帮助

账号管理：
  ccs import <name> [path]           将当前 live credentials 导入为 <name>
  ccs switch <name>                  切换到指定账号
  ccs remove <name>                  删除已导入的账号
  ccs accounts                       列出所有已导入账号
  ccs status                         显示当前活跃账号状态
  ccs sync                           把 live credentials 回写到当前 active 快照
  ccs clear-current / logout         清除 live credentials 和账号状态字段
  ccs doctor                         检查环境和配置

Web 服务：
  ccs web [port]                     前台启动 web UI（默认 7899，端口被占自动 +1）
  ccs web share [port] [--peer URL] [--bind ADDR]
                                     后台启动 web UI 并启用共享同步，打印 URL/Secret
  ccs web stop                       停止后台 web 服务

共享同步（CLI 配置）：
  ccs share status                   查看 share-sync 配置和上次同步结果
  ccs share enable [opts]            启用 share-sync
                                     opts: --peer URL --secret X --bind ADDR --interval MS
  ccs share disable                  禁用 share-sync 并清除 secret
  ccs share secret                   输出明文 secret（用于复制到对端）
  ccs share sync                     立即触发一轮同步
`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
