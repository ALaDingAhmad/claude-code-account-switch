const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CLAUDE_DIR, CCS_DIR, fileExists, ensureDir } = require('./utils');

const PID_FILE      = path.join(CCS_DIR, 'usage-monitor.pid');
const DISABLED_FILE = path.join(CCS_DIR, 'usage-monitor.disabled');
const LOG_FILE      = path.join(CCS_DIR, 'auto-switch.log');
const SCRIPTS_DIR   = path.join(__dirname, '..', 'scripts');

const PY_HELPERS = ['auto_switch_core.py', 'usage_monitor.py'];

// ── 进程探活 ──────────────────────────────────────────────────────────────────

function _pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function _readPid() {
  try {
    const v = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return isNaN(v) ? null : v;
  } catch { return null; }
}

// ── 日志读取 ──────────────────────────────────────────────────────────────────

function _readRecentLogs(n = 30) {
  try {
    if (!fileExists(LOG_FILE)) return [];
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    return lines.slice(-n);
  } catch { return []; }
}

// ── 安装辅助 py 文件到 ~/.claude/ ────────────────────────────────────────────

function _installPyHelpers() {
  ensureDir(CLAUDE_DIR);
  for (const name of PY_HELPERS) {
    const src = path.join(SCRIPTS_DIR, name);
    const dst = path.join(CLAUDE_DIR, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
}

// ── 守护进程 spawn ────────────────────────────────────────────────────────────

function _spawnMonitor() {
  const script = path.join(CLAUDE_DIR, 'usage_monitor.py');
  if (!fileExists(script)) return;
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const child = spawn(py, [script], {
    detached: true,
    stdio: 'ignore',
    ...(process.platform === 'win32'
      ? { windowsHide: true }
      : {}),
  });
  child.unref();
}

// ── 守护进程 kill ─────────────────────────────────────────────────────────────

function _killMonitor() {
  const pid = _readPid();
  if (!pid) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch { /* 进程已不存在 */ }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
}

// ── 公开 API ──────────────────────────────────────────────────────────────────

function getStatus() {
  const enabled  = !fileExists(DISABLED_FILE);
  const pid      = _readPid();
  const running  = pid !== null && _pidAlive(pid);

  let uptimeSeconds = null;
  if (running) {
    // pid 文件 mtime 近似守护启动时间
    try {
      const stat = fs.statSync(PID_FILE);
      uptimeSeconds = Math.floor((Date.now() - stat.mtimeMs) / 1000);
    } catch { /* ignore */ }
  }

  const recentLogs = _readRecentLogs(30);

  return { enabled, running, pid: running ? pid : null, uptimeSeconds, recentLogs };
}

function enable() {
  try { fs.unlinkSync(DISABLED_FILE); } catch { /* 本来就不存在 */ }
  _installPyHelpers();
  const pid = _readPid();
  if (!pid || !_pidAlive(pid)) _spawnMonitor();
  return getStatus();
}

function disable() {
  ensureDir(CCS_DIR);
  fs.writeFileSync(DISABLED_FILE, '');
  _killMonitor();
  return getStatus();
}

module.exports = { getStatus, enable, disable };
