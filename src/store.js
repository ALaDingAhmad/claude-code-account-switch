const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawn } = require('child_process');
const {
  CCS_DIR,
  CONFIG_PATH,
  CREDENTIALS_PATH,
  CLAUDE_STATE_PATH,
  CLAUDE_SETTINGS_PATH,
  ensureCcsDirs,
  atomicWriteJson,
  readJson,
  fileExists,
  sanitizeName,
  credentialsSnapshotPath,
  stateSnapshotPath,
  extractOauth,
  maskToken,
  formatExpiry,
  clearProfileCache,
  readLiveCredentials,
  writeLiveCredentials,
  deleteLiveCredentials,
  liveCredentialsExist,
  IS_MAC,
} = require('./utils');

const USAGE_TABLE_PATH = path.join(CCS_DIR, 'account-usage.json');
const SHARED_CACHE_PATH = path.join(CCS_DIR, 'usage-shared-cache.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const QUERY_PROFILE_SCRIPT = path.join(__dirname, '..', 'scripts', 'query_profile.py');
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// 切换后主动 refresh token：用 snapshot 里的 refresh_token 调 OAuth endpoint，
// 拿到新 access_token + refresh_token + 真实 expiresAt，写回 live + snapshot + config。
// 这样 share sync 拿到的 snapshot 是最新的，不会被对端旧数据覆盖。
// Claude Code 进程重新加载 live credentials 时发现 token 未过期，不会再竞争 refresh。
function _refreshTokenAfterSwitch(accountName, { notify = true } = {}) {
  const live = readLiveCredentials();
  if (!live) return;
  const oauth = extractOauth(live);
  if (!oauth?.refreshToken) return;

  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  const req = https.request(
    {
      hostname: 'platform.claude.com',
      path: '/v1/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-cli/2.1.39 (external, cli)',
      },
      timeout: 15000,
    },
    (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            console.log(`[refresh] ${accountName} HTTP ${res.statusCode}`);
            // refresh 失败也要通知 share sync（用旧 snapshot 总比不通知好）
            if (notify) {
              try { require('./share').notifyChange(accountName); } catch { /* */ }
            }
            return;
          }
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const expiresAt = Date.now() + (data.expires_in || 0) * 1000;
          const newOauth = {
            ...oauth,
            accessToken: data.access_token,
            refreshToken: data.refresh_token || oauth.refreshToken,
            expiresAt,
          };
          if (data.scope) {
            newOauth.scopes = typeof data.scope === 'string' ? data.scope.split(' ') : data.scope;
          }

          // 写回 live credentials（真实 expiresAt）
          const newLive = { ...live, claudeAiOauth: newOauth };
          writeLiveCredentials(newLive);

          // 立即同步到 snapshot + config（让 share sync 拿到最新 expiresAt）
          const store = new AccountStore();
          store._syncActiveSnapshot();
          store._save();

          console.log(`[refresh] ${accountName} OK, expiresAt=${formatExpiry(expiresAt)}, token=...${newOauth.accessToken.slice(-8)}`);

          // refresh 完成后再通知 share sync
          if (notify) {
            try { require('./share').notifyChange(accountName); } catch { /* */ }
          }
        } catch (e) {
          console.log(`[refresh] ${accountName} parse error: ${e.message}`);
          if (notify) {
            try { require('./share').notifyChange(accountName); } catch { /* */ }
          }
        }
      });
    },
  );
  req.on('error', (e) => {
    console.log(`[refresh] ${accountName} network error: ${e.message}`);
    if (notify) {
      try { require('./share').notifyChange(accountName); } catch { /* */ }
    }
  });
  req.on('timeout', () => { req.destroy(); });
  req.write(body);
  req.end();
}

// 异步查 profile API 拿真实订阅状态（pro/free 等），结果写回 config.json 的 livePlan。
// 由 switchAccount 触发：旧 active + 新 active 都查，让守护下次轮询能跳过已降级的号。
// 任何失败静默——最坏情况是 livePlan 没更新，UI 沿用旧值。
function _refreshLivePlanInBackground(name) {
  try {
    if (!name) return;
    const snapPath = credentialsSnapshotPath(name);
    if (!fileExists(snapPath)) return;
    const snap = readJson(snapPath);
    const oauth = extractOauth(snap);
    if (!oauth || !oauth.accessToken) return;

    const py = spawn('python3', [QUERY_PROFILE_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    py.stdout.on('data', (b) => { out += b.toString(); });
    py.stderr.on('data', (b) => { err += b.toString(); });
    py.on('error', (e) => console.log(`[livePlan] spawn error ${name}:`, e.message));
    py.on('close', () => {
      try {
        const r = JSON.parse(out.trim().split('\n').pop() || '{}');
        if (!r.ok) {
          console.log(`[livePlan] ${name} query failed: ${r.error || 'unknown'}`);
          return;
        }
        // 新建实例写回——避免引用调用方那个 store（可能已被改/已 GC）
        const s = new AccountStore();
        s.setLivePlan(name, {
          organizationType: r.organizationType,
          isFree: r.isFree,
        });
        console.log(`[livePlan] ${name} -> ${r.organizationType} (isFree=${r.isFree})`);
      } catch (e) {
        console.log(`[livePlan] ${name} parse error:`, e.message, '| stderr:', err.slice(0, 100));
      }
    });
    py.stdin.write(oauth.accessToken);
    py.stdin.end();
  } catch (e) {
    console.log(`[livePlan] ${name} unexpected error:`, e.message);
  }
}

// v3.11.2：切换前把"被切走的当前号"的 5h 用量数据写进 account-usage.json。
// 数据来源：共享缓存（状态栏/守护刚查过的最新结果）。这是表里唯一的"active 写入时机"——
// 表的语义是切换流水账，不是实时监控；实时数据走共享缓存。
function writeActiveUsageSnapshot(activeAccount) {
  if (!activeAccount) return { ok: false, reason: 'no active' };
  try {
    // 1. 读旧 active token
    if (!fileExists(CREDENTIALS_PATH)) return { ok: false, reason: 'no live credentials' };
    const live = readJson(CREDENTIALS_PATH);
    const token = live?.claudeAiOauth?.accessToken;
    if (!token) return { ok: false, reason: 'no access token in credentials' };

    // 2. 读共享缓存里这个 token 的 usage entry
    if (!fileExists(SHARED_CACHE_PATH)) return { ok: false, reason: 'shared cache missing' };
    const hash = crypto.createHash('md5').update(token).digest('hex').slice(0, 8);
    const cache = readJson(SHARED_CACHE_PATH);
    const entry = cache[`${hash}:${USAGE_URL}`];
    if (!entry || entry.code !== 200) return { ok: false, reason: 'no fresh 200 in shared cache' };

    // 3. 解析 body 拿 5h + reset
    const body = JSON.parse(Buffer.from(entry.body_hex || '', 'hex').toString('utf8'));
    const fh = body.five_hour || {};
    const fiveHour = (fh.utilization != null) ? Number(fh.utilization) : null;
    const resetsAt = fh.resets_at || '';
    if (fiveHour === null) return { ok: false, reason: 'no five_hour in body' };

    // 4. 写表
    let table = {};
    if (fileExists(USAGE_TABLE_PATH)) {
      try { table = readJson(USAGE_TABLE_PATH) || {}; } catch { table = {}; }
    }
    table[activeAccount] = {
      five_hour: fiveHour,
      resets_at: resetsAt,
      checked_at: new Date().toISOString(),
    };
    atomicWriteJson(USAGE_TABLE_PATH, table);
    return { ok: true, fiveHour, resetsAt };
  } catch (e) {
    return { ok: false, reason: `exception: ${e.message}` };
  }
}

class AccountStore {
  constructor() {
    ensureCcsDirs();
    this._config = this._load();
  }

  _defaultConfig() {
    return { version: 2, activeAccount: null, lastSwitchedAt: null, accounts: {}, deletedAccounts: {} };
  }

  _load() {
    if (!fileExists(CONFIG_PATH)) return this._defaultConfig();
    try {
      const c = readJson(CONFIG_PATH);
      return {
        ...this._defaultConfig(),
        ...c,
        accounts: c.accounts || {},
        deletedAccounts: c.deletedAccounts || {},
      };
    } catch {
      return this._defaultConfig();
    }
  }

  _save() {
    atomicWriteJson(CONFIG_PATH, this._config);
  }

  _entry(name, raw) {
    if (raw.type === 'apikey') {
      return { ...raw, name: raw.name || name };
    }
    return {
      ...raw,
      name: raw.name || name,
      snapshotPath: credentialsSnapshotPath(name),
      statePath: stateSnapshotPath(name),
      accessTokenMasked: raw.accessTokenMasked || maskToken(raw.accessToken),
    };
  }

  _readLiveState() {
    if (!fileExists(CLAUDE_STATE_PATH)) return {};
    try { return readJson(CLAUDE_STATE_PATH); } catch { return {}; }
  }

  _readSettings() {
    if (!fileExists(CLAUDE_SETTINGS_PATH)) return {};
    try { return readJson(CLAUDE_SETTINGS_PATH); } catch { return {}; }
  }

  _restoreStateFields(snapshot) {
    const live = this._readLiveState();
    const next = { ...live };
    if (Object.prototype.hasOwnProperty.call(snapshot, 'userID')) next.userID = snapshot.userID;
    if (snapshot.oauthAccount) {
      next.oauthAccount = snapshot.oauthAccount;
    } else {
      delete next.oauthAccount;
    }
    atomicWriteJson(CLAUDE_STATE_PATH, next);
  }

  // 切换/退出前把当前 live credentials 回写到 active 账号快照，
  // 防止 Claude Code 自动 rotate 后旧快照里的 refresh_token 失效。
  _syncActiveSnapshot() {
    const active = this._config.activeAccount;
    if (!active) return;
    const cur = this._config.accounts[active];
    if (!cur || cur.type !== 'oauth') return;

    const live = readLiveCredentials();
    if (!live) return;
    const oauth = extractOauth(live);
    if (!oauth || !oauth.accessToken || !oauth.refreshToken) return;

    const snapData = JSON.parse(JSON.stringify(live));

    const snapPath = credentialsSnapshotPath(active);
    const newContent = JSON.stringify(snapData);
    const oldContent = fileExists(snapPath)
      ? (() => { try { return fs.readFileSync(snapPath, 'utf8'); } catch { return ''; } })()
      : '';
    if (newContent === oldContent) {
      console.log(`[store] _syncActiveSnapshot "${active}": snapshot unchanged, skip`);
      return false;
    }

    atomicWriteJson(snapPath, snapData);
    const liveState = this._readLiveState();
    atomicWriteJson(stateSnapshotPath(active), {
      userID: liveState.userID || null,
      oauthAccount: liveState.oauthAccount || null,
    });

    const snapOauth = extractOauth(snapData);
    const prevExp = cur.expiresAt;
    if (snapOauth.expiresAt && (!cur.expiresAt || snapOauth.expiresAt > cur.expiresAt)) {
      cur.expiresAt = snapOauth.expiresAt;
    }
    cur.subscriptionType = oauth.subscriptionType || cur.subscriptionType;
    cur.accessTokenMasked = maskToken(oauth.accessToken);
    if (liveState.oauthAccount) {
      cur.emailAddress = liveState.oauthAccount.emailAddress || cur.emailAddress;
      cur.displayName = liveState.oauthAccount.displayName || cur.displayName;
      cur.organizationName = liveState.oauthAccount.organizationName || cur.organizationName;
      cur.accountUuid = liveState.oauthAccount.accountUuid || cur.accountUuid;
    }
    if (liveState.userID) cur.userID = liveState.userID;

    // 从共享缓存读 active 账号的 resets_at，写入 config 供 share sync 方向判断
    try {
      if (oauth.accessToken && fileExists(SHARED_CACHE_PATH)) {
        const hash = crypto.createHash('md5').update(oauth.accessToken).digest('hex').slice(0, 8);
        const cache = readJson(SHARED_CACHE_PATH);
        const entry = cache[`${hash}:${USAGE_URL}`];
        if (entry && entry.code === 200 && entry.body_hex) {
          const body = JSON.parse(Buffer.from(entry.body_hex, 'hex').toString('utf8'));
          const ra = body.five_hour?.resets_at;
          if (ra) {
            const raMs = new Date(ra).getTime();
            if (raMs && (!cur.resetsAt || raMs > cur.resetsAt)) {
              cur.resetsAt = raMs;
            }
          }
        }
      }
    } catch { /* 共享缓存不可用不影响核心同步 */ }

    cur.updatedAt = new Date().toISOString();
    console.log(`[store] _syncActiveSnapshot "${active}": snapshot updated, expiresAt ${prevExp||'-'} → ${cur.expiresAt||'-'}, resetsAt=${cur.resetsAt||'-'}, token=${cur.accessTokenMasked}`);
    return true;
  }

  // ── 公开 API ──────────────────────────────────────────────────────────────

  getLiveEmail() {
    const state = this._readLiveState();
    return state.oauthAccount?.emailAddress || null;
  }

  // 导入 OAuth 账号（从当前 live credentials 读取）
  importAccount(name, sourcePath = null) {
    const n = sanitizeName(name);
    let sourceJson;
    if (sourcePath) {
      try { sourceJson = readJson(sourcePath); } catch (e) {
        throw new Error(`Cannot read credentials from "${sourcePath}": ${e.message}`);
      }
    } else {
      sourceJson = readLiveCredentials();
    }
    if (!sourceJson) throw new Error('No live OAuth credentials found');
    const oauth = extractOauth(sourceJson);
    if (!oauth || !oauth.accessToken || !oauth.refreshToken) {
      throw new Error('Invalid live OAuth credentials');
    }

    const liveState = this._readLiveState();
    const liveOauth = liveState.oauthAccount || {};
    const prev = this._config.accounts[n] || {};

    atomicWriteJson(credentialsSnapshotPath(n), sourceJson);
    atomicWriteJson(stateSnapshotPath(n), {
      userID: liveState.userID || null,
      oauthAccount: liveState.oauthAccount || null,
    });

    const now = new Date().toISOString();
    this._config.accounts[n] = {
      type: 'oauth',
      name: n,
      accessTokenMasked: maskToken(oauth.accessToken),
      subscriptionType: oauth.subscriptionType || 'unknown',
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
      expiresAt: oauth.expiresAt || null,
      emailAddress: liveOauth.emailAddress || prev.emailAddress || null,
      displayName: liveOauth.displayName || prev.displayName || null,
      organizationName: liveOauth.organizationName || prev.organizationName || null,
      accountUuid: liveOauth.accountUuid || prev.accountUuid || null,
      userID: liveState.userID || prev.userID || null,
      createdAt: prev.createdAt || now,
      importedAt: prev.importedAt || now,
      updatedAt: now,
    };
    this._config.activeAccount = n;
    this._config.lastSwitchedAt = now;
    this._save();
    return this._entry(n, this._config.accounts[n]);
  }

  // 导入 API Key 账号
  importApiKeyAccount(name, authToken, baseUrl) {
    const n = sanitizeName(name);
    if (!authToken) throw new Error('authToken is required');

    const prev = this._config.accounts[n] || {};
    const now = new Date().toISOString();
    this._config.accounts[n] = {
      type: 'apikey',
      name: n,
      authToken,
      authTokenMasked: maskToken(authToken),
      baseUrl: baseUrl || null,
      createdAt: prev.createdAt || now,
      importedAt: prev.importedAt || now,
      updatedAt: now,
    };
    this._switchApiKey(n, this._config.accounts[n]);
    this._config.activeAccount = n;
    this._config.lastSwitchedAt = new Date().toISOString();
    this._save();
    return this._entry(n, this._config.accounts[n]);
  }

  switchAccount(name, { notify = true } = {}) {
    const n = sanitizeName(name);
    const acct = this._config.accounts[n];
    if (!acct) throw new Error(`Unknown account "${n}"`);

    // v3.11.2：切换前把被切走的当前号 5h 数据写入 account-usage.json（流水账）。
    // 数据从共享缓存读取——状态栏 / 守护刚查过的最新结果。
    // 切换到自己时跳过（活账户没换）。
    const prevActive = this._config.activeAccount;
    if (prevActive && prevActive !== n) {
      writeActiveUsageSnapshot(prevActive);
    }

    if (n !== this._config.activeAccount) this._syncActiveSnapshot();

    if (acct.type === 'apikey') {
      this._switchApiKey(n, acct);
    } else {
      this._switchOauth(n, acct);
    }
    clearProfileCache();

    this._config.activeAccount = n;
    this._config.lastSwitchedAt = new Date().toISOString();
    this._save();

    // 异步刷新 livePlan：旧 active（可能刚降级到 free，让守护下次轮询能跳过）+
    // 新 active（拿真实订阅等级显示）。OAuth 才查；不阻塞返回；失败静默。
    if (prevActive && prevActive !== n) _refreshLivePlanInBackground(prevActive);
    if (acct.type === 'oauth') _refreshLivePlanInBackground(n);

    if (acct.type === 'oauth') {
      // OAuth：先 refresh 拿到真实 expiresAt 写入 snapshot，再通知 share sync。
      // 避免 share sync 拿到故意过期的旧 expiresAt，导致对端旧数据反向覆盖。
      _refreshTokenAfterSwitch(n, { notify });
    } else if (notify) {
      // API Key：无需 refresh，直接通知
      try { require('./share').notifyChange(n); } catch { /* share 未启用时静默 */ }
    }

    return this._entry(n, this._config.accounts[n]);
  }

  // 写入 profile API 查回的真实订阅状态。web.js 切换前后异步调 query_profile.py
  // 拿到结果后写回。{ organizationType, isFree, fetchedAt }；查询失败传 null 跳过。
  setLivePlan(name, plan) {
    const n = sanitizeName(name);
    const acct = this._config.accounts[n];
    if (!acct || acct.type !== 'oauth') return;
    if (!plan || typeof plan !== 'object') return;
    acct.livePlan = {
      organizationType: plan.organizationType || '',
      isFree: !!plan.isFree,
      fetchedAt: new Date().toISOString(),
    };
    this._save();
  }

  _switchOauth(n, prev) {
    const snapPath = credentialsSnapshotPath(n);
    if (!fileExists(snapPath)) throw new Error(`Snapshot not found for "${n}"`);
    let snapshot;
    try {
      snapshot = readJson(snapPath);
    } catch (e) {
      throw new Error(`Snapshot for "${n}" is corrupted (${e.message}). Re-import this account to fix.`);
    }
    const oauth = extractOauth(snapshot);
    if (!oauth || !oauth.accessToken || !oauth.refreshToken) {
      throw new Error(`Snapshot for "${n}" is invalid`);
    }

    const statePath = stateSnapshotPath(n);
    let stateSnap = null;
    if (fileExists(statePath)) {
      try { stateSnap = readJson(statePath); } catch { /* corrupted state → treat as absent */ }
    }

    // v3.12.0：写入 live 时强制 expiresAt 已过期，逼 Claude Code 进程走 refresh 流程
    // 拿到新 access_token 并刷新内存里的 memoize 缓存。否则进程会继续用旧号 token 直到
    // 401 才发现已切号，期间每条用户消息可能被重试多次，token 异常消耗。
    // snapshot 文件保持原样（未污染），refresh 后 Claude Code 写回的新凭证会由
    // _syncActiveSnapshot 在下次切换前同步回 snapshot。
    const liveCreds = JSON.parse(JSON.stringify(snapshot));
    if (liveCreds.claudeAiOauth) {
      liveCreds.claudeAiOauth.expiresAt = Date.now() - 1000;
    }
    writeLiveCredentials(liveCreds);
    if (stateSnap) this._restoreStateFields(stateSnap);

    // 切换到 oauth 时清除 settings.json 里的 apikey env
    this._clearApikeyEnv();

    // Windows: 从 API Key 切回时 credentials 是从无到有，再 touch 一次确保 Claude Code 进程感知 mtime 变化
    if (!IS_MAC) {
      setTimeout(() => {
        try {
          const now = new Date();
          fs.utimesSync(CREDENTIALS_PATH, now, now);
        } catch { /* ignore */ }
      }, 800);
    }

    this._config.accounts[n] = {
      ...prev,
      type: 'oauth',
      accessTokenMasked: maskToken(oauth.accessToken),
      subscriptionType: oauth.subscriptionType || prev.subscriptionType || 'unknown',
      scopes: Array.isArray(oauth.scopes) ? oauth.scopes : prev.scopes || [],
      expiresAt: oauth.expiresAt || prev.expiresAt || null,
      emailAddress: stateSnap?.oauthAccount?.emailAddress || prev.emailAddress || null,
      displayName: stateSnap?.oauthAccount?.displayName || prev.displayName || null,
      organizationName: stateSnap?.oauthAccount?.organizationName || prev.organizationName || null,
      accountUuid: stateSnap?.oauthAccount?.accountUuid || prev.accountUuid || null,
      userID: stateSnap?.userID || prev.userID || null,
      updatedAt: new Date().toISOString(),
    };
  }

  _switchApiKey(n, prev) {
    const settings = this._readSettings();
    const env = settings.env || {};
    env.ANTHROPIC_AUTH_TOKEN = prev.authToken;
    env.ANTHROPIC_BASE_URL = prev.baseUrl || '';
    env.ANTHROPIC_API_KEY = '';
    atomicWriteJson(CLAUDE_SETTINGS_PATH, { ...settings, env });

    // 清空 OAuth 凭证和账号状态，避免状态栏继续显示旧 OAuth 用户
    deleteLiveCredentials();
    const live = this._readLiveState();
    const next = { ...live };
    delete next.userID;
    delete next.oauthAccount;
    atomicWriteJson(CLAUDE_STATE_PATH, next);

    this._config.accounts[n] = {
      ...prev,
      updatedAt: new Date().toISOString(),
    };
  }

  _clearApikeyEnv() {
    if (!fileExists(CLAUDE_SETTINGS_PATH)) return;
    const settings = this._readSettings();
    const env = settings.env || {};
    // 置空字符串而非 delete：Claude Code 热重载 settings.json env 是 merge 语义，
    // 删除字段时不会清掉进程内存里已经设过的旧值，必须显式 "" 覆盖
    env.ANTHROPIC_AUTH_TOKEN = '';
    env.ANTHROPIC_BASE_URL = '';
    env.ANTHROPIC_API_KEY = '';
    atomicWriteJson(CLAUDE_SETTINGS_PATH, { ...settings, env });
  }

  editAccount({ oldName, newName, type, authToken, baseUrl, emailAddress, displayName, organizationName }) {
    const on = sanitizeName(oldName);
    const nn = sanitizeName(newName);
    const acct = this._config.accounts[on];
    if (!acct) throw new Error(`Unknown account "${on}"`);
    if (nn !== on && this._config.accounts[nn]) throw new Error(`Account "${nn}" already exists`);

    if (type === 'apikey') {
      if (!authToken) throw new Error('authToken is required');
      acct.authToken = authToken;
      acct.authTokenMasked = maskToken(authToken);
      acct.baseUrl = baseUrl || null;
      // 如果是当前激活账号，立即写入 settings.json
      if (this._config.activeAccount === on) this._switchApiKey(on, acct);
    } else {
      if (emailAddress !== undefined) acct.emailAddress = emailAddress;
      if (displayName !== undefined) acct.displayName = displayName;
      if (organizationName !== undefined) acct.organizationName = organizationName;
    }
    acct.updatedAt = new Date().toISOString();

    // 改名
    if (nn !== on) {
      this._config.accounts[nn] = { ...acct, name: nn };
      delete this._config.accounts[on];
      if (this._config.activeAccount === on) this._config.activeAccount = nn;
      // 重命名快照文件
      const oldSnap = credentialsSnapshotPath(on);
      const newSnap = credentialsSnapshotPath(nn);
      const oldState = stateSnapshotPath(on);
      const newState = stateSnapshotPath(nn);
      try { if (fileExists(oldSnap)) require('fs').renameSync(oldSnap, newSnap); } catch { /* ignore */ }
      try { if (fileExists(oldState)) require('fs').renameSync(oldState, newState); } catch { /* ignore */ }
    }

    this._save();
  }

  removeAccount(name) {
    const n = sanitizeName(name);
    const acct = this._config.accounts[n];
    if (!acct) throw new Error(`Unknown account "${n}"`);
    if (this._config.activeAccount === n) {
      throw new Error(`Cannot delete active account "${n}", switch to another account first`);
    }

    // credentials/state 文件直接删（不复活）
    const snapPath = credentialsSnapshotPath(n);
    const statePath = stateSnapshotPath(n);
    try { if (fileExists(snapPath)) fs.unlinkSync(snapPath); } catch { /* ignore */ }
    try { if (fileExists(statePath)) fs.unlinkSync(statePath); } catch { /* ignore */ }

    // 移动到 deletedAccounts，留下墓碑用于同步
    const tomb = {
      ...acct,
      excluded: true,
      deletedAt: new Date().toISOString(),
    };
    // 敏感数据清掉，墓碑只保留身份和时间戳
    if (tomb.type === 'apikey') {
      delete tomb.authToken;
    }
    this._config.deletedAccounts = this._config.deletedAccounts || {};
    this._config.deletedAccounts[n] = tomb;
    delete this._config.accounts[n];
    this._save();
  }

  clearLiveAuth() {
    this._syncActiveSnapshot();
    deleteLiveCredentials();
    this._clearApikeyEnv();
    clearProfileCache();
    const live = this._readLiveState();
    const next = { ...live };
    delete next.userID;
    delete next.oauthAccount;
    atomicWriteJson(CLAUDE_STATE_PATH, next);
    this._config.activeAccount = null;
    this._config.lastSwitchedAt = new Date().toISOString();
    this._save();
  }

  // 主动同步：把当前 live credentials 回写到 active 账号快照
  syncActive() {
    const active = this._config.activeAccount;
    if (!active) return { synced: false, reason: 'no active account' };
    const acct = this._config.accounts[active];
    if (!acct || acct.type !== 'oauth') {
      return { synced: false, reason: 'active account is not oauth' };
    }
    const live = readLiveCredentials();
    if (!live) return { synced: false, reason: 'no live credentials' };
    const changed = this._syncActiveSnapshot();
    this._save();
    return { synced: true, name: active, changed: !!changed };
  }

  listAccounts() {
    const result = {};
    const liveCreds = readLiveCredentials();
    const liveOauth = liveCreds && extractOauth(liveCreds);
    for (const [n, raw] of Object.entries(this._config.accounts)) {
      const entry = this._entry(n, raw);
      const isActive = n === this._config.activeAccount;
      // 活跃 OAuth 账号：用 live credentials 的最新 token 元数据覆盖 snapshot
      if (isActive && raw.type === 'oauth' && liveOauth) {
        entry.expiresAt = liveOauth.expiresAt || entry.expiresAt;
        entry.subscriptionType = liveOauth.subscriptionType || entry.subscriptionType;
        entry.accessTokenMasked = maskToken(liveOauth.accessToken);
      }
      // loggable：能否切到该账号。OAuth 需要快照存在且含完整 access+refresh token；
      // 活跃 OAuth 账号若 live credentials 有效也算 loggable（即便快照尚未回写）。
      let loggable = true;
      if (raw.type === 'oauth') {
        loggable = false;
        if (isActive && liveOauth && liveOauth.accessToken && liveOauth.refreshToken) {
          loggable = true;
        } else {
          const snapPath = credentialsSnapshotPath(n);
          if (fileExists(snapPath)) {
            try {
              const snap = readJson(snapPath);
              const o = extractOauth(snap);
              if (o && o.accessToken && o.refreshToken) loggable = true;
            } catch { /* ignore: 损坏快照视为不可切 */ }
          }
        }
      }
      result[n] = {
        ...entry,
        isActive,
        loggable,
        livePlan: raw.livePlan || null,
        expiresIn: raw.type === 'apikey' ? null : formatExpiry(entry.expiresAt),
      };
    }
    return result;
  }

  getStatus() {
    const { activeAccount, accounts, lastSwitchedAt } = this._config;
    const raw = activeAccount ? accounts[activeAccount] : null;
    let liveOauth = null;
    if (raw && raw.type === 'oauth') {
      const liveCreds = readLiveCredentials();
      liveOauth = liveCreds && extractOauth(liveCreds);
    }
    return {
      activeAccount,
      accountCount: Object.keys(accounts).length,
      lastSwitchedAt,
      credentialsPath: CREDENTIALS_PATH,
      statePath: CLAUDE_STATE_PATH,
      active: raw
        ? raw.type === 'apikey'
          ? {
              type: 'apikey',
              authTokenMasked: raw.authTokenMasked,
              baseUrl: raw.baseUrl || null,
            }
          : {
              type: 'oauth',
              subscriptionType: liveOauth?.subscriptionType || raw.subscriptionType,
              expiresAt: liveOauth?.expiresAt || raw.expiresAt,
              expiresIn: formatExpiry(liveOauth?.expiresAt || raw.expiresAt),
              accessTokenMasked: liveOauth ? maskToken(liveOauth.accessToken) : (raw.accessTokenMasked || maskToken(raw.accessToken)),
              emailAddress: raw.emailAddress || null,
              displayName: raw.displayName || null,
              organizationName: raw.organizationName || null,
            }
        : null,
    };
  }

  // ── 同步辅助：墓碑读写 ────────────────────────────────────────────────────
  getDeletedAccounts() {
    return this._config.deletedAccounts || {};
  }

  // 同步时 peer 通知本端"X 被删了"：把本端 accounts[name] 也移除并建墓碑
  // 不抛错（即便本端无此账号，也照单全收建墓碑，避免后续被对端再推回来）
  applyDeleteAccount(name, deletedAt) {
    const n = sanitizeName(name);
    const at = deletedAt || new Date().toISOString();
    const acct = this._config.accounts[n];
    // 墓碑覆盖原则：取较新 deletedAt
    const existingTomb = (this._config.deletedAccounts || {})[n];
    if (existingTomb && existingTomb.deletedAt && existingTomb.deletedAt >= at) return;

    if (acct) {
      // 本端还活着，移到墓碑
      const snapPath = credentialsSnapshotPath(n);
      const statePath = stateSnapshotPath(n);
      try { if (fileExists(snapPath)) fs.unlinkSync(snapPath); } catch { /* ignore */ }
      try { if (fileExists(statePath)) fs.unlinkSync(statePath); } catch { /* ignore */ }
      const tomb = { ...acct, excluded: true, deletedAt: at };
      if (tomb.type === 'apikey') delete tomb.authToken;
      this._config.deletedAccounts = this._config.deletedAccounts || {};
      this._config.deletedAccounts[n] = tomb;
      delete this._config.accounts[n];
      // 如果是 active，清空 active（按需要后续 UI 提示用户切换）
      if (this._config.activeAccount === n) {
        this._config.activeAccount = null;
        this._config.lastSwitchedAt = at;
      }
    } else {
      // 本端无此账号，直接建墓碑（防止下次对端再推回）
      this._config.deletedAccounts = this._config.deletedAccounts || {};
      this._config.deletedAccounts[n] = {
        name: n,
        excluded: true,
        deletedAt: at,
      };
    }
    this._save();
  }

  // 同步时对端推过来一个 createdAt 比本端墓碑 deletedAt 更新的活账号 → 复活
  // 实际操作：清掉本端墓碑（让 applyAccountDetail 正常写入 accounts）
  clearTombstone(name) {
    const n = sanitizeName(name);
    if (this._config.deletedAccounts && this._config.deletedAccounts[n]) {
      delete this._config.deletedAccounts[n];
      this._save();
    }
  }
}

module.exports = AccountStore;
