const os = require('os');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_HOME || path.join(HOME, '.claude');
const CREDENTIALS_PATH =
  process.env.CLAUDE_CREDENTIALS_PATH || path.join(CLAUDE_DIR, '.credentials.json');
const CLAUDE_STATE_PATH =
  process.env.CLAUDE_STATE_PATH || path.join(HOME, '.claude.json');
const CLAUDE_SETTINGS_PATH =
  process.env.CLAUDE_SETTINGS_PATH || path.join(CLAUDE_DIR, 'settings.json');

const SHARED_USAGE_CACHE_PATH = path.join(
  process.env.CCS_HOME || path.join(HOME, '.ccs'),
  'usage-shared-cache.json'
);

const CCS_DIR = process.env.CCS_HOME || path.join(HOME, '.ccs');
const CONFIG_PATH = path.join(CCS_DIR, 'config.json');
const ACCOUNTS_DIR = path.join(CCS_DIR, 'accounts');
const WEB_PID_PATH = path.join(CCS_DIR, 'web.pid');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureCcsDirs() {
  ensureDir(CCS_DIR);
  ensureDir(ACCOUNTS_DIR);
}

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  ensureDir(path.dirname(filePath));
  const content = JSON.stringify(data, null, 2);

  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
  } catch {
    fs.writeFileSync(filePath, content, 'utf8');
    return;
  }

  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.copyFileSync(tmpPath, filePath);
    } catch {
      fs.writeFileSync(filePath, content, 'utf8');
    }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function sanitizeName(name) {
  const s = String(name || '').trim();
  if (!s) throw new Error('Account name is required');
  if (!/^[a-zA-Z0-9.@_-]+$/.test(s)) {
    throw new Error('Account name may only contain letters, numbers, dot, @, underscore, and hyphen');
  }
  return s;
}

function credentialsSnapshotPath(name) {
  return path.join(ACCOUNTS_DIR, `${sanitizeName(name)}.credentials.json`);
}

function stateSnapshotPath(name) {
  return path.join(ACCOUNTS_DIR, `${sanitizeName(name)}.state.json`);
}

function extractOauth(credentialsJson) {
  return credentialsJson && credentialsJson.claudeAiOauth
    ? credentialsJson.claudeAiOauth
    : null;
}

function maskToken(token) {
  if (!token) return 'N/A';
  if (token.length <= 16) return token;
  return `${token.slice(0, 12)}...${token.slice(-4)}`;
}

function formatExpiry(expiresAt) {
  if (!expiresAt) return 'unknown';
  const date = new Date(expiresAt);
  const diff = expiresAt - Date.now();
  if (diff <= 0) return `expired (${date.toLocaleString()})`;
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m (${date.toLocaleString()})`;
  return `${minutes}m (${date.toLocaleString()})`;
}

// 切换账号后清掉用量/profile 共享缓存，确保状态栏立即显示新账号数据
function clearProfileCache() {
  try { if (fs.existsSync(SHARED_USAGE_CACHE_PATH)) fs.unlinkSync(SHARED_USAGE_CACHE_PATH); } catch { /* ignore */ }
}

function _pingOauth(token, apiPath) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: apiPath,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          Accept: 'application/json',
        },
        timeout: 5000,
      },
      (res) => { res.resume(); resolve(res.statusCode < 500); },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function triggerCacheInvalidation() {
  clearProfileCache();
  return new Promise((resolve) => {
    try {
      const creds = readLiveCredentials();
      const token = creds?.claudeAiOauth?.accessToken;
      if (!token) return resolve(false);
      Promise.all([
        _pingOauth(token, '/api/oauth/usage'),
        _pingOauth(token, '/api/oauth/profile'),
      ]).then((rs) => resolve(rs.some(Boolean)));
    } catch {
      resolve(false);
    }
  });
}

const IS_MAC = process.platform === 'darwin';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_ACCOUNT = os.userInfo().username;

// macOS keychain 操作统一走 spawnSync + args 数组，避免 shell 解析造成的 $/反引号 注入
function keychainExec(args, opts = {}) {
  const { spawnSync } = require('child_process');
  return spawnSync('security', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
}

function readLiveCredentials() {
  if (IS_MAC) {
    const r = keychainExec(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w']);
    if (r.status !== 0) return null;
    const out = (r.stdout || '').trim();
    if (!out) return null;
    try { return JSON.parse(out); } catch { return null; }
  }
  if (!fs.existsSync(CREDENTIALS_PATH)) return null;
  try { return readJson(CREDENTIALS_PATH); } catch { return null; }
}

function writeLiveCredentials(json) {
  const content = JSON.stringify(json);
  if (IS_MAC) {
    const r = keychainExec([
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', KEYCHAIN_ACCOUNT,
      '-w', content,
      '-U',
    ]);
    if (r.status !== 0) {
      throw new Error(`keychain write failed: ${(r.stderr || '').toString().trim() || `exit ${r.status}`}`);
    }
    return;
  }
  atomicWriteJson(CREDENTIALS_PATH, json);
}

function deleteLiveCredentials() {
  if (IS_MAC) {
    keychainExec(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]);
    return;
  }
  try { if (fs.existsSync(CREDENTIALS_PATH)) fs.unlinkSync(CREDENTIALS_PATH); } catch { /* ignore */ }
}

function liveCredentialsExist() {
  if (IS_MAC) {
    const r = keychainExec(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]);
    return r.status === 0;
  }
  return fs.existsSync(CREDENTIALS_PATH);
}

function writeWebPid(info) {
  ensureCcsDirs();
  const data = { pid: process.pid, ...info, writtenAt: new Date().toISOString() };
  fs.writeFileSync(WEB_PID_PATH, JSON.stringify(data, null, 2));
}

function readWebPid() {
  if (!fs.existsSync(WEB_PID_PATH)) return null;
  try {
    const info = JSON.parse(fs.readFileSync(WEB_PID_PATH, 'utf8'));
    if (!info.pid) return null;
    try { process.kill(info.pid, 0); } catch { return null; }
    return info;
  } catch { return null; }
}

function clearWebPid() {
  try { if (fs.existsSync(WEB_PID_PATH)) fs.unlinkSync(WEB_PID_PATH); } catch { /* ignore */ }
}

function findClaudeExe() {
  try {
    const out = execSync('where claude', { encoding: 'utf8', timeout: 5000, windowsHide: true }).trim();
    return out.split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

module.exports = {
  HOME,
  CLAUDE_DIR,
  CREDENTIALS_PATH,
  CLAUDE_STATE_PATH,
  CLAUDE_SETTINGS_PATH,
  CCS_DIR,
  CONFIG_PATH,
  ACCOUNTS_DIR,
  WEB_PID_PATH,
  ensureDir,
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
  triggerCacheInvalidation,
  clearProfileCache,
  readLiveCredentials,
  writeLiveCredentials,
  deleteLiveCredentials,
  liveCredentialsExist,
  IS_MAC,
  findClaudeExe,
  writeWebPid,
  readWebPid,
  clearWebPid,
};
