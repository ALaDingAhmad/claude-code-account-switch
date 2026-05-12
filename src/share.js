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

function getNodeId() {
  const c = readConfig();
  if (c.nodeId && typeof c.nodeId === 'string' && c.nodeId.length >= 8) return c.nodeId;
  c.nodeId = crypto.randomBytes(8).toString('hex');
  saveConfig(c);
  return c.nodeId;
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

function getLastWebPort() {
  const c = readConfig();
  const p = c.lastWebPort;
  if (typeof p === 'number' && p >= 1 && p <= 65535) return p;
  return null;
}

function setLastWebPort(port) {
  if (typeof port !== 'number' || port < 1 || port > 65535) return;
  const c = readConfig();
  if (c.lastWebPort === port) return;
  c.lastWebPort = port;
  saveConfig(c);
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
      createdAt: acct.createdAt || acct.importedAt || null,
      updatedAt: acct.updatedAt || null,
      expiresAt: acct.expiresAt || null,
      hash: hashAccount(acct, name),
    };
  }
  // 墓碑：只暴露名字、deletedAt、createdAt（用于双方决策）
  const deletedAccounts = {};
  for (const [name, tomb] of Object.entries(config.deletedAccounts || {})) {
    deletedAccounts[name] = {
      deletedAt: tomb.deletedAt || null,
      createdAt: tomb.createdAt || null,
    };
  }
  return {
    activeAccount: config.activeAccount || null,
    lastSwitchedAt: config.lastSwitchedAt || null,
    accounts,
    deletedAccounts,
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
      createdAt: acct.createdAt || acct.importedAt || null,
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
    createdAt: acct.createdAt || acct.importedAt || null,
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
  config.deletedAccounts = config.deletedAccounts || {};

  // 墓碑保护：若本端已有墓碑，仅当 detail.createdAt > 墓碑 deletedAt 才允许复活
  const tomb = config.deletedAccounts[name];
  const detailCreatedAt = detail.createdAt || detail.importedAt || null;
  if (tomb && tomb.deletedAt) {
    if (!detailCreatedAt || detailCreatedAt <= tomb.deletedAt) {
      // 本端墓碑更新，拒绝复活——这是"对端推过来的是删除前的旧账号"
      return { applied: false, reason: 'tombstone-protected' };
    }
    // 复活：清掉墓碑
    delete config.deletedAccounts[name];
  }

  const now = new Date().toISOString();
  if (detail.type === 'apikey') {
    config.accounts[name] = {
      type: 'apikey',
      name,
      authToken: detail.authToken,
      authTokenMasked: detail.authTokenMasked || maskToken(detail.authToken),
      baseUrl: detail.baseUrl || null,
      createdAt: detailCreatedAt || now,
      importedAt: detail.importedAt || now,
      updatedAt: detail.updatedAt || now,
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
      createdAt: detailCreatedAt || now,
      importedAt: detail.importedAt || now,
      updatedAt: detail.updatedAt || now,
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
  return { applied: true };
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
  let deletePulled = 0;
  let deletePushed = 0;
  const peerAccounts = peer.accounts || {};
  const localAccounts = local.accounts;
  const peerDeleted = peer.deletedAccounts || {};
  const localDeleted = local.deletedAccounts || {};

  // 收集所有需要处理的账号名（活+死并集）
  const allNames = new Set([
    ...Object.keys(peerAccounts), ...Object.keys(localAccounts),
    ...Object.keys(peerDeleted),  ...Object.keys(localDeleted),
  ]);

  for (const name of allNames) {
    const pa = peerAccounts[name];   // 对端活账号
    const la = localAccounts[name];  // 本端活账号
    const pd = peerDeleted[name];    // 对端墓碑
    const ld = localDeleted[name];   // 本端墓碑

    // ─── 双方都活着：按内容版本号决策（原有逻辑）─────────────────────────
    if (la && pa) {
      if (la.hash === pa.hash) continue;
      const isOauth = (la.type || pa.type) === 'oauth' || (!la.type && !pa.type);
      let localVer, peerVer, label;
      if (isOauth) {
        localVer = la.expiresAt || 0;
        peerVer = pa.expiresAt || 0;
        label = 'expiresAt';
      } else {
        localVer = new Date(la.updatedAt || 0).getTime();
        peerVer = new Date(pa.updatedAt || 0).getTime();
        label = 'updatedAt';
      }
      const direction = peerVer > localVer ? 'pull' : localVer > peerVer ? 'push' : 'pull';
      if (direction === 'pull') {
        try {
          const detail = await callPeer(cfg.peerUrl, `/api/share/account?name=${encodeURIComponent(name)}`, cfg.secret);
          const r = applyAccountDetail(detail);
          if (r?.applied !== false) { pulled++; log(`pulled "${name}" (peer ${label} bigger by ${peerVer - localVer})`); }
        } catch (e) { log(`pull "${name}" failed: ${e.message}`); }
      } else {
        const detail = localAccountDetail(name);
        try {
          await callPeer(cfg.peerUrl, '/api/share/account', cfg.secret, { method: 'POST', body: detail });
          pushed++;
          log(`pushed "${name}" (local ${label} bigger by ${localVer - peerVer})`);
        } catch (e) { log(`push "${name}" failed: ${e.message}`); }
      }
      continue;
    }

    // ─── 仅对端有活账号：本端无（或墓碑）─────────────────────────────────
    if (pa && !la) {
      // 本端墓碑保护：peer createdAt 必须晚于本端 deletedAt
      if (ld && ld.deletedAt && (!pa.createdAt || pa.createdAt <= ld.deletedAt)) {
        // 反过来通知对端删（本端墓碑是权威的）
        try {
          await callPeer(cfg.peerUrl, '/api/share/delete', cfg.secret, {
            method: 'POST',
            body: { name, deletedAt: ld.deletedAt },
          });
          deletePushed++;
          log(`pushed delete "${name}" (local tombstone deletedAt=${ld.deletedAt} >= peer createdAt=${pa.createdAt || 'unknown'})`);
        } catch (e) { log(`push-delete "${name}" failed: ${e.message}`); }
        continue;
      }
      // 拉新账号（applyAccountDetail 内部还会做一次墓碑保护，双保险）
      try {
        const detail = await callPeer(cfg.peerUrl, `/api/share/account?name=${encodeURIComponent(name)}`, cfg.secret);
        const r = applyAccountDetail(detail);
        if (r?.applied !== false) { pulled++; log(`pulled new account: ${name}`); }
        else log(`refused to revive "${name}" (tombstone-protected)`);
      } catch (e) { log(`pull "${name}" failed: ${e.message}`); }
      continue;
    }

    // ─── 仅本端有活账号：对端无（或墓碑）─────────────────────────────────
    if (la && !pa) {
      // 对端墓碑保护：本端 createdAt 必须晚于对端 deletedAt
      if (pd && pd.deletedAt && (!la.createdAt || la.createdAt <= pd.deletedAt)) {
        // 本端被对端删了，应当本地删除（墓碑较新，权威）
        try {
          const Store = require('./store');
          new Store().applyDeleteAccount(name, pd.deletedAt);
          deletePulled++;
          log(`pulled delete "${name}" (peer tombstone deletedAt=${pd.deletedAt} >= local createdAt=${la.createdAt || 'unknown'})`);
        } catch (e) { log(`pull-delete "${name}" failed: ${e.message}`); }
        continue;
      }
      // 推到对端
      const detail = localAccountDetail(name);
      try {
        await callPeer(cfg.peerUrl, '/api/share/account', cfg.secret, { method: 'POST', body: detail });
        pushed++;
        log(`pushed new account: ${name}`);
      } catch (e) { log(`push "${name}" failed: ${e.message}`); }
      continue;
    }

    // ─── 双方都已删（墓碑）：保留较新的，发送给对方（让对方知道）────────────
    if (ld && pd) {
      if ((ld.deletedAt || '') > (pd.deletedAt || '')) {
        try {
          await callPeer(cfg.peerUrl, '/api/share/delete', cfg.secret, {
            method: 'POST',
            body: { name, deletedAt: ld.deletedAt },
          });
          // 不计 deletePushed，因为对端已是墓碑，等于无操作
        } catch (e) { log(`push-delete "${name}" failed: ${e.message}`); }
      }
      // 本端 deletedAt 较老或相等：什么也不做（对端会自己 push 过来或保持现状）
      continue;
    }

    // ─── 仅本端有墓碑：对端完全没听过 → 推墓碑过去（防对端将来再导入同名又被推回）
    if (ld && !pa && !pd) {
      try {
        await callPeer(cfg.peerUrl, '/api/share/delete', cfg.secret, {
          method: 'POST',
          body: { name, deletedAt: ld.deletedAt },
        });
        deletePushed++;
        log(`pushed tombstone "${name}"`);
      } catch (e) { log(`push-tombstone "${name}" failed: ${e.message}`); }
      continue;
    }

    // ─── 仅对端有墓碑：本端完全没听过 → 拉墓碑过来 ───────────────────────
    if (pd && !la && !ld) {
      try {
        const Store = require('./store');
        new Store().applyDeleteAccount(name, pd.deletedAt);
        deletePulled++;
        log(`pulled tombstone "${name}"`);
      } catch (e) { log(`pull-tombstone "${name}" failed: ${e.message}`); }
      continue;
    }
  }

  const result = { pulled, pushed, deletePulled, deletePushed };
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
  getNodeId,
  getLastWebPort,
  setLastWebPort,
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
