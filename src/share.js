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
    const r = new Store().syncActive();
    if (r.changed) console.log(`[share] refreshFromLive: active="${r.name}" snapshot changed`);
  } catch (e) {
    console.log(`[share] refreshFromLive failed: ${e.message}`);
  }
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
      resetsAt: acct.resetsAt || null,
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
    resetsAt: acct.resetsAt || null,
    emailAddress: acct.emailAddress,
    displayName: acct.displayName,
    organizationName: acct.organizationName,
    accountUuid: acct.accountUuid,
    userID: acct.userID,
    credentials: fileExists(cp) ? (() => { try { return readJson(cp); } catch { return null; } })() : null,
    stateSnapshot: fileExists(sp) ? (() => { try { return readJson(sp); } catch { return null; } })() : null,
  };
}

function applyAccountDetail(detail) {
  if (!detail || !detail.name) throw new Error('detail.name required');
  const name = sanitizeName(detail.name);
  const config = readConfig();
  config.accounts = config.accounts || {};
  config.deletedAccounts = config.deletedAccounts || {};

  const prev = config.accounts[name];
  console.log(`[share] applyAccountDetail "${name}" type=${detail.type||'oauth'} expiresAt=${detail.expiresAt||'-'} prev=${prev ? `expiresAt=${prev.expiresAt||'-'}` : 'new'}`);

  // 墓碑保护：若本端已有墓碑，仅当 detail.createdAt > 墓碑 deletedAt 才允许复活
  const tomb = config.deletedAccounts[name];
  const detailCreatedAt = detail.createdAt || detail.importedAt || null;
  if (tomb && tomb.deletedAt) {
    if (!detailCreatedAt || detailCreatedAt <= tomb.deletedAt) {
      console.log(`[share] applyAccountDetail "${name}" rejected: tombstone deletedAt=${tomb.deletedAt} >= createdAt=${detailCreatedAt}`);
      return { applied: false, reason: 'tombstone-protected' };
    }
    console.log(`[share] applyAccountDetail "${name}" reviving: createdAt=${detailCreatedAt} > tombstone deletedAt=${tomb.deletedAt}`);
    delete config.deletedAccounts[name];
  }

  const now = new Date().toISOString();
  let snapshotChanged = false;
  if (detail.type === 'apikey') {
    const prev = config.accounts[name];
    snapshotChanged = !prev || prev.authToken !== detail.authToken || prev.baseUrl !== (detail.baseUrl || null);
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
      const cp = credentialsSnapshotPath(name);
      const oldCred = fileExists(cp) ? (() => { try { return fs.readFileSync(cp, 'utf8'); } catch { return ''; } })() : '';
      const newCred = JSON.stringify(detail.credentials, null, 2);
      if (newCred !== oldCred) snapshotChanged = true;
      atomicWriteJson(cp, detail.credentials);
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
      resetsAt: detail.resetsAt || null,
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

  // Do not call switchAccount() from sync. When two nodes both have this account
  // active, that would make both sides refresh OAuth tokens and invalidate each
  // other in a loop. The snapshot is updated; live credentials change only on an
  // explicit local switch/login.
  const after = readConfig();
  if (after.activeAccount === name && snapshotChanged) {
    console.log(`[share] applyAccountDetail "${name}" is active + snapshot changed; live refresh deferred`);
  } else if (after.activeAccount === name) {
    console.log(`[share] applyAccountDetail "${name}" is active but snapshot unchanged`);
  }
  return { applied: true };
}

// ── Sync engine ─────────────────────────────────────────────────────────────

async function syncOnce(log = () => {}) {
  const cfg = getShareConfig();
  if (!cfg?.enabled) return { skipped: 'disabled' };
  if (!cfg.peerUrl) return { skipped: '主节点模式（无 peer URL，不主动同步）' };
  if (!cfg.secret) return { skipped: 'no secret' };

  log(`sync round start, peer=${cfg.peerUrl}`);

  let peer;
  try {
    peer = await callPeer(cfg.peerUrl, '/api/share/snapshot', cfg.secret);
  } catch (e) {
    setShareConfig({ lastError: `snapshot: ${e.message}`, lastSyncAt: new Date().toISOString() });
    log(`sync round failed: cannot fetch peer snapshot: ${e.message}`);
    return { error: e.message };
  }

  // 每轮 sync 顺便续注册（主节点 follower 列表有 1h TTL）
  _registerSelfToMaster(cfg, () => {});

  const local = localSnapshot();
  // 记录本端和对端快照概要，方便排查方向决策
  for (const name of new Set([...Object.keys(local.accounts), ...Object.keys(peer.accounts || {})])) {
    const la = local.accounts[name];
    const pa = (peer.accounts || {})[name];
    const lInfo = la ? `type=${la.type||'oauth'} hash=${la.hash} expiresAt=${la.expiresAt||'-'} resetsAt=${la.resetsAt||'-'} updatedAt=${la.updatedAt||'-'}` : 'absent';
    const pInfo = pa ? `type=${pa.type||'oauth'} hash=${pa.hash} expiresAt=${pa.expiresAt||'-'} resetsAt=${pa.resetsAt||'-'} updatedAt=${pa.updatedAt||'-'}` : 'absent';
    log(`  account "${name}": local=[${lInfo}] peer=[${pInfo}]`);
  }
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

    // ─── 双方都活着：按版本号决策 ─────────────────────────────────────────
    if (la && pa) {
      const isOauth = (la.type || pa.type) === 'oauth' || (!la.type && !pa.type);
      let localVer, peerVer, label;
      if (isOauth) {
        // OAuth 用 expiresAt（~8h token 有效期）+ resetsAt（~5h 用量窗口）判方向。
        // 取两者中较大的作为版本号：8h 内 token 不变但用量刷新时 resetsAt 会前进。
        const localExp = la.expiresAt || 0;
        const peerExp = pa.expiresAt || 0;
        const localReset = la.resetsAt || 0;
        const peerReset = pa.resetsAt || 0;
        const localMax = Math.max(localExp, localReset);
        const peerMax = Math.max(peerExp, peerReset);
        if (localMax !== peerMax) {
          localVer = localMax;
          peerVer = peerMax;
          label = localExp !== peerExp ? 'expiresAt' : 'resetsAt';
        } else {
          if (la.hash === pa.hash) continue;
          localVer = new Date(la.updatedAt || 0).getTime();
          peerVer = new Date(pa.updatedAt || 0).getTime();
          label = 'updatedAt/hash';
        }
      } else {
        if (la.hash === pa.hash) continue;
        localVer = new Date(la.updatedAt || 0).getTime();
        peerVer = new Date(pa.updatedAt || 0).getTime();
        label = 'updatedAt';
      }
      const direction = peerVer > localVer ? 'pull' : localVer > peerVer ? 'push' : 'pull';
      log(`  "${name}" direction=${direction} by ${label}: local=${localVer} peer=${peerVer} diff=${peerVer - localVer}`);
      if (direction === 'pull') {
        try {
          const detail = await callPeer(cfg.peerUrl, `/api/share/account?name=${encodeURIComponent(name)}`, cfg.secret);
          const r = applyAccountDetail(detail);
          if (r?.applied !== false) { pulled++; log(`  "${name}" pull applied`); }
          else { log(`  "${name}" pull rejected: ${r?.reason || 'unknown'}`); }
        } catch (e) { log(`  "${name}" pull failed: ${e.message}`); }
      } else {
        const detail = localAccountDetail(name);
        try {
          await callPeer(cfg.peerUrl, '/api/share/account', cfg.secret, { method: 'POST', body: detail });
          pushed++;
          log(`  "${name}" push applied`);
        } catch (e) { log(`  "${name}" push failed: ${e.message}`); }
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
  log(`sync round done: pulled=${pulled} pushed=${pushed} deletePulled=${deletePulled} deletePushed=${deletePushed}`);
  setShareConfig({
    lastSyncAt: new Date().toISOString(),
    lastResult: result,
    lastError: null,
  });
  return result;
}

// ── Eager notify: 快照变更时主动通知，不等下一轮轮询 ─────────────────────────
//
// 从节点变更 → POST /api/share/notify 给主节点 → 主节点广播给所有从节点
// 主节点变更 → 直接广播给所有从节点
// 广播 = 把变更账号的 detail POST /api/share/account 到每个从节点

const _followers = new Map();  // nodeId → { url, lastSeen }

function registerFollower(nodeId, url) {
  if (!nodeId || !url) return;
  _followers.set(nodeId, { url: url.replace(/\/$/, ''), lastSeen: Date.now() });
  // 清理 1h 没心跳的
  const cutoff = Date.now() - 3600_000;
  for (const [id, f] of _followers) {
    if (f.lastSeen < cutoff) _followers.delete(id);
  }
}

function listFollowers() {
  return [..._followers.entries()].map(([id, f]) => ({ nodeId: id, ...f }));
}

function _broadcastToFollowers(accountName, excludeNodeId) {
  const cfg = getShareConfig();
  if (!cfg?.enabled || !cfg.secret) return;
  const detail = localAccountDetail(accountName);
  if (!detail) return;
  for (const [nodeId, { url }] of _followers) {
    if (nodeId === excludeNodeId) continue;
    callPeer(url, '/api/share/account', cfg.secret, { method: 'POST', body: detail })
      .then(() => console.log(`[share] broadcast "${accountName}" → ${nodeId.slice(0, 6)} OK`))
      .catch((e) => console.log(`[share] broadcast "${accountName}" → ${nodeId.slice(0, 6)} failed: ${e.message}`));
  }
}

function notifyChange(accountName) {
  const cfg = getShareConfig();
  if (!cfg?.enabled || !cfg.secret) return;
  if (!accountName) {
    const config = readConfig();
    accountName = config.activeAccount;
  }
  if (!accountName) return;

  if (!cfg.peerUrl) {
    // 主节点：直接广播给所有从节点
    _broadcastToFollowers(accountName);
  } else {
    // 从节点：通知主节点，由主节点广播
    const detail = localAccountDetail(accountName);
    if (!detail) return;
    callPeer(cfg.peerUrl, '/api/share/notify', cfg.secret, {
      method: 'POST',
      body: { accountName, detail, sourceNodeId: getNodeId() },
    })
      .then(() => console.log(`[share] notify master "${accountName}" OK`))
      .catch((e) => console.log(`[share] notify master "${accountName}" failed: ${e.message}`));
  }
}

// ── Daemon timer ────────────────────────────────────────────────────────────

let timer = null;

function _registerSelfToMaster(cfg, log) {
  const { readWebPid } = require('./utils');
  const info = readWebPid();
  if (!info) return;
  const bindAddr = info.bind === '0.0.0.0' ? '127.0.0.1' : (info.bind || '127.0.0.1');
  const selfUrl = `http://${bindAddr}:${info.port}`;
  callPeer(cfg.peerUrl, '/api/share/register', cfg.secret, {
    method: 'POST',
    body: { nodeId: getNodeId(), url: selfUrl },
  })
    .then(() => log(`[share] registered to master as ${selfUrl}`))
    .catch((e) => log(`[share] register failed: ${e.message}`));
}

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
  _registerSelfToMaster(cfg, log);
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
  registerFollower,
  listFollowers,
  notifyChange,
  _broadcastToFollowers,
};
