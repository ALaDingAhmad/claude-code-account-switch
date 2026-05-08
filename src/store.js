const fs = require('fs');
const {
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

class AccountStore {
  constructor() {
    ensureCcsDirs();
    this._config = this._load();
  }

  _defaultConfig() {
    return { version: 2, activeAccount: null, lastSwitchedAt: null, accounts: {} };
  }

  _load() {
    if (!fileExists(CONFIG_PATH)) return this._defaultConfig();
    try {
      const c = readJson(CONFIG_PATH);
      return { ...this._defaultConfig(), ...c, accounts: c.accounts || {} };
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
    return readJson(CLAUDE_STATE_PATH);
  }

  _readSettings() {
    if (!fileExists(CLAUDE_SETTINGS_PATH)) return {};
    return readJson(CLAUDE_SETTINGS_PATH);
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

  // ── 公开 API ──────────────────────────────────────────────────────────────

  getLiveEmail() {
    const state = this._readLiveState();
    return state.oauthAccount?.emailAddress || null;
  }

  // 导入 OAuth 账号（从当前 live credentials 读取）
  importAccount(name, sourcePath = null) {
    const n = sanitizeName(name);
    const sourceJson = sourcePath ? readJson(sourcePath) : readLiveCredentials();
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
      importedAt: prev.importedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this._config.activeAccount = n;
    this._config.lastSwitchedAt = new Date().toISOString();
    this._save();
    return this._entry(n, this._config.accounts[n]);
  }

  // 导入 API Key 账号
  importApiKeyAccount(name, authToken, baseUrl) {
    const n = sanitizeName(name);
    if (!authToken) throw new Error('authToken is required');

    const prev = this._config.accounts[n] || {};
    this._config.accounts[n] = {
      type: 'apikey',
      name: n,
      authToken,
      authTokenMasked: maskToken(authToken),
      baseUrl: baseUrl || null,
      importedAt: prev.importedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this._switchApiKey(n, this._config.accounts[n]);
    this._config.activeAccount = n;
    this._config.lastSwitchedAt = new Date().toISOString();
    this._save();
    return this._entry(n, this._config.accounts[n]);
  }

  switchAccount(name) {
    const n = sanitizeName(name);
    const acct = this._config.accounts[n];
    if (!acct) throw new Error(`Unknown account "${n}"`);

    if (acct.type === 'apikey') {
      this._switchApiKey(n, acct);
    } else {
      this._switchOauth(n, acct);
    }
    clearProfileCache();

    this._config.activeAccount = n;
    this._config.lastSwitchedAt = new Date().toISOString();
    this._save();
    return this._entry(n, this._config.accounts[n]);
  }

  _switchOauth(n, prev) {
    const snapPath = credentialsSnapshotPath(n);
    if (!fileExists(snapPath)) throw new Error(`Snapshot not found for "${n}"`);
    const snapshot = readJson(snapPath);
    const oauth = extractOauth(snapshot);
    if (!oauth || !oauth.accessToken || !oauth.refreshToken) {
      throw new Error(`Snapshot for "${n}" is invalid`);
    }

    const statePath = stateSnapshotPath(n);
    const stateSnap = fileExists(statePath) ? readJson(statePath) : null;

    writeLiveCredentials(snapshot);
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
    if (prev.baseUrl) {
      env.ANTHROPIC_BASE_URL = prev.baseUrl;
    } else {
      delete env.ANTHROPIC_BASE_URL;
    }
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
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
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
    if (!this._config.accounts[n]) throw new Error(`Unknown account "${n}"`);

    const snapPath = credentialsSnapshotPath(n);
    const statePath = stateSnapshotPath(n);
    try { if (fileExists(snapPath)) fs.unlinkSync(snapPath); } catch { /* ignore */ }
    try { if (fileExists(statePath)) fs.unlinkSync(statePath); } catch { /* ignore */ }

    delete this._config.accounts[n];
    if (this._config.activeAccount === n) {
      const next = Object.keys(this._config.accounts)[0] || null;
      this._config.activeAccount = next;
      this._config.lastSwitchedAt = next ? new Date().toISOString() : null;
    }
    this._save();
  }

  clearLiveAuth() {
    deleteLiveCredentials();
    const live = this._readLiveState();
    const next = { ...live };
    delete next.userID;
    delete next.oauthAccount;
    atomicWriteJson(CLAUDE_STATE_PATH, next);
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
      result[n] = {
        ...entry,
        isActive,
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
}

module.exports = AccountStore;
