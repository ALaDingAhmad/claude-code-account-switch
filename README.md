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

Claude Code 自带状态栏依赖进程内 stdin 注入的 profile / usage 数据，跨账号切换后会显示旧账号信息。`scripts/statusline-command.sh` 改成直接查 `/api/oauth/profile` 和 `/api/oauth/usage`，按 token hash 做缓存键，切换账号时 CCS 自动清缓存，**下次刷新立即显示新账号**。

输出三行：

- 第一行：`user@host MSYSTEM 当前目录`
- 第二行：模型 | ctx 用量 | 累计费用 | 5h/7d 速率限制（60s 缓存）
- 第三行：OAuth 姓名、邮箱、套餐（5 分钟缓存）；**最近 30 分钟内被监控守护切过账号则显示红色提示「⚠ 已切到 X（HH:MM），重启 Claude Code 生效」**，重启后自动消失

v3.9.0 起状态栏**只展示用量，不再做切换决策也不 spawn 任何后台进程**。自动切换由 Web UI 启用的守护进程统一负责（见下节）。

在 Web UI 的「Claude Code 状态栏」区块点「安装」即可：复制 `statusline-command.sh` 到 `~/.claude/`，并写入 `~/.claude/settings.json` 的 `statusLine` 字段。卸载同理一键完成。

## 自动切换守护进程

独立轮询用量、在撞墙前主动切换。**入口只剩一条**：Web UI「账号用量监控」区块勾选启用。

轮询频率：

- < 90%：每 60s
- 90–95%：每 60s
- 96–98%：每 10s
- ≥ 99%：立即切换，切换成功才退出（v3.8.9：切换失败 60s 重试，等候选自然 reset）
- API 返回 429（active 撞墙信号）：force 切换后退出

退出条件：

- 切换成功
- `~/.ccs/usage-monitor.disabled` 文件存在（Web UI 关闭开关时自动写入）
- 运行超过 7 天（兜底，防意外泄漏）

错误处理：查询失败按 60 / 120 / 240 / 300s 指数退避持续重试，不退出（网络抖动自愈）。

单例保护：`~/.ccs/usage-monitor.pid` + 进程探活（Windows 走 `OpenProcess`+`GetExitCodeProcess`，Unix 走 `os.kill(pid,0)`）+ `atexit` 清理。

Web UI「账号用量监控」状态卡片展示 enabled / running / pid / uptime / 最近 30 行日志，10s 自动刷新。装/卸载守护独立于状态栏，互不依赖。

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
| `~/.ccs/config.json` | CCS 账号列表、当前活跃账号、共享同步配置、本机 `nodeId`（节点身份） |
| `~/.ccs/accounts/<name>.credentials.json` | 账号 credentials 快照 |
| `~/.ccs/accounts/<name>.state.json` | 账号状态快照（userID / oauthAccount） |
| `~/.ccs/web.pid` | 当前运行的 ccs web 进程信息（PID/port/share 状态） |
| `~/.ccs/web.log` | `ccs web share` 后台模式的日志 |
| `~/.ccs/launch-web.vbs` | Windows 桌面快捷方式调用的无窗口启动器 |
| `~/.ccs/account-usage.json` | 账号用量缓存表（守护进程每轮查询后更新 active 条目） |
| `~/.ccs/auto-switch.log` | 自动切换守护进程日志 |
| `~/.ccs/usage-monitor.pid` | 守护进程 PID 文件（单例保护） |
| `~/.ccs/usage-monitor.disabled` | 存在时关闭守护（Web UI 关闭开关时自动写入） |
| `~/.ccs/last-switch.json` | 最近一次自动切换记录（供状态栏第三行显示重启提示） |
| `~/.claude/auto_switch_core.py` | 切换决策核心模块（启用 Web UI 监控时复制） |
| `~/.claude/usage_monitor.py` | 用量监控守护进程主程序（启用 Web UI 监控时复制） |

## 自定义路径（测试用）

```bash
export CCS_HOME=/tmp/ccs
export CLAUDE_HOME=/tmp/claude
ccs status
```

## 版本变更

- **v3.9.0**：状态栏不再做自动切换，切换决策权完全收归 Web UI 守护
  - 状态栏脚本删除内联切换 + spawn 守护两块逻辑，只保留用量展示和「重启 Claude Code 生效」红色提示
  - 自动切换入口只剩一条：Web UI「账号用量监控」开关；想用自动切换必须开 Web 监控
  - `src/statusline.js` 不再复制/删除 `auto_switch_core.py` / `usage_monitor.py`，全部由 `src/monitor.js` 管理；避免卸载状态栏顺手把守护文件删掉的连环 bug
  - `~/.ccs/auto-switch.disabled` 不再生效（无人读取），存量文件可手动删除
- **v3.8.9**：用量监控守护进程退出条件修复
  - 5h < 90% 不再退出，改为 60s 间隔持续轮询。原行为下从 Web UI spawn 守护后会立即退出（用量没到阈值），等于关了 Web 监控就再起不来
  - 查询失败改为指数退避 60/120/240/300s 持续重试（原行为：连续 5 次错误后退出），网络抖动场景自愈
  - 切换尝试失败不再退出（原行为：≥99% 切换尝试一次就退），改为 60s 后重试直到真切换成功
  - `MAX_RUNTIME` 由 2h 放宽到 7 天，仅作为意外泄漏的兜底；真实停止信号是 `~/.ccs/usage-monitor.disabled` 文件
- **v3.8.8**：Web UI 新增账号用量监控开关（无需状态栏）
  - 「账号用量监控」区块独立于状态栏，勾选即在后台 spawn 守护轮询用量并自动切换，不爱用状态栏的人也能用
  - 状态卡片展示 enabled / running / pid / uptime / 最近 30 行日志，10s 自动刷新
  - 新增 `src/monitor.js`、`src/web.js` 路由 `GET /api/monitor/status`、`POST /api/monitor/enable`、`POST /api/monitor/disable`
  - 守护启用时自动安装 `auto_switch_core.py` / `usage_monitor.py` 到 `~/.claude/`，与状态栏安装互不依赖
- **v3.8.7**：用量监控守护进程 + 切换逻辑模块化
  - 新增 `usage_monitor.py`：active 5h ≥ 90% 时由状态栏 tick spawn 单例守护进程，90–95% 每 60s 轮询，96–99% 每 10s 轮询，≥99%/429 立即切换后退出；pid 文件单例 + atexit 双保险防僵尸进程
  - 新增 `auto_switch_core.py`：将切换决策逻辑抽成独立 Python 模块，守护进程和状态栏脚本共用
  - `src/statusline.js` install/uninstall 同步复制/清理两个 py 辅助文件
  - 关闭守护：`touch ~/.ccs/usage-monitor.disabled`
- **v3.8.6**：自动切换后状态栏第三行显示红色重启提示 + Windows ccs 路径修复
  - 切换成功后写 `~/.ccs/last-switch.json`；30 分钟内状态栏第三行追加红色加粗「⚠ 已切到 X（HH:MM），重启 Claude Code 生效」，重启后自动消失
  - 修复 Windows 下 `subprocess.run(['ccs', ...])` WinError 2：Python 不解析 PATHEXT 找不到 `ccs.CMD`，改用 `shutil.which` 拿全路径
- **v3.8.5**：（含于 v3.8.6 提交）
- **v3.8.4**：自动切换乐观切兜底 + 测试脚本移出仓库
  - 候选 token 快照被服务端 rotate 后查 usage 返回 401，原逻辑直接放弃该候选；改为标记 unknown，无 known<99 候选时乐观切首个 OAuth 候选（ccs 切换主流程做完整 refresh）
  - `.gitignore` 加 `test-*`/`*_test.*`/`tests/`，仓库内测试脚本一并 untrack；`.npmignore` + `package.json files` 精确化，npm 包不带测试脚本
- **v3.8.3**：CLI 加 `--version`/`-v`，状态栏显示 ccs 版本
  - `ccs --version` / `ccs -v` 输出 package.json 里的版本号
  - 状态栏脚本第一行末尾灰色显示当前安装的 ccs 版本（如 `(ccs 3.8.3)`），方便排查"用的是新版还是旧版"
  - 实现：源脚本里写占位符 `__CCS_VERSION__`，`ccs statusline install` 时把它替换为真实版本号；零运行时开销
- **v3.8.2**：状态栏脚本自动切账号 + 用量表
  - 5h ≥ 99% 时自动切到非 active 且 5h<99% 的 OAuth 账号；全满则不切（等手动或自然 reset）
  - 维护 `~/.ccs/account-usage.json` 用量表：每次状态栏 tick 更新 active 数据；评估候选时 `now < resets_at` 用表，过期/缺失则用 ccs 快照 token 调 `/api/oauth/usage` 重查；401/网络失败该候选跳过
  - 候选评估顺序按 `config.accounts` 字典顺序，命中首个可切就停
  - 关闭开关：`touch ~/.ccs/auto-switch.disabled`
  - 日志：`~/.ccs/auto-switch.log`
  - usage cache 增加 `five_hour_reset` 字段（来自 API `five_hour.resets_at`）
  - 新增 `scripts/test-autoswitch.sh` 隔离环境测试 4 个场景
- **v3.8.1**：状态栏脚本 mac 兼容 + 颜色/显示修复
  - mac 上 OAuth 凭证存在 Keychain（不是文件）；usage/profile 两段 Python 加 macOS Keychain fallback（`security find-generic-password -s "Claude Code-credentials" -a $USER -w`），不再只读文件
  - 颜色码 `\e[` 全部改为 `\033[`（13 处），兼容 macOS 系统自带 bash 3.2（不识别 `\e`）
  - 修复金额双美元 bug（`$$1.2345`）—— Python 已加 `$` 前缀，shell printf 再加一次造成重复
  - 金额颜色由浅白 `\033[37m`（深色主题看不清）改为 256 色棕 `\033[38;5;130m`
  - 新增 `scripts/test-mac-api.sh`：单测 mac 上 token 读取 + profile/usage API 连通性
  - 新增 `scripts/test-mac-statusline.sh`：模拟 Claude Code stdin JSON 跑完整脚本，验证渲染结果
- **v3.8.0**：账号删除多端同步（修复 ccs web share 被恢复 bug）
  - **数据结构**：`~/.ccs/config.json` 新增 `deletedAccounts` 段存放墓碑；账号新增 `createdAt` 字段做版本号
  - **删除语义**：`ccs remove` 改为把账号挪到 `deletedAccounts`、credentials 文件直接删；禁止删除当前 active 账号（需先切走）
  - **同步**：snapshot 协议加 `deletedAccounts` 段，syncOnce 处理九态决策：双方活/双方死/单方活 vs 单方死 等组合
  - **复活规则**：重导入同名账号生成新 `createdAt`，同步时 alive.createdAt > tomb.deletedAt 才复活，否则保留墓碑
  - **新增 RPC**：`POST /api/share/delete` 让对端通知本端删除
  - **同名重导入**：直接新建条目（不复用墓碑槽位），墓碑保留作为历史
- **v3.7.13**：修复状态栏装到错误的 settings.json 字段导致不显示
  - 早期版本误把 `statusline-command.sh` 装到 `hooks.Stop`（每次 Claude 停止时执行一次，输出被丢弃），不是真正的状态栏
  - 改为写入顶层 `statusLine` 字段（Claude Code 状态栏正确接口，输出展示在终端底部）
  - install 时顺手清掉旧的 `hooks.Stop` 残留，避免脚本被重复执行；uninstall 同时清两处
- **v3.7.12**：`ccs web` 记住上次成功监听的端口
  - 监听成功后把 `actualPort` 写回 `~/.ccs/config.json` 的 `lastWebPort`
  - 下次 `ccs web` 没显式指定端口时，优先用 `lastWebPort`，否则回退到默认 7899
  - 解决"7899 长期被占 → 每次启动 +1 撞到不同端口 → URL 老变"的烦恼
- **v3.7.11**：修复切回 OAuth 后老 claude 进程仍走 API Key
  - `_clearApikeyEnv` / `_switchApiKey` 由 `delete env.ANTHROPIC_*` 改为 `env.ANTHROPIC_* = ''` 覆盖
  - Claude Code 热重载 `settings.json.env` 是 merge 语义，删字段不会清掉进程内存里已设过的旧值；空字符串才能强制覆盖，免重启即可生效
  - 顺手把遗漏的 `ANTHROPIC_API_KEY` 也纳入清理范围
- **v3.7.10**：
  - `ccs web share` 复用本机已运行的 web 服务：检测到 `~/.ccs/web.pid` 活进程则通过 `POST /api/share/config` 在线启用 share，不再 spawn 第二个进程抢端口
  - 引入 `nodeId`（启动 web 时生成并持久化到 `~/.ccs/config.json`）作为节点身份；配置 `peerUrl` 前通过无鉴权 `GET /api/share/whoami` 探活，命中本机自身 → 拒绝；探活失败 → warn 后放行
  - 自指校验同时覆盖 CLI（`ccs web share --peer`）和 HTTP API（Web UI 共享同步配置）两条入口
- **v3.7.9**：`ccs web share` 接受 `--secret` 参数，可一行命令完成「设密钥 + 启用 share + 启动 web」三步合一；invite 提示文本同步改为一行命令；README 多端共享同步章节改为一行命令风格
- **v3.7.8**：修正 `ccs web share` 启动提示按本机角色分支输出
  - 本机是从节点时，明确显示主节点 URL 和"请确保主节点已启动"提示，给出在主节点执行的命令；不再误导让对端配置成"连到本机"
  - 本机是主节点时，给出在从节点执行的 enable 命令
- **v3.7.7**：共享同步方向判据改用 OAuth `expiresAt` 作主键（access token 续期必向后跳 8h，单调递增，是真版本号），API Key 仍用 `updatedAt`。彻底摆脱 updatedAt 被本地操作时间干扰造成的方向误判
- **v3.7.6**：修复共享同步「无差异/掉线」bug
  - `_syncActiveSnapshot` 仅在 live 内容跟现有快照不同时才刷新 `updatedAt`，避免每次轮询都把 updatedAt 推到 now，破坏内容版本号语义
- **v3.7.5**：README 顶部和 Web UI 顶部加显眼安全须知（Web 服务无鉴权，仅限可信内网/VPN 使用）；Web UI 加 footer 显示版本号、MIT、版权、GitHub/npm 链接
- **v3.7.4**：Web UI 新增「Claude Code 状态栏」一键安装/卸载，配合 ccs 切换账号让 Claude Code 状态栏实时显示当前真实账号信息和用量。安装会复制 `statusline-command.sh` 到 `~/.claude/` 并注入 `hooks.Stop`，状态检测分三态：已安装 / 缺脚本 / 缺 hook
- **v3.7.3**：共享同步术语统一为「主节点 / 从节点」（原"被动方/主动方"易混淆）；CLI 输出、Web UI 文案、README 一并改；架构说明改为 1 主节点 + N 从节点的 hub-spoke 主从同步
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
