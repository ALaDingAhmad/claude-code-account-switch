#!/usr/bin/env node

const fs = require('fs');
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
  console.log(`  peer      : ${cfg.peerUrl || '(passive，被动方)'}`);
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
  console.log(`  peer     : ${cfg.peerUrl || '(passive，被动方，等待对端访问)'}`);
  console.log(`  interval : ${cfg.intervalMs}ms`);
  if (!cfg.peerUrl) {
    console.log('  当前为被动方，仅响应对端请求，不主动发起。');
  }
  console.log('');
  console.log('Secret（复制到对端 --secret 参数）:');
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

function cmdWeb(rest) {
  let isShare = false;
  if (rest[0] === 'share') { isShare = true; rest = rest.slice(1); }

  let port = WEB_DEFAULT_PORT;
  let peer = null;     // null = 未传；'' = 显式清空
  let bind = null;
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (/^\d+$/.test(k)) port = parseInt(k, 10);
    else if (k === '--peer') { peer = rest[++i] || ''; }
    else if (k === '--bind') { bind = rest[++i] || null; }
    else throw new Error(`unknown option: ${k}`);
  }
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  if (isShare) {
    const cur = share.getShareConfig() || {};
    const patch = { enabled: true };
    if (peer !== null) patch.peerUrl = peer;        // 命令行显式传了 --peer 才覆盖
    if (bind !== null) patch.bindAddress = bind;
    else if (!cur.bindAddress) patch.bindAddress = '0.0.0.0';
    share.setShareConfig(patch);
  }

  startWebServer(port, !isShare, isShare ? printShareInvite : null);
}

function printShareInvite(actualPort, bindAddr) {
  const cfg = share.getShareConfig();
  const ip = bindAddr === '0.0.0.0' ? getLocalIPv4() : (bindAddr || '127.0.0.1');
  const url = `http://${ip}:${actualPort}`;
  console.log('');
  console.log('=== 共享同步信息 ===');
  console.log(`URL    : ${url}`);
  console.log(`Secret : ${cfg.secret}`);
  console.log(`角色   : ${cfg.peerUrl ? '主动方（轮询 ' + cfg.peerUrl + '）' : '被动方（等待对端访问）'}`);
  console.log('');
  console.log('在对端执行（任选其一）：');
  console.log(`  ccs share enable --peer ${url} --secret ${cfg.secret}`);
  console.log(`  ccs web        # 启动对端 web 后自动同步`);
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
      ? (web.sharePeerUrl ? 'share-sync ACTIVE' : 'share-sync PASSIVE')
      : 'normal';
    const url = `http://${web.bind === '0.0.0.0' ? '127.0.0.1' : web.bind}:${web.port}`;
    console.log(`Web service       : running ${url} (PID ${web.pid}, ${role})`);
  } else {
    console.log(`Web service       : not running`);
  }
  const cfg = share.getShareConfig();
  if (cfg?.enabled) {
    const peer = cfg.peerUrl ? `peer=${cfg.peerUrl}` : 'passive (no peer)';
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
CCS - Claude Code account switcher

Usage:
  ccs                       show status and imported accounts
  ccs <name>                switch to account <name>
  ccs -                     clear current login state
  ccs import <name> [path]  import current credentials as <name>
  ccs switch <name>         switch to account <name>
  ccs remove <name>         delete an imported account
  ccs clear-current         remove live credentials and clear account state
  ccs logout                alias for clear-current
  ccs sync                  capture live credentials into the active snapshot
  ccs status                show current status
  ccs accounts              list imported accounts
  ccs doctor                check environment and config
  ccs web [port]            start web UI (default port 7899)
  ccs web share [port] [--peer URL] [--bind ADDR]
                            start web UI with share-sync enabled, print URL+Secret
  ccs share status                   show share-sync config
  ccs share enable [options]         enable share-sync (--peer URL --secret X --bind A --interval MS)
  ccs share disable                  disable share-sync, clear secret
  ccs share secret                   print current secret in plain text
  ccs share sync                     trigger one sync round now
  ccs -h / --help           show this help
`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
