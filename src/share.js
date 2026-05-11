const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const {
  CONFIG_PATH,
  atomicWriteJson,
  readJson,
  fileExists,
  sanitizeName,
  credentialsSnapshotPath,
  stateSnapshotPath,
  maskToken,
} = require('./utils');

const DEFAULT_INTERVAL_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;
const TOLERANCE_MS = 1000;

// ── Config helpers ──────────────────────────────────────────────────────────

function readConfig() {
  if (!fileExists(CONFIG_PATH)) return { accounts: {} };
  try { return readJson(CONFIG_PATH); } catch { return { accounts: {} }; }
}

function saveConfig(c) { atomicWriteJson(CONFIG_PATH, c); }

function getShareConfig() {
  const c = readConfig();
  return c.shareSync || null;
}

function defaultShareConfig() {
  return {
    enabled: false,
    bindAddress: '127.0.0.1',
    peerUrl: '',
    secret: '',
    intervalMs: DEFAULT_INTERVAL_MS,
    lastSyncAt: null,
    lastResult: null,
    lastError: null,
  };
}

function setShareConfig(patch) {
  const c = readConfig();
  const cur = c.shareSync || defaultShareConfig();
  // 防御：patch.secret 看起来像 mask（含 '...'）就忽略，保留旧 secret
  const safePatch = { ...patch };
  if (typeof safePatch.secret === 'string' && safePatch.secret.includes('...')) {
    delete safePatch.secret;
  }
  c.shareSync = { ...cur, ...safePatch };
  if (!c.shareSync.secret && c.shareSync.enabled) {
    c.shareSync.secret = crypto.randomBytes(32).toString('hex');
  }
  saveConfig(c);
  return c.shareSync;
}

// ── Auth / HTTP helpers ─────────────────────────────────────────────────────

function checkAuth(req, secret) {
  if (!secret) return false;
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function httpRequest(urlString, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method,
      headers: { 'Accept': 'application/json', ...headers },
      timeout: REQUEST_TIMEOUT_MS,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, text });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

async function callPeer(peerUrl, path, secret, { method = 'GET', body = null } = {}) {
  const url = peerUrl.replace(/\/$/, '') + path;
  const headers = { 'Authorization': `Bearer ${secret}` };
  if (body) headers['Content-Type'] = 'application/json';
  const { status, text } = await httpRequest(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`peer ${path} -> HTTP ${status}: ${text.slice(0, 200)}`);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new Error(`peer ${path} bad JSON: ${text.slice(0, 200)}`); }
}

// ── Pre-sync: refresh ccs config from live ──────────────────────────────────

// 同步前必须做：把 live credentials 拍照到 active 账号快照，
// 以便 snapshot 反映 OAuth refresh 后的最新 token。
// API Key 模式 ccs 是写入方，无需反向同步。
function refreshFromLive() {
  try {
    const Store = require('./store');
    new Store().syncActive();
  } catch { /* ignore */ }
}

// ── Account snapshot/detail/apply ───────────────────────────────────────────

function hashAccount(acct, name) {
  if (acct.type === 'apikey') {
    return crypto.createHash('sha256').update(JSON.stringify({
      type: 'apikey',
      authToken: acct.authToken || '',
      baseUrl: acct.baseUrl || '',
    })).digest('hex').slice(0, 16);
  }
  let cred = '';
  let state = '';
  const cp = credentialsSnapshotPath(name);
  const sp = stateSnapshotPath(name);
  if (fileExists(cp)) cred = fs.readFileSync(cp, 'utf8');
  if (fileExists(sp)) state = fs.readFileSync(sp, 'utf8');
  return crypto.createHash('sha256').update(cred + '|' + state).digest('hex').slice(0, 16);
}

function localSnapshot() {
  refreshFromLive();
  const config = readConfig();
  const accounts = {};
  for (const [name, acct] of Object.entries(config.accounts || {})) {
    accounts[name] = {
      type: acct.type || 'oauth',
      updatedAt: acct.updatedAt || null,
      expiresAt: acct.expiresAt || null,
      hash: hashAccount(acct, name),
    };
  }
  return {
    activeAccount: config.activeAccount || null,
    lastSwitchedAt: config.lastSwitchedAt || null,
    accounts,
    accountCount: Object.keys(accounts).length,
  };
}

function localAccountDetail(name) {
  refreshFromLive();
  const config = readConfig();
  const acct = (config.accounts || {})[name];
  if (!acct) return null;
  if (acct.type === 'apikey') {
    return {
      name,
      type: 'apikey',
      updatedAt: acct.updatedAt,
      importedAt: acct.importedAt,
      authToken: acct.authToken,
      authTokenMasked: acct.authTokenMasked || maskToken(acct.authToken),
      baseUrl: acct.baseUrl || null,
    };
  }
  const cp = credentialsSnapshotPath(name);
  const sp = stateSnapshotPath(name);
  return {
    name,
    type: 'oauth',
    updatedAt: acct.updatedAt,
    importedAt: acct.importedAt,
    accessTokenMasked: acct.accessTokenMasked,
    subscriptionType: acct.subscriptionType,
    scopes: acct.scopes,
    expiresAt: acct.expiresAt,
    emailAddress: acct.emailAddress,
    displayName: acct.displayName,
    organizationName: acct.organizationName,
    accountUuid: acct.accountUuid,
    userID: acct.userID,
    credentials: fileExists(cp) ? readJson(cp) : null,
    stateSnapshot: fileExists(sp) ? readJson(sp) : null,
  };
}

function applyAccountDetail(detail) {
  if (!detail || !detail.name) throw new Error('detail.name required');
  const name = sanitizeName(detail.name);
  const config = readConfig();
  config.accounts = config.accounts || {};

  if (detail.type === 'apikey') {
    config.accounts[name] = {
      type: 'apikey',
      name,
      authToken: detail.authToken,
      authTokenMasked: detail.authTokenMasked || maskToken(detail.authToken),
      baseUrl: detail.baseUrl || null,
      importedAt: detail.importedAt || new Date().toISOString(),
      updatedAt: detail.updatedAt || new Date().toISOString(),
    };
  } else {
    if (detail.credentials) {
      atomicWriteJson(credentialsSnapshotPath(name), detail.credentials);
    }
    if (detail.stateSnapshot) {
      atomicWriteJson(stateSnapshotPath(name), detail.stateSnapshot);
    }
    config.accounts[name] = {
      type: 'oauth',
      name,
      accessTokenMasked: detail.accessTokenMasked,
      subscriptionType: detail.subscriptionType,
      scopes: detail.scopes,
      expiresAt: detail.expiresAt,
      emailAddress: detail.emailAddress,
      displayName: detail.displayName,
      organizationName: detail.organizationName,
      accountUuid: detail.accountUuid,
      userID: detail.userID,
      importedAt: detail.importedAt || new Date().toISOString(),
      updatedAt: detail.updatedAt || new Date().toISOString(),
    };
  }
  saveConfig(config);

  // 如果被更新的是当前 active 账号，刷新 live（让 OAuth 自动续期/API Key 切换在本端生效）
  const after = readConfig();
  if (after.activeAccount === name) {
    try {
      const Store = require('./store');
      new Store().switchAccount(name);
    } catch (e) {
      // 不影响同步主流程，但要 log
      console.log(`[share] applied ${name} but failed to refresh live: ${e.message}`);
    }
  }
}

// ── Sync engine ─────────────────────────────────────────────────────────────

async function syncOnce(log = () => {}) {
  const cfg = getShareConfig();
  if (!cfg?.enabled) return { skipped: 'disabled' };
  if (!cfg.peerUrl) return { skipped: '主节点模式（无 peer URL，不主动同步）' };
  if (!cfg.secret) return { skipped: 'no secret' };

  let peer;
  try {
    peer = await callPeer(cfg.peerUrl, '/api/share/snapshot', cfg.secret);
  } catch (e) {
    setShareConfig({ lastError: `snapshot: ${e.message}`, lastSyncAt: new Date().toISOString() });
    return { error: e.message };
  }

  const local = localSnapshot();
  let pulled = 0;
  let pushed = 0;
  const peerAccounts = peer.accounts || {};
  const localAccounts = local.accounts;

  // 1) peer 账号 → 本地无 / 哈希不一致
  for (const name of Object.keys(peerAccounts)) {
    const peerAcct = peerAccounts[name];
    const localAcct = localAccounts[name];
    if (!localAcct) {
      try {
        const detail = await callPeer(cfg.peerUrl, `/api/share/account?name=${encodeURIComponent(name)}`, cfg.secret);
        applyAccountDetail(detail);
        pulled++;
        log(`pulled new account: ${name}`);
      } catch (e) {
        log(`pull "${name}" failed: ${e.message}`);
      }
      continue;
    }
    if (localAcct.hash === peerAcct.hash) continue;
    // hash 不同必有差异，必须分出方向同步。
    // 决策序：updatedAt 差值 > 容差 → 用 updatedAt；否则 OAuth 看 expiresAt（续期一定向后跳），
    // 实在打平就 fallback 拉 peer（避免主从都说自己新的死循环）。
    const localUp = new Date(localAcct.updatedAt || 0).getTime();
    const peerUp = new Date(peerAcct.updatedAt || 0).getTime();
    const localExp = localAcct.expiresAt || 0;
    const peerExp = peerAcct.expiresAt || 0;
    let direction;
    if (peerUp > localUp + TOLERANCE_MS) direction = 'pull';
    else if (localUp > peerUp + TOLERANCE_MS) direction = 'push';
    else if (peerExp > localExp) direction = 'pull';
    else if (localExp > peerExp) direction = 'push';
    else direction = 'pull';  // 真打平：拉对端，避免循环 push

    if (direction === 'pull') {
      try {
        const detail = await callPeer(cfg.peerUrl, `/api/share/account?name=${encodeURIComponent(name)}`, cfg.secret);
        applyAccountDetail(detail);
        pulled++;
        log(`pulled "${name}" (updatedAt Δ${peerUp - localUp}ms, expiresAt Δ${peerExp - localExp}ms)`);
      } catch (e) {
        log(`pull "${name}" failed: ${e.message}`);
      }
    } else {
      const detail = localAccountDetail(name);
      try {
        await callPeer(cfg.peerUrl, '/api/share/account', cfg.secret, { method: 'POST', body: detail });
        pushed++;
        log(`pushed "${name}" (updatedAt Δ${localUp - peerUp}ms, expiresAt Δ${localExp - peerExp}ms)`);
      } catch (e) {
        log(`push "${name}" failed: ${e.message}`);
      }
    }
  }

  // 2) 本地账号 → peer 无
  for (const name of Object.keys(localAccounts)) {
    if (peerAccounts[name]) continue;
    const detail = localAccountDetail(name);
    try {
      await callPeer(cfg.peerUrl, '/api/share/account', cfg.secret, { method: 'POST', body: detail });
      pushed++;
      log(`pushed new account: ${name}`);
    } catch (e) {
      log(`push "${name}" failed: ${e.message}`);
    }
  }

  const result = { pulled, pushed };
  setShareConfig({
    lastSyncAt: new Date().toISOString(),
    lastResult: result,
    lastError: null,
  });
  return result;
}

// ── Daemon timer ────────────────────────────────────────────────────────────

let timer = null;

function startDaemon(log = console.log) {
  stopDaemon();
  const cfg = getShareConfig();
  if (!cfg?.enabled) return false;
  if (!cfg.peerUrl) {
    log(`[share] 主节点模式：暴露 API 等待从节点访问（peerUrl 未配置）`);
    return false;
  }
  const interval = Math.max(5000, cfg.intervalMs || DEFAULT_INTERVAL_MS);
  log(`[share] daemon start, interval=${interval}ms, peer=${cfg.peerUrl}`);
  const tick = () => {
    syncOnce((m) => log(`[share] ${m}`)).catch((e) => log(`[share] error: ${e.message}`));
  };
  tick();
  timer = setInterval(tick, interval);
  return true;
}

function stopDaemon() {
  if (timer) { clearInterval(timer); timer = null; }
}

function isRunning() { return !!timer; }

module.exports = {
  getShareConfig,
  setShareConfig,
  defaultShareConfig,
  refreshFromLive,
  localSnapshot,
  localAccountDetail,
  applyAccountDetail,
  checkAuth,
  syncOnce,
  startDaemon,
  stopDaemon,
  isRunning,
};
