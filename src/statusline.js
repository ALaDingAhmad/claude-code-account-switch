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
const HOOK_COMMAND = `bash ~/.claude/${SCRIPT_NAME}`;

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

function getStatus() {
  const sourceExists = fileExists(SOURCE_PATH);
  const targetExists = fileExists(TARGET_PATH);
  const settings = readSettings();
  const stopHooks = settings?.hooks?.Stop || [];
  const hookInstalled = Array.isArray(stopHooks) && stopHooks.some(hookEntryMatches);
  return {
    sourceExists,
    sourcePath: SOURCE_PATH,
    targetExists,
    targetPath: TARGET_PATH,
    hookInstalled,
    settingsPath: CLAUDE_SETTINGS_PATH,
    installed: targetExists && hookInstalled,
  };
}

function install() {
  if (!fileExists(SOURCE_PATH)) {
    throw new Error(`source script not found: ${SOURCE_PATH}`);
  }
  ensureDir(CLAUDE_DIR);

  // 复制脚本（每次安装覆盖，使用最新版本）
  fs.copyFileSync(SOURCE_PATH, TARGET_PATH);
  try { fs.chmodSync(TARGET_PATH, 0o755); } catch { /* non-posix */ }

  // 注入 hook（如果已存在则跳过）
  const settings = readSettings();
  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];
  if (!settings.hooks.Stop.some(hookEntryMatches)) {
    settings.hooks.Stop.push({
      matcher: '',
      hooks: [{ type: 'command', command: HOOK_COMMAND }],
    });
  }
  atomicWriteJson(CLAUDE_SETTINGS_PATH, settings);

  return getStatus();
}

function uninstall() {
  // 删脚本
  try { if (fileExists(TARGET_PATH)) fs.unlinkSync(TARGET_PATH); } catch { /* ignore */ }

  // 从 hooks.Stop 中移除
  const settings = readSettings();
  if (settings?.hooks?.Stop && Array.isArray(settings.hooks.Stop)) {
    settings.hooks.Stop = settings.hooks.Stop.filter((e) => !hookEntryMatches(e));
    if (settings.hooks.Stop.length === 0) {
      delete settings.hooks.Stop;
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
    atomicWriteJson(CLAUDE_SETTINGS_PATH, settings);
  }
  return getStatus();
}

module.exports = { getStatus, install, uninstall };
