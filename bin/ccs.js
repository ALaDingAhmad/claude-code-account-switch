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
  'clear-current', 'logout', 'remove', 'doctor', 'web', 'sync',
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

function cmdWeb(rest) {
  const port = rest[0] ? parseInt(rest[0], 10) : WEB_DEFAULT_PORT;
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${rest[0]}`);
  }
  startWebServer(port, true);
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
  ccs -h / --help           show this help
`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
