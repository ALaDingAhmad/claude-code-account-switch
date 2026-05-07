const fs = require('fs');
const {
  CONFIG_PATH,
  CREDENTIALS_PATH,
  CLAUDE_STATE_PATH,
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

  // 从 config.accounts 条目构造对外使用的账号对象（含派生字段）
  _entry(name, raw) {
    return {
      ...raw,
      name: raw.name || name,
      snapshotPath: credentialsSnapshotPath(name),
      statePath: stateSnapshotPath(name),
      accessTokenMasked: raw.accessTokenMasked || maskToken(raw.accessToken),
    };
  }

  _readLiveCredentials() {
    if (!fileExists(CREDENTIALS_PATH)) {
      throw new Error(`Credentials file not found: ${CREDENTIALS_PATH}`);
    }
    const json = readJson(CREDENTIALS_PATH);
    const oauth = extractOauth(json);
    if (!oauth || !oauth.accessToken || !oauth.refreshToken) {
      throw new Error(`Invalid credentials file: ${CREDENTIALS_PATH}`);
    }
    return json;
  }

  _readLiveState() {
    if (!fileExists(CLAUDE_STATE_PATH)) return {};
    return readJson(CLAUDE_STATE_PATH);
  }

  // 只把 userID / oauthAccount 写回 ~/.claude.json，其余字段保持不动
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

    // 保存凭证快照和状态快照
    atomicWriteJson(credentialsSnapshotPath(n), sourceJson);
    atomicWriteJson(stateSnapshotPath(n), {
      userID: liveState.userID || null,
      oauthAccount: liveState.oauthAccount || null,
    });

    this._config.accounts[n] = {
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

  switchAccount(name) {
    const n = sanitizeName(name);
    if (!this._config.accounts[n]) throw new Error(`Unknown account "${n}"`);

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

    const prev = this._config.accounts[n];
    this._config.accounts[n] = {
      ...prev,
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
    this._config.activeAccount = n;
    this._config.lastSwitchedAt = new Date().toISOString();
    this._save();
    return this._entry(n, this._config.accounts[n]);
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
      result[n] = {
        ...this._entry(n, raw),
        isActive: n === this._config.activeAccount,
        expiresIn: formatExpiry(raw.expiresAt),
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
        ? {
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
