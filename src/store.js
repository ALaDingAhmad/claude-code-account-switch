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

  // 导入 OAuth 账号
  importAccount(name, sourcePath = CREDENTIALS_PATH) {
    const n = sanitizeName(name);
    const sourceJson = readJson(sourcePath);
    const oauth = extractOauth(sourceJson);
    if (!oauth || !oauth.accessToken || !oauth.refreshToken) {
      throw new Error(`Invalid credentials file: ${sourcePath}`);
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

    atomicWriteJson(CREDENTIALS_PATH, snapshot);
    if (stateSnap) this._restoreStateFields(stateSnap);

    // 切换到 oauth 时清除 settings.json 里的 apikey env
    this._clearApikeyEnv();

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
    if (fileExists(CREDENTIALS_PATH)) {
      try { fs.unlinkSync(CREDENTIALS_PATH); } catch { atomicWriteJson(CREDENTIALS_PATH, {}); }
    }
    const live = this._readLiveState();
    const next = { ...live };
    delete next.userID;
    delete next.oauthAccount;
    atomicWriteJson(CLAUDE_STATE_PATH, next);
  }

  listAccounts() {
    const result = {};
    for (const [n, raw] of Object.entries(this._config.accounts)) {
      const entry = this._entry(n, raw);
      result[n] = {
        ...entry,
        isActive: n === this._config.activeAccount,
        expiresIn: raw.type === 'apikey' ? null : formatExpiry(raw.expiresAt),
      };
    }
    return result;
  }

  getStatus() {
    const { activeAccount, accounts, lastSwitchedAt } = this._config;
    const raw = activeAccount ? accounts[activeAccount] : null;
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
              subscriptionType: raw.subscriptionType,
              expiresAt: raw.expiresAt,
              expiresIn: formatExpiry(raw.expiresAt),
              accessTokenMasked: raw.accessTokenMasked || maskToken(raw.accessToken),
              emailAddress: raw.emailAddress || null,
              displayName: raw.displayName || null,
              organizationName: raw.organizationName || null,
            }
        : null,
    };
  }
}

module.exports = AccountStore;
