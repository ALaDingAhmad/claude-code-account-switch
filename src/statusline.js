const fs = require('fs');
const path = require('path');
const {
  CLAUDE_DIR,
  CLAUDE_SETTINGS_PATH,
  ensureDir,
  atomicWriteJson,
  readJson,
  fileExists,
} = require('./utils');

const SCRIPT_NAME = 'statusline-command.sh';
const SOURCE_PATH = path.join(__dirname, '..', 'scripts', SCRIPT_NAME);
const TARGET_PATH = path.join(CLAUDE_DIR, SCRIPT_NAME);
const STATUSLINE_COMMAND = `bash ~/.claude/${SCRIPT_NAME}`;

function readSettings() {
  if (!fileExists(CLAUDE_SETTINGS_PATH)) return {};
  try { return readJson(CLAUDE_SETTINGS_PATH); } catch { return {}; }
}

function hookEntryMatches(entry) {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h) =>
    h?.type === 'command' &&
    typeof h.command === 'string' &&
    h.command.includes(SCRIPT_NAME)
  );
}

function statusLineMatches(sl) {
  return sl && sl.type === 'command' && typeof sl.command === 'string' && sl.command.includes(SCRIPT_NAME);
}

function removeLegacyStopHook(settings) {
  // 早期版本误把 statusline 装到 hooks.Stop，升级时清理掉
  if (!settings?.hooks?.Stop || !Array.isArray(settings.hooks.Stop)) return false;
  const before = settings.hooks.Stop.length;
  settings.hooks.Stop = settings.hooks.Stop.filter((e) => !hookEntryMatches(e));
  if (settings.hooks.Stop.length === before) return false;
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return true;
}

function getStatus() {
  const sourceExists = fileExists(SOURCE_PATH);
  const targetExists = fileExists(TARGET_PATH);
  const settings = readSettings();
  const statusLineInstalled = statusLineMatches(settings?.statusLine);
  return {
    sourceExists,
    sourcePath: SOURCE_PATH,
    targetExists,
    targetPath: TARGET_PATH,
    hookInstalled: statusLineInstalled,
    settingsPath: CLAUDE_SETTINGS_PATH,
    installed: targetExists && statusLineInstalled,
  };
}

function install() {
  if (!fileExists(SOURCE_PATH)) {
    throw new Error(`source script not found: ${SOURCE_PATH}`);
  }
  ensureDir(CLAUDE_DIR);

  // 复制脚本时把 __CCS_VERSION__ 占位符替换为 package.json 的真实版本号
  // 这样状态栏每次刷新都显示当前装的 ccs 版本，零运行时开销
  const version = (() => {
    try { return require(path.join(__dirname, '..', 'package.json')).version || ''; }
    catch { return ''; }
  })();
  const raw = fs.readFileSync(SOURCE_PATH, 'utf8');
  const patched = raw.replace(/__CCS_VERSION__/g, version);
  fs.writeFileSync(TARGET_PATH, patched);
  try { fs.chmodSync(TARGET_PATH, 0o755); } catch { /* non-posix */ }

  const settings = readSettings();
  // 早期版本误装到 hooks.Stop，顺手清掉避免脚本被跑两次
  removeLegacyStopHook(settings);
  // 写入 statusLine 字段
  settings.statusLine = { type: 'command', command: STATUSLINE_COMMAND };
  atomicWriteJson(CLAUDE_SETTINGS_PATH, settings);

  return getStatus();
}

function uninstall() {
  // 只删状态栏脚本；auto_switch_core.py / usage_monitor.py 由 monitor 模块独立管理
  try { if (fileExists(TARGET_PATH)) fs.unlinkSync(TARGET_PATH); } catch { /* ignore */ }

  const settings = readSettings();
  let changed = false;
  if (statusLineMatches(settings.statusLine)) {
    delete settings.statusLine;
    changed = true;
  }
  if (removeLegacyStopHook(settings)) changed = true;
  if (changed) atomicWriteJson(CLAUDE_SETTINGS_PATH, settings);
  return getStatus();
}

module.exports = { getStatus, install, uninstall };
