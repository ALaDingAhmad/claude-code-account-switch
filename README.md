# CCS - Claude Code Account Switcher

[![npm version](https://img.shields.io/npm/v/claude-code-account-switch.svg)](https://www.npmjs.com/package/claude-code-account-switch)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/claude-code-account-switch.svg)](https://nodejs.org)

Windows / macOS / Linux / WSL 多平台 CLI 工具，通过备份和还原 Claude Code 凭证（Windows/Linux 文件、macOS Keychain）及 `~/.claude.json` 中的账号字段，实现 Claude Code 多账号一键切换。**支持 Web UI 操作和多端 LAN 内共享同步登录态**，同时支持 OAuth 和 API Key 两种账号类型。

不代理请求，不切换 profile 目录，不影响 `.claude/sessions`、`history.jsonl` 和项目状态。

> ⚠️ **安全须知**：Web 服务本身**不带鉴权**，监听端口的任何人都能通过 API 切换账号、查看共享密钥、导入/删除账号。
> - 默认绑 `127.0.0.1`（仅本机访问）→ 安全
> - 共享同步切换到 `0.0.0.0`（LAN 可达）后，**仅限可信内网/VPN 使用**，不要暴露到公网，也避免在共用 Wi-Fi 等不可信环境启用
> - 共享同步的 `Bearer` 密钥保护 `/api/share/*` 端点，但**不保护**其他 API（`/api/switch`、`/api/import` 等）

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
- **账号用量监控开关**（v3.8.8+）：勾选即在后台 spawn 守护进程独立轮询用量并自动切换，状态卡片展示 pid、运行时长、最近 30 行日志
- 顶部显示版本号 + 关闭服务按钮

Windows 双击桌面快捷方式即可启动（无 cmd 窗口）。普通模式 web 服务 5 分钟无请求自动关闭。

## 多端共享同步

**架构：1 个主节点 + N 个从节点（主从同步）**

- **主节点**：HTTP 服务端，不主动发请求，只响应从节点的查询。**它是数据的权威源**（所有从节点都跟它对账）。配置里「主节点 URL」留空
- **从节点**：每 30 秒访问主节点，按账号粒度比较 hash + updatedAt：自己新就 push 给主节点，主节点新就 pull。任意从节点的改动都会先同步到主节点，再通过其他从节点的轮询扩散到所有节点

`activeAccount` 不同步，各端独立。账号删除会通过墓碑同步（v3.8.0+，按 `createdAt` 和 `deletedAt` 时间戳决策，避免删后重导入被对端再次推回）。

### 一键命令（推荐）

**Step 1 — 起主节点**（任选一台稳定常驻、LAN 可达的机器）：

```bash
ccs web share
```

终端打印主节点 URL 和自动生成的 Secret：

```
本机角色  : 主节点（被动响应，等待从节点访问）
本机 URL  : http://192.168.1.168:7899
共享密钥  : ca3eace3acdc1e39db7995e2ffc52215ad0dc9ba7780d715de223c7db814ea47
```

**Step 2 — 每个从节点一行命令**（用 Step 1 给的 URL 和 Secret）：

```bash
ccs web share --peer http://192.168.1.168:7899 --secret <粘贴 Secret>
```

N 个从节点重复 Step 2 即可，**从节点之间不需要互联**，全靠主节点扇出。

### Web UI 配置（推荐入口）

也可以在 Web UI「多端共享同步」区域勾选启用，填好 URL 和 Secret 保存。

### CLI 一键模式

任一端跑 `ccs web share`，后台守护启动 web 并自动打印 URL+Secret：

```bash
$ ccs web share
URL    : http://192.168.1.168:7900
Secret : ca3eace3acdc1e39db7995e2ffc52215ad0dc9ba7780d715de223c7db814ea47
角色   : 被动方（等待对端访问）
停止服务: ccs web stop
```

对端粘贴提示行即可：

```bash
ccs share enable --peer http://192.168.1.168:7900 --secret <粘贴 secret>
ccs web 7899
```

### 注意事项

- 每次 OAuth refresh 会 rotate refresh_token，旧的立即作废。share sync 启用时本端刷完后通过主动方自动同步到其他端；如同步链路断开期间发生 refresh，未同步的端会失效
- 凭证走 LAN 明文（仅 Bearer 鉴权），仅建议同一可信网络内使用
- 启用 share 后 web 不退 idle，需 `ccs web stop` 或浏览器访问 `/api/shutdown` 停止
- macOS 端理论支持（通过 `security` CLI 读写 Keychain），第一次接收同步弹 Keychain 授权框选「始终允许」后免确认；未在真实多机环境验证过

## CLI 用法

Web UI 是推荐入口。CLI 用于无浏览器场景（Linux 服务器、自动化脚本）或快捷操作。完整命令用 `ccs --help` 查看。

```bash
# 切换
ccs <name>                # 切到 <name>
ccs                       # 看当前状态 + 账号列表 + web/share 运行状态

# 导入：在 Claude Code 登录目标账号后
ccs import <name>

# 共享同步
ccs web share             # 一键后台启动
ccs share enable --peer http://X:7899 --secret abc
ccs web stop
```

## API Key 账号

支持通过 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` 使用第三方 API 服务：

1. 在 Web UI「导入 → API Key」标签填入名称、Token 和 Base URL（或用 CLI）
2. 切换到该账号后 CCS 自动写入 `~/.claude/settings.json` 的 `env` 字段并清空 OAuth 凭证
3. 切回 OAuth 账号时自动清除 API Key 环境变量

## 状态栏脚本

**配合 ccs 切换账号，让 Claude Code 状态栏实时显示当前真实账号信息和用量。**

切换账号后状态栏自动清缓存，下次刷新立即显示新账号信息。输出：

- 第一行：`user@host MSYSTEM 当前目录`
- 第二行：模型 | ctx 用量 | 累计费用 | 5h / 7d 速率限制
- 第三行：OAuth 姓名、邮箱、套餐
- 第四行（条件性）：最近 5 分钟内被监控守护切过账号时显示「最近切到 X（HH:MM）」

在 Web UI 的「Claude Code 状态栏」区块一键安装 / 卸载。

## 自动切换守护进程

独立轮询用量、在撞墙前主动切换；**入口**：Web UI「账号用量监控」区块勾选启用。

- 每 100s 查一次 5h 用量
- 撞 5h 墙时自动切到可用账号；所有账号都用尽时切到最快能恢复的号并等到它恢复
- Web UI 状态卡片展示运行状态、最近日志，10s 自动刷新
- 守护进程意外死亡会被自动拉起（看门狗 + Windows 登录自启）

相关 CLI：

```bash
ccs monitor status          # 查守护状态 / 最近日志
ccs monitor enable          # 启用守护并注册开机自启
ccs monitor disable         # 停止并移除自启
```

仅 Windows 支持任务计划程序集成。**已知限制**：Windows 睡眠 / 休眠期间守护冻结，跨过撞墙时刻仍会漏切（OS 层面限制）。


## 版本变更

- **v3.12.0**：切号无需重启 Claude Code。OAuth 切号时写入 live credentials 的 `expiresAt` 强制为已过期，逼 Claude Code 进程下一次请求前走 refresh 流程并清掉内存里 memoize 的旧 token 缓存（机制来自 Claude Code 源码 `utils/auth.ts:invalidateOAuthCacheIfDiskChanged`）。修复"同一 Claude Code 窗口切号后用量跳着涨、必须退出重开才正常"的痛点。snapshot 文件不受污染——CCS 自己的快照保留原始 `expiresAt`，下次切回这个号继续可用。
- **v3.11.2**：守护重写 + 写表语义澄清。
  - 守护主循环按 `doc/守护进程行为规则.md` 重写：删除 `_idle_recheck_loop` / `STARTUP_GRACE` 等过度设计；用户离开时不发请求但每 5s 检查心跳（之前 5min，导致用户回来感知慢）
  - `account-usage.json` 表语义改为"切换流水账"：唯一写入时机是 `store.switchAccount` 触发——切换前把被切走的当前号 5h 数据（从共享缓存读）落表。Web UI 看到的就是切换那一刻的快照
  - 撤回 v3.11.1 守护每轮写表（过度设计）
- **v3.11.1**：Web UI 账号卡片显示每号 5h 用量和 reset 时间（来自 `~/.ccs/account-usage.json`）
- **v3.11.0**：Web UI 顶部加「升级」「重启」按钮。升级跑 `npm install -g claude-code-account-switch@latest`；重启按钮用 spawn+wait 模型——立刻 spawn 新进程带 `--wait-for-pid`，新进程自己等旧 pid 死+端口可绑再启，原端口接管。`startWebServer` 加 already-running 守卫避免多实例占多端口。状态栏和守护新增 stale 检测：升级 ccs 后已装脚本与源码不一致 / 进程未重启加载新代码时，Web UI 显示橙色提示
- **v3.10.8**：守护判定大幅简化——只看 `five_hour` 百分比 ≥99 就切，不再依赖 cf-edge 429 / 真 429 头部判断。业务用尽时状态栏拿到的是 200 + 100%，比 429 头部识别可靠得多；之前"用量 96% 跳用尽 + 查询过频被 cf 拦"的边界 case 被彻底消除
- **v3.10.7**：守护改为缓存优先调度——每 10s 看一次状态栏写入的共享缓存，缓存新鲜就直接走决策，stale 才自己发请求。99% 触发切换的响应延迟从最坏 100s 降到 ≤10s。同步修复 Windows 上自动切换时一闪而过的命令窗口
- **v3.10.6**：长时间不用 Claude Code 时守护进程暂停轮询，避免空请求累积 429。状态栏每次刷新写心跳，守护静默 ≥5min 就停查询；用户回来下一次状态栏刷新立刻恢复。启动后 10min 宽限期不受门控影响，避免开机自启误停
- **v3.10.5**：修复 Token 过期时间显示错时区的问题（设 `CCS_DISPLAY_TZ` 即可指定显示时区）
- **v3.10.4**：用量查询统一 100s 节奏，避免过密查询被 Cloudflare 拦下
- **v3.10.3**：状态栏与守护进程共用查询缓存，避免重复打 API
- **v3.10.2**：修复用量监控反复误切账号的 bug；所有账号都用尽时改为切到最快恢复的号并等到它恢复
- **v3.10.1**：开机后等环境就绪再启动守护，避免开机瞬间误判失败
- **v3.10.0**：守护进程意外退出会自动拉起；Windows 开机自动启动
- **v3.9.0**：状态栏只展示用量，切换决策统一交给 Web UI 后台守护
- **v3.8.9**：守护进程更稳，不会因为用量没到阈值就提前退出
- **v3.8.8**：Web UI 新增「账号用量监控」开关，不依赖状态栏也能用
- **v3.8.7**：用量监控独立成后台守护进程
- **v3.8.6**：自动切换后状态栏提示重启 Claude Code
- **v3.8.4**：候选账号查不到用量时也能乐观切过去（v3.10.2 已收紧）
- **v3.8.3**：`ccs --version` + 状态栏显示版本号
- **v3.8.2**：状态栏脚本支持 5h ≥ 99% 自动切账号
- **v3.8.1**：状态栏 macOS 兼容
- **v3.8.0**：账号删除多端同步（解决删了又被对端推回的 bug）
- **v3.7.13**：修复状态栏装错位置导致不显示
- **v3.7.12**：`ccs web` 记住上次端口，URL 不再老变
- **v3.7.11**：切回 OAuth 后立即生效，老 Claude 进程无需重启
- **v3.7.10**：`ccs web share` 复用本机服务，不再抢端口
- **v3.7.9**：`ccs web share --secret` 一行命令邀请对端
- **v3.7.8**：`ccs web share` 启动提示按本机角色分支
- **v3.7.7**：共享同步方向判据更可靠
- **v3.7.6**：修复共享同步「无差异/掉线」bug
- **v3.7.5**：README 和 Web UI 加安全须知 + footer
- **v3.7.4**：Web UI 一键安装 / 卸载状态栏
- **v3.7.3**：共享同步术语统一「主节点 / 从节点」
- **v3.7.2**：README 重排，加徽章和多仓库链接
- **v3.7.1**：v3.7.0 后续打磨（后台模式、端口自动避让、CLI 子命令系列）
- **v3.7.0**：多端共享同步（Windows ↔ WSL/Linux/Mac）
- **v3.6.0**：切换前自动续期，避免切回时凭证已失效
- **v3.5.0**：Web UI 新增「退出当前账号」
- **v3.4.0**：Web 服务 5 分钟空闲自动退出
- **v3.3.1**：活跃 OAuth 账号显示实时反映续期
- **v3.3.0**：macOS 通过 Keychain 读写 OAuth 凭证
- **v3.2.0**：Windows 桌面快捷方式无窗口启动
- **v3.1.0**：API Key 账号支持；Web UI 导入 / 编辑 / 删除
- **v3.0.0**：纯文件操作模式

## License

MIT © 2026 [ALaDingAhmad](https://github.com/ALaDingAhmad)
