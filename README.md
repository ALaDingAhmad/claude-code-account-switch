# CCS - Claude Code Account Switcher

Windows CLI 工具，通过备份和还原 `~/.claude/.credentials.json` 及 `~/.claude.json` 中的账号字段，实现 Claude Code 多账号一键切换。

不代理请求，不切换 profile 目录，不影响 `.claude/sessions`、`history.jsonl` 和项目状态。

## 原理

- `import`：将当前登录的 credentials 和账号状态快照保存到 `~/.ccs/accounts/`
- `switch`：原子替换 `~/.claude/.credentials.json`，同时将账号状态字段写回 `~/.claude.json`
- 切换后调用 `GET /api/oauth/usage`，让 Claude Code 进程检测到 credentials 文件的 mtime 变化，清除内部 memoize 缓存，立即使用新 token

## 环境要求

- Windows 10/11
- Node.js 18+

## 安装

```powershell
cd D:\aiproject\claude-code-account-switch
npm install -g .
```

## 快速开始

1. 在 Claude Code 中登录账号 A，然后导入：

```powershell
ccs import account_a
```

2. 在 Claude Code 中切换登录账号 B，再导入：

```powershell
ccs import account_b
```

3. 随时一键切换：

```powershell
ccs switch account_a
ccs switch account_b
# 或简写
ccs account_a
```

## 命令

```
ccs                       显示当前状态和账号列表
ccs <name>                切换到指定账号（switch 的简写）
ccs -                     清除当前登录状态
ccs import <name> [path]  将当前 credentials 导入为 <name>
ccs switch <name>         切换到已导入的账号
ccs remove <name>         删除已导入的账号
ccs clear-current         删除 live credentials，清空账号状态字段
ccs logout                同 clear-current
ccs status                显示当前状态
ccs accounts              列出所有已导入账号
ccs doctor                检查环境和配置
ccs -h / --help           显示帮助
```

## 文件路径

| 文件 | 说明 |
|------|------|
| `~/.claude/.credentials.json` | Claude Code 当前生效的 OAuth 凭证 |
| `~/.claude.json` | Claude Code 全局配置（只修改 userID / oauthAccount 字段） |
| `~/.ccs/config.json` | CCS 账号列表和当前活跃账号 |
| `~/.ccs/accounts/<name>.credentials.json` | 账号 credentials 快照 |
| `~/.ccs/accounts/<name>.state.json` | 账号状态快照（userID / oauthAccount） |

## 测试时使用自定义路径

```powershell
$env:CCS_HOME = "D:\tmp\ccs"
$env:CLAUDE_HOME = "D:\tmp\claude"
ccs status
```

## License

MIT © 2026 baiqiang
