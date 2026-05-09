# CCS - Claude Code Account Switcher

Windows / macOS CLI 工具，通过备份和还原 Claude Code 凭证（Windows 文件 / macOS Keychain）及 `~/.claude.json` 中的账号字段，实现 Claude Code 多账号一键切换。支持 OAuth 和 API Key 两种账号类型，提供命令行和 Web UI 两种操作方式。

不代理请求，不切换 profile 目录，不影响 `.claude/sessions`、`history.jsonl` 和项目状态。

## 原理

- `import`：将当前登录的 credentials 和账号状态快照保存到 `~/.ccs/accounts/`
- `switch`：原子替换 live 凭证（Windows: `~/.claude/.credentials.json`，macOS: Keychain `Claude Code-credentials`），同时把账号状态字段写回 `~/.claude.json`
- 切换后调用 `/api/oauth/usage` 和 `/api/oauth/profile`，清除本地缓存，让状态栏立即显示新账号信息
- 切换/退出前，自动把当前 live credentials 回写到「正要被切走」的账号快照。原因：Anthropic 每次 refresh 都会轮换 refresh_token，旧 token 立即作废；如果不回写，下次再切回这个账号会直接 401，需要重新登录

## 平台差异

| 项目 | Windows | macOS |
|------|---------|-------|
| OAuth 凭证存储 | `~/.claude/.credentials.json` | Keychain `Claude Code-credentials`（service） |
| 桌面快捷方式 | 安装时自动创建（`wscript.exe` 无窗口启动 + 自动杀旧进程） | 无（运行 `ccs web` 即可） |
| 自动打开浏览器 | `start <url>` | `open <url>` |

macOS 首次切换会弹出 Keychain 授权框，点击「始终允许」后续切换无需再确认。

## 环境要求

- Windows 10/11 或 macOS
- Node.js 18+

## 安装

从打包文件安装（推荐给同事用）：

```bash
npm install -g dist/claude-code-account-switch-3.5.0.tgz
```

从源码安装：

```bash
npm install -g .
```

Windows 安装后自动在桌面创建「CCS 管理界面」快捷方式。

## 快速开始

1. 在 Claude Code 中登录账号 A，然后导入：

```bash
ccs import account_a
```

2. 在 Claude Code 中切换登录账号 B，再导入：

```bash
ccs import account_b
```

3. 随时一键切换：

```bash
ccs switch account_a
ccs switch account_b
# 或简写
ccs account_a
```

## 命令

```
ccs                       显示当前状态和账号列表
ccs <name>                切换到指定账号（switch 的简写）
ccs -                     清除当前登录状态（同 clear-current / logout）
ccs import <name> [path]  将当前 credentials 导入为 <name>
ccs switch <name>         切换到已导入的账号
ccs sync                  把 live credentials 回写到当前活跃账号的快照
ccs remove <name>         删除已导入的账号
ccs clear-current         清除 live credentials，清空账号状态字段
ccs logout                同 clear-current
ccs status                显示当前状态
ccs accounts              列出所有已导入账号
ccs doctor                检查环境和配置
ccs web [port]            启动 Web UI（默认端口 7899）
ccs -h / --help           显示帮助
```

## Web UI

```bash
ccs web
# 或指定端口
ccs web 8080
```

启动后自动打开浏览器，访问 `http://127.0.0.1:7899`。功能：

- 查看所有账号状态并一键切换
- 导入 OAuth / API Key 账号（双标签）
- 编辑账号（OAuth 显示 token/套餐/过期只读信息，API Key 可改 token 和 baseUrl）
- 删除账号
- **退出当前账号**：清空 live credentials 与状态字段

**Windows**：双击桌面快捷方式启动，无窗口运行；如已运行会自动杀旧进程再重启。

**macOS**：终端运行 `ccs web` 即可，会自动用 `open` 命令打开浏览器。

**自动空闲退出**：Web 服务 5 分钟无请求后自动关闭，下次需要时重新启动即可。

## API Key 账号

支持通过 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` 使用第三方 API 服务：

1. 在 Web UI「导入 → API Key」标签填入名称、Token 和 Base URL
2. 切换到该账号后，CCS 自动写入 `~/.claude/settings.json` 的 `env` 字段并清空 OAuth 凭证
3. 切回 OAuth 账号时自动清除 API Key 环境变量

## 文件路径

| 文件 | 说明 |
|------|------|
| `~/.claude/.credentials.json` | Windows OAuth 凭证（macOS 上由 Keychain 保管） |
| `~/.claude.json` | Claude Code 全局配置（只修改 userID / oauthAccount 字段） |
| `~/.claude/settings.json` | Claude Code 设置（API Key 模式写入 env 字段） |
| `~/.claude/profile-cache.json` | 状态栏 profile 缓存（切换时被自动清除） |
| `~/.claude/usage-cache.json` | 状态栏用量缓存（切换时被自动清除） |
| `~/.ccs/config.json` | CCS 账号列表和当前活跃账号 |
| `~/.ccs/accounts/<name>.credentials.json` | 账号 credentials 快照 |
| `~/.ccs/accounts/<name>.state.json` | 账号状态快照（userID / oauthAccount） |
| `~/.ccs/launch-web.vbs` | Windows 桌面快捷方式调用的无窗口启动器 |

## 测试时使用自定义路径

```bash
export CCS_HOME=/tmp/ccs
export CLAUDE_HOME=/tmp/claude
ccs status
```

## 主动刷新 token

`scripts/refresh-token.js` 调用 Anthropic OAuth refresh 端点，把当前 OAuth access token 续期 8 小时，并把新 credentials 同时写入 live 和 ccs 快照：

```bash
node scripts/refresh-token.js
```

适用场景：
- 长期不切换的账号担心 refresh_token 临近 30 天滑动窗口失效时主动续命
- 验证 share sync 跨端 token 同步链路

注意：每次刷新会 rotate refresh_token，旧 refresh_token 立即作废。两端 share sync 启用时，本端刷完后应立刻触发同步推到对端，否则对端持有的旧 refresh_token 会失效。

## 状态栏脚本

`scripts/statusline-command.sh` 是 Claude Code 状态栏脚本，输出三行信息：

- 第一行：`user@host MSYSTEM 当前目录`
- 第二行：模型 | ctx 用量 | 累计费用 | 5h/7d 速率限制（直接查 `/api/oauth/usage`，60s 缓存）
- 第三行：OAuth 账号姓名、邮箱、套餐（查 `/api/oauth/profile`，5 分钟缓存）

切换账号时 CCS 自动清除两个缓存文件，状态栏下次刷新立即显示新账号信息。

**配置方法**（在 `~/.claude/settings.json` 的 `hooks` 中添加）：

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/statusline-command.sh"
          }
        ]
      }
    ]
  }
}
```

将 `scripts/statusline-command.sh` 复制到 `~/.claude/statusline-command.sh` 即可使用。脚本路径全部使用 `os.path.expanduser` 动态解析，兼容 Windows Git Bash 和 macOS。

## 版本变更

- **v3.7.0**：多端共享同步（Windows ↔ WSL/Linux）。两端 ccs web 通过 HTTP 互访，按账号粒度同步整个 ccs 账号库（OAuth + API Key），同步前自动把 live 数据回写到当前 active 账号快照。`updatedAt` 决定方向，hash 跳过相同账号；`activeAccount` 和账号删除不同步，各端独立。预共享 Bearer 密钥鉴权；可绑定 0.0.0.0 监听 LAN，启用后 web 服务常驻不退 idle。Web UI 加版本号显示和「关闭服务」按钮，移除「同步快照」按钮和有效/过期徽章
- **v3.6.0**：切换/退出前自动同步 live credentials 到 active 快照，避免 Anthropic refresh token 轮换后旧快照失效；新增 `ccs sync` 命令和 Web UI「同步快照」按钮；Web 启动时自动同步一次
- **v3.5.0**：Web UI 新增「退出当前账号」按钮
- **v3.4.0**：Web 服务 5 分钟空闲自动退出
- **v3.3.1**：活跃 OAuth 账号显示从 live credentials 实时读取，反映 token 自动续期
- **v3.3.0**：macOS 通过 Keychain 读写 OAuth 凭证
- **v3.2.0**：Windows 桌面快捷方式无窗口启动 + 自动杀旧进程；状态栏直查用量与 profile
- **v3.1.0**：API Key 账号支持；Web UI 导入/编辑/删除；安装时自动创建桌面快捷方式
- **v3.0.0**：纯文件操作模式（去除 daemon/watch 架构）

## License

MIT © 2026 baiqiang

