#!/usr/bin/env node
'use strict';

if (process.platform !== 'win32') process.exit(0);

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const desktop = path.join(os.homedir(), 'Desktop');
const lnkPath = path.join(desktop, 'CCS 管理界面.lnk');

function findCcsBin() {
  try {
    const out = execSync('where ccs', { encoding: 'utf8', windowsHide: true }).trim();
    return out.split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

const ccsBin = findCcsBin();
if (!ccsBin) {
  console.log('CCS: ccs 命令未找到，跳过快捷方式创建。');
  process.exit(0);
}

// 创建 .lnk 快捷方式，目标为 ccs web（带 --open 参数自动打开浏览器）
// 窗口最小化运行（WindowStyle=7），保持 ccs web 进程在后台
const escaped = {
  lnk: lnkPath.replace(/\\/g, '\\\\'),
  ccs: ccsBin.replace(/\\/g, '\\\\'),
};

const psScript = [
  `$ws = New-Object -ComObject WScript.Shell`,
  `$lnk = $ws.CreateShortcut('${escaped.lnk}')`,
  `$lnk.TargetPath = '${escaped.ccs}'`,
  `$lnk.Arguments = 'web 7899'`,
  `$lnk.WorkingDirectory = [System.Environment]::GetFolderPath('UserProfile')`,
  `$lnk.Description = 'CCS - Claude Code 账号管理界面'`,
  `$lnk.WindowStyle = 7`,
  `$lnk.Save()`,
].join('; ');

try {
  execSync(`powershell -NoProfile -NonInteractive -Command "${psScript}"`, {
    windowsHide: true,
    stdio: 'pipe',
  });
  console.log(`CCS: 桌面快捷方式已创建 -> ${lnkPath}`);
} catch (e) {
  console.log('CCS: 快捷方式创建失败（可忽略）:', e.message);
}
