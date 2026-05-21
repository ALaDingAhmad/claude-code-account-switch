const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { CLAUDE_DIR, CCS_DIR, fileExists, ensureDir, isInstalledStale } = require('./utils');

const PID_FILE      = path.join(CCS_DIR, 'usage-monitor.pid');
const DISABLED_FILE = path.join(CCS_DIR, 'usage-monitor.disabled');
const LOG_FILE      = path.join(CCS_DIR, 'auto-switch.log');
const SCRIPTS_DIR   = path.join(__dirname, '..', 'scripts');

const PY_HELPERS = ['auto_switch_core.py', 'usage_monitor.py', 'anthropic_http.py'];

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

  // v3.11.0：检测两种"过期"——
  //   filesStale: 源码和已安装文件内容不一致（升级 ccs 后没重装）
  //   processStale: 已安装文件比守护启动时间还新（py 文件已更新但进程没重启加载）
  // 任一为真，前端就提示用户关-开守护开关刷新。
  const filesStale = PY_HELPERS.some((name) => isInstalledStale(
    path.join(SCRIPTS_DIR, name),
    path.join(CLAUDE_DIR, name)
  ));
  let processStale = false;
  if (running) {
    try {
      const pidMtime = fs.statSync(PID_FILE).mtimeMs;  // 守护启动时间近似
      processStale = PY_HELPERS.some((name) => {
        const p = path.join(CLAUDE_DIR, name);
        if (!fileExists(p)) return false;
        return fs.statSync(p).mtimeMs > pidMtime + 1000;  // 1s 容差
      });
    } catch { /* ignore */ }
  }
  const pyHelpersStale = filesStale || processStale;

  return {
    enabled, running, pid: running ? pid : null, uptimeSeconds, recentLogs,
    pyHelpersStale, pyFilesStale: filesStale, pyProcessStale: processStale,
  };
}

function _tryAutostart(action) {
  // autostart 失败不阻塞主流程，但记录到 auto-switch.log 便于排查
  try {
    const autostart = require('./autostart');
    if (!autostart.isSupported()) return null;
    const r = action === 'install' ? autostart.install() : autostart.remove();
    try {
      const line = `[${new Date().toISOString()}] [autostart] ${action}: ${JSON.stringify(r)}\n`;
      ensureDir(CCS_DIR);
      fs.appendFileSync(LOG_FILE, line);
    } catch { /* 日志失败忽略 */ }
    return r;
  } catch { return null; }
}

function enable() {
  try { fs.unlinkSync(DISABLED_FILE); } catch { /* 本来就不存在 */ }
  _installPyHelpers();
  const pid = _readPid();
  if (!pid || !_pidAlive(pid)) _spawnMonitor();
  _tryAutostart('install');
  return getStatus();
}

function disable() {
  ensureDir(CCS_DIR);
  fs.writeFileSync(DISABLED_FILE, '');
  _killMonitor();
  _tryAutostart('remove');
  return getStatus();
}

// 看门狗：开关开但守护没在跑就拉起来；开关关或已在跑则什么都不做。
// 被 Web UI 状态轮询、CLI `ccs monitor revive`、任务计划程序共同复用。
function revive() {
  const enabled = !fileExists(DISABLED_FILE);
  if (!enabled) return { revived: false, reason: 'disabled' };
  const pid = _readPid();
  if (pid && _pidAlive(pid)) return { revived: false, reason: 'already-running', pid };
  _installPyHelpers();
  _spawnMonitor();
  return { revived: true };
}

module.exports = { getStatus, enable, disable, revive };
