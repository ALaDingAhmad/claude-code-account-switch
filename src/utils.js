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

const PROFILE_CACHE_PATH = path.join(CLAUDE_DIR, 'profile-cache.json');
const USAGE_CACHE_PATH = path.join(CLAUDE_DIR, 'usage-cache.json');

const CCS_DIR = process.env.CCS_HOME || path.join(HOME, '.ccs');
const CONFIG_PATH = path.join(CCS_DIR, 'config.json');
const ACCOUNTS_DIR = path.join(CCS_DIR, 'accounts');

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

// 切换账号后用新 token 调用 /api/oauth/usage，触发 Claude Code 进程检测到
// credentials 文件 mtime 变化，清除 memoize 缓存，从而立即使用新 token。
function clearProfileCache() {
  try { if (fs.existsSync(PROFILE_CACHE_PATH)) fs.unlinkSync(PROFILE_CACHE_PATH); } catch { /* ignore */ }
  try { if (fs.existsSync(USAGE_CACHE_PATH)) fs.unlinkSync(USAGE_CACHE_PATH); } catch { /* ignore */ }
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

function triggerCacheInvalidation(credPath) {
  clearProfileCache();
  return new Promise((resolve) => {
    try {
      const creds = JSON.parse(fs.readFileSync(credPath, 'utf8'));
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
  PROFILE_CACHE_PATH,
  USAGE_CACHE_PATH,
  CCS_DIR,
  CONFIG_PATH,
  ACCOUNTS_DIR,
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
  findClaudeExe,
};
