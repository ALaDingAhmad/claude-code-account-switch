#!/usr/bin/env node

// 主动刷新当前 OAuth access token，写回 live credentials 和当前 active 账号的 ccs 快照。
// 用途：长期不切换的账号担心 refresh_token 临近 30 天滑动失效时主动续命；
//      或验证 share sync 跨端流程时手动触发一次 token 轮换。
//
// 用法：node scripts/refresh-token.js
//
// 注意：每次刷新会让旧 refresh_token 立即作废。两端共享同步时，本端刷完后
// 应立刻让 share sync 推到对端，否则对端持有的旧 refresh_token 会失效。

const https = require('https');
const path = require('path');
const {
  readLiveCredentials,
  writeLiveCredentials,
  extractOauth,
  formatExpiry,
} = require(path.join(__dirname, '..', 'src', 'utils'));

const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function postJson(urlString, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
        timeout: 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

async function main() {
  const live = readLiveCredentials();
  if (!live) {
    console.error('No live OAuth credentials found.');
    process.exit(1);
  }
  const oauth = extractOauth(live);
  if (!oauth?.refreshToken) {
    console.error('Live credentials missing refreshToken.');
    process.exit(1);
  }

  console.log('Before:');
  console.log(`  access tail : ...${oauth.accessToken.slice(-12)}`);
  console.log(`  expiresAt   : ${new Date(oauth.expiresAt).toLocaleString()} (${formatExpiry(oauth.expiresAt)})`);

  const { status, text } = await postJson(TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    client_id: CLIENT_ID,
  }, {
    'anthropic-beta': 'oauth-2025-04-20',
    'User-Agent': 'claude-cli/2.1.39 (external, cli)',
  });

  if (status < 200 || status >= 300) {
    console.error(`HTTP ${status}: ${text.slice(0, 400)}`);
    process.exit(1);
  }

  const data = JSON.parse(text);
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

  const newLive = { ...live, claudeAiOauth: newOauth };
  writeLiveCredentials(newLive);

  console.log('After:');
  console.log(`  access tail : ...${newOauth.accessToken.slice(-12)}`);
  console.log(`  expiresAt   : ${new Date(expiresAt).toLocaleString()} (${formatExpiry(expiresAt)})`);
  console.log(`  refresh rotated: ${newOauth.refreshToken !== oauth.refreshToken}`);

  // 同步到 ccs 快照（如果 active 账号是 OAuth）
  try {
    const Store = require(path.join(__dirname, '..', 'src', 'store'));
    const r = new Store().syncActive();
    if (r.synced) console.log(`  ccs snapshot synced -> ${r.name}`);
  } catch (e) {
    console.warn(`  ccs snapshot sync skipped: ${e.message}`);
  }
}

main().catch((e) => {
  console.error('Refresh failed:', e.message);
  process.exit(1);
});
