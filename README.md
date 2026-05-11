# CCS - Claude Code Account Switcher

[![npm version](https://img.shields.io/npm/v/claude-code-account-switch.svg)](https://www.npmjs.com/package/claude-code-account-switch)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/claude-code-account-switch.svg)](https://nodejs.org)

Windows / macOS / Linux / WSL 多平台 CLI 工具，通过备份和还原 Claude Code 凭证（Windows/Linux 文件、macOS Keychain）及 `~/.claude.json` 中的账号字段，实现 Claude Code 多账号一键切换。**支持 Web UI 操作和多端 LAN 内共享同步登录态**，同时支持 OAuth 和 API Key 两种账号类型。

不代理请求，不切换 profile 目录，不影响 `.claude/sessions`、`history.jsonl` 和项目状态。

- npm：<https://www.npmjs.com/package/claude-code-account-switch>
- GitHub：<https://github.com/ALaDingAhmad/claude-code-account-switch>
- Gitee 镜像：<https://gitee.com/superas/claude-code-account-switch>

## 安装

```bash
# 推荐：从 npm 安装
npm install -g claude-code-account-switch

# 或本地源码
git clone https://github.com/ALaDingAhmad/claude-code-account-switch.git
cd claude-code-account-switch && npm install -g .
```

环境要求：Node.js 18+。Windows 安装后自动在桌面创建「CCS 管理界面」快捷方式（mac/Linux 不创建）。

## Web UI（推荐入口）

启动后浏览器自动打开 <http://127.0.0.1:7899>：

```bash
ccs web                # 默认 7899，端口被占自动 +1
ccs web 8080           # 指定端口
```

页面功能：

- 当前账号 hero 区一键切换 / 退出登录
- 导入账号（OAuth 一键导入当前 live、API Key 填 Token + Base URL）
- 编辑账号（OAuth 显示 token/套餐/过期，API Key 可改 Token 和 baseUrl）
- 删除账号
- **多端共享同步配置区**（见下节）
- 顶部显示版本号 + 关闭服务按钮

Windows 双击桌面快捷方式即可启动（无 cmd 窗口）。普通模式 web 服务 5 分钟无请求自动关闭。

## 多端共享同步

两端 ccs web 通过 HTTP 互访同步整个账号库（OAuth + API Key）。按账号粒度比较 hash + updatedAt 决定同步方向，OAuth token 自动续期跨端可见。`activeAccount` 和账号删除不同步，各端独立。

### 一键启动（推荐）

任意一端启动 share 模式（后台守护，立即返回终端）：

```bash
$ ccs web share

=== 共享同步信息 ===
URL    : http://192.168.1.168:7900
Secret : ca3eace3acdc1e39db7995e2ffc52215ad0dc9ba7780d715de223c7db814ea47
角色   : 被动方（等待对端访问）

在对端执行（任选其一）：
  ccs share enable --peer http://192.168.1.168:7900 --secret ca3e...ea47
  ccs web        # 启动对端 web 后自动同步

Background PID : 60436
Log file       : /home/user/.ccs/web.log
停止服务       : ccs web stop
```

对端粘贴命令即可：

```bash
ccs share enable --peer http://192.168.1.168:7900 --secret <对端给的 secret>
ccs web 7899
```

或对端也走 `ccs web share` 模式（不传 --peer 即被动响应方）。**两端 secret 必须一致**，只需一端填 peer URL 即可双向同步。

### Web UI 配置

在 Web UI「多端共享同步」区域勾选启用，填好两个字段，点保存。

### CLI 单独命令（适合 Linux/WSL 无浏览器）

```bash
ccs share status          # 查看当前配置和上次同步结果
ccs share enable [opts]   # 启用 share-sync
                          # opts: --peer URL --secret X --bind 0.0.0.0|127.0.0.1 --interval MS
ccs share secret          # 输出明文 secret，便于复制到对端
ccs share sync            # 主动方手动触发一轮同步
ccs share disable         # 禁用并清空 secret
ccs web stop              # 停止后台 web 服务
```

### 注意事项

- 每次 OAuth refresh 会 rotate refresh_token，旧的立即作废。两端共享时本端刷完后会自动通过 share sync 推到对端；如果同步链路断开期间发生 refresh，对端持有的旧 refresh_token 会失效
- 凭证走 LAN 明文（仅 Bearer 鉴权），仅建议同一可信网络内使用
- 启用 share 后 web 不退 idle，需 `ccs web stop` 或访问 `/api/shutdown`（GET 即可）停止
- macOS 端理论支持作为 share 节点（通过 `security` CLI 读写 Keychain），第一次接收同步会弹 Keychain 授权框选「始终允许」后免确认；未在真实多机环境验证过

## CLI 用法

### 快速开始

```bash
# 1) Claude Code 已登录账号 A 时，先导入
ccs import account_a

# 2) 在 Claude Code 中切换登录到账号 B，再导入
ccs import account_b

# 3) 随时切换
ccs switch account_a
ccs account_b            # 简写
```

### 完整命令列表

```
# 总览
ccs                       显示当前状态、账号列表、web/share 运行信息
ccs <name>                切换到指定账号（switch 简写）
ccs -                     清除当前登录状态（同 clear-current / logout）
ccs -h / --help           显示帮助

# 账号管理
ccs import <name> [path]  将当前 live credentials 导入为 <name>
ccs switch <name>         切换到已导入的账号
ccs remove <name>         删除已导入的账号
ccs accounts              列出所有已导入账号
ccs status                显示当前状态
ccs sync                  把 live credentials 回写到当前活跃账号的快照
ccs clear-current/logout  清除 live credentials，清空账号状态字段
ccs doctor                检查环境和配置

# Web 服务
ccs web [port]            前台启动 Web UI（默认 7899，端口被占自动 +1）
ccs web share [port] [--peer URL] [--bind ADDR]
                          后台启动 Web UI 并启用共享同步，打印 URL/Secret
ccs web stop              停止后台 web 服务

# 共享同步
ccs share status          查看 share-sync 配置和上次同步结果
ccs share enable [opts]   启用 share-sync
ccs share disable         禁用并清除 secret
ccs share secret          输出明文 secret
ccs share sync            立即触发一轮同步
```

## API Key 账号

支持通过 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` 使用第三方 API 服务：

1. 在 Web UI「导入 → API Key」标签填入名称、Token 和 Base URL（或用 CLI）
2. 切换到该账号后 CCS 自动写入 `~/.claude/settings.json` 的 `env` 字段并清空 OAuth 凭证
3. 切回 OAuth 账号时自动清除 API Key 环境变量

## 主动刷新 token

`scripts/refresh-token.js` 调用 Anthropic OAuth refresh 端点，把当前 OAuth access token 续期 8 小时，并把新 credentials 同时写入 live 和 ccs 快照：

```bash
node scripts/refresh-token.js
```

适用场景：
- 长期不切换的账号担心 refresh_token 临近 30 天滑动窗口失效时主动续命
- 验证 share sync 跨端 token 同步链路

注意：每次刷新会 rotate refresh_token，旧 refresh_token 立即作废。两端 share sync 启用时本端刷完后会自动同步推到对端；如未启用 share，对端持有的旧 refresh_token 会失效。

## 状态栏脚本

`scripts/statusline-command.sh` 是 Claude Code 状态栏脚本，输出三行：

- 第一行：`user@host MSYSTEM 当前目录`
- 第二行：模型 | ctx 用量 | 累计费用 | 5h/7d 速率限制（直接查 `/api/oauth/usage`，60s 缓存）
- 第三行：OAuth 账号姓名、邮箱、套餐（查 `/api/oauth/profile`，5 分钟缓存）

切换账号时 CCS 自动清除两个缓存文件，状态栏下次刷新立即显示新账号信息。

配置（在 `~/.claude/settings.json` 的 `hooks` 中添加）：

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

把脚本复制到 `~/.claude/statusline-command.sh` 即可使用。

## 原理

- `import`：将当前登录的 credentials 和账号状态快照保存到 `~/.ccs/accounts/`
- `switch`：原子替换 live 凭证（Windows/Linux 文件，macOS Keychain），同时把账号状态字段写回 `~/.claude.json`
- 切换后调用 `/api/oauth/usage` 和 `/api/oauth/profile`，清除本地缓存，让状态栏立即显示新账号
- 切换/退出前自动把当前 live credentials 回写到「正要被切走」的账号快照。原因：Anthropic 每次 refresh 都会轮换 refresh_token，旧 token 立即作废；不回写下次再切回会 401
- share sync：两端按账号粒度比较 hash + updatedAt，新者覆盖旧者；同步前先 refreshFromLive 把当前 live 写入 active 账号快照，让 OAuth 自动续期跨端可见

## 平台差异

| 项目 | Windows | macOS | Linux / WSL |
|------|---------|-------|-------------|
| OAuth 凭证存储 | `~/.claude/.credentials.json` | Keychain `Claude Code-credentials` | `~/.claude/.credentials.json` |
| 桌面快捷方式 | 安装时自动创建（`wscript.exe` 无窗口） | 无 | 无 |
| 自动打开浏览器 | `start <url>` | `open <url>` | `xdg-open` |

## 文件路径

| 文件 | 说明 |
|------|------|
| `~/.claude/.credentials.json` | Windows/Linux OAuth 凭证（macOS 上由 Keychain 保管） |
| `~/.claude.json` | Claude Code 全局配置（CCS 只修改 userID / oauthAccount 字段） |
| `~/.claude/settings.json` | Claude Code 设置（API Key 模式写入 env 字段） |
| `~/.claude/profile-cache.json` | 状态栏 profile 缓存（切换时自动清除） |
| `~/.claude/usage-cache.json` | 状态栏用量缓存（切换时自动清除） |
| `~/.ccs/config.json` | CCS 账号列表、当前活跃账号、共享同步配置 |
| `~/.ccs/accounts/<name>.credentials.json` | 账号 credentials 快照 |
| `~/.ccs/accounts/<name>.state.json` | 账号状态快照（userID / oauthAccount） |
| `~/.ccs/web.pid` | 当前运行的 ccs web 进程信息（PID/port/share 状态） |
| `~/.ccs/web.log` | `ccs web share` 后台模式的日志 |
| `~/.ccs/launch-web.vbs` | Windows 桌面快捷方式调用的无窗口启动器 |

## 自定义路径（测试用）

```bash
export CCS_HOME=/tmp/ccs
export CLAUDE_HOME=/tmp/claude
ccs status
```

## 版本变更

- **v3.7.2**：package.json 元信息完善（description 反映多平台支持，repository/homepage/bugs 指向 GitHub，扩展 keywords）；README 重排结构（Web UI 和共享同步前置），加徽章和多仓库链接
- **v3.7.1**：v3.7.0 后续打磨
  - `ccs web share` 改为后台模式（spawn detached），启动后立即返回终端，打印 PID 和停止方法
  - `ccs web stop` 命令读 pid 文件 SIGTERM
  - `ccs web` 端口被占自动 +1 重试，最多 20 次
  - `/api/shutdown` 同时接受 GET 和 POST，浏览器直接访问 URL 即可关闭
  - `ccs CLI` 输出 API Key 类型分支，避免显示 undefined
  - `ccs share` 子命令系列：status / enable / disable / secret / sync（CLI 配置共享同步，适合 Linux 无浏览器）
  - `ccs share enable` 输出 secret 单独成行末尾，便于复制和管道提取
  - `ccs web share` 不传 --peer/--bind 时保留已有配置（sentinel 处理）
  - Web UI 共享同步绑定地址改为下拉选择
  - Web UI 保存 share 配置时不再把 mask secret 当真值回写（前后端双重防御）
  - Web UI 共享同步设置定时刷新只更新「上次同步」状态，不覆盖用户正在编辑的输入
  - mac keychain 操作改用 spawnSync 避免 shell 注入隐患（read/write/delete/exists 统一）
- **v3.7.0**：多端共享同步（Windows ↔ WSL/Linux）
  - 两端 ccs web 通过 HTTP 互访，按账号粒度同步整个账号库（OAuth + API Key）
  - 同步前自动 refreshFromLive：把当前 live credentials 回写到 active 账号快照，反映 OAuth 自动刷新后的最新 token
  - `updatedAt` 决定方向，hash 跳过相同账号；`activeAccount` 和账号删除不同步
  - Bearer 密钥鉴权；启用后 web 不退 idle
  - 一键命令 `ccs web share` 后台启动 + 打印 URL/Secret，`ccs web stop` 停止
  - CLI 全套 `ccs share status/enable/disable/secret/sync` 适合 Linux 无浏览器场景
  - `ccs` 默认输出和 `ccs doctor` 显示 web/share 运行状态（pid 文件机制）
  - Web UI 加版本号显示、「关闭服务」按钮、「多端共享同步」配置区；移除「同步快照」按钮和有效/过期徽章
- **v3.6.0**：切换/退出前自动同步 live credentials 到 active 快照，避免 Anthropic refresh token 轮换后旧快照失效；新增 `ccs sync` 命令；Web 启动时自动同步一次
- **v3.5.0**：Web UI 新增「退出当前账号」按钮
- **v3.4.0**：Web 服务 5 分钟空闲自动退出
- **v3.3.1**：活跃 OAuth 账号显示从 live credentials 实时读取，反映 token 自动续期
- **v3.3.0**：macOS 通过 Keychain 读写 OAuth 凭证
- **v3.2.0**：Windows 桌面快捷方式无窗口启动 + 自动杀旧进程；状态栏直查用量与 profile
- **v3.1.0**：API Key 账号支持；Web UI 导入/编辑/删除；安装时自动创建桌面快捷方式
- **v3.0.0**：纯文件操作模式（去除 daemon/watch 架构）

## License

MIT © 2026 [ALaDingAhmad](https://github.com/ALaDingAhmad)
