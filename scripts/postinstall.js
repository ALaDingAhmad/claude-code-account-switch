#!/usr/bin/env node
'use strict';

if (process.platform !== 'win32') process.exit(0);

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

const desktop = path.join(os.homedir(), 'Desktop');
const lnkPath = path.join(desktop, 'CCS 管理界面.lnk');
const vbsPath = path.join(os.homedir(), '.ccs', 'launch-web.vbs');

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

// 创建无窗口启动的 VBScript 包装器
const vbsDir = path.dirname(vbsPath);
if (!require('fs').existsSync(vbsDir)) require('fs').mkdirSync(vbsDir, { recursive: true });
const vbsContent = `Set ws = CreateObject("WScript.Shell")\r\nws.Run "${ccsBin.replace(/\\/g, '\\\\')} web 7899", 0, False\r\n`;
require('fs').writeFileSync(vbsPath, vbsContent, 'utf8');

// 快捷方式指向 wscript.exe 运行 VBScript，完全无窗口
const escaped = {
  lnk: lnkPath.replace(/\\/g, '\\\\'),
  vbs: vbsPath.replace(/\\/g, '\\\\'),
};

const psScript = [
  `$ws = New-Object -ComObject WScript.Shell`,
  `$lnk = $ws.CreateShortcut('${escaped.lnk}')`,
  `$lnk.TargetPath = 'wscript.exe'`,
  `$lnk.Arguments = '"${escaped.vbs}"'`,
  `$lnk.WorkingDirectory = [System.Environment]::GetFolderPath('UserProfile')`,
  `$lnk.Description = 'CCS - Claude Code 账号管理界面'`,
  `$lnk.WindowStyle = 1`,
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
