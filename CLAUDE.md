# Claude Code Account Switch (ccs)

Claude Code 多账号切换工具。OAuth + API Key 双模式，带守护进程自动切换。

## 架构

- **Node.js 层** (`src/`): CLI 入口 (`bin/ccs.js`)、账号存储 (`store.js`)、Web UI (`web.js`)、状态栏 (`statusline.js`)
- **Python 层** (`scripts/`): 守护进程 (`usage_monitor.py`)、切换核心 (`auto_switch_core.py`)、HTTP helper (`anthropic_http.py`)
- **文档** (`doc/`): `守护进程行为规则.md` 是不变量（改代码不改规则），`守护进程演进笔记.md` 是变更日志

## 关键路径

- 切换执行：`store.js switchAccount()` → 写 live credentials（v3.12.0 故意标 expiresAt 过期逼 refresh）
- 守护监控：`usage_monitor.py main()` → 读缓存/发请求 → `auto_switch_core.decide_and_switch()`
- 候选评估：core 里的 `query_usage_for_token()` 三态+假401（v3.12.7）
- 共享缓存：`~/.ccs/usage-shared-cache.json`，TTL 100s，monitor/statusline/core 共用

## 关键约定

- 守护行为规则以 `doc/守护进程行为规则.md` 为准，代码与规则冲突时改代码
- 候选号 unknown 一律不切（v3.10.2 删除乐观切分支）
- 401 + resets_at 已过 = 假 401 = token 过期不是额度用尽，当可用处理（v3.12.7）
- 5h 和 resets_at 是配套数据：5h>=99 但 resets_at 已过 = 过期数据，不触发切换（v3.12.7）
- test-* / *_test.* / tests/ 不进 git
