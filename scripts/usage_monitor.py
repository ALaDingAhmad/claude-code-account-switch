"""用量监控守护进程。

调度循环（v3.10.8 起，判定大幅简化）：
  每 10s 一轮：
    心跳静默        → idle-recheck（5min 一次只看心跳，不读缓存不发请求）
    缓存新鲜 + 200  → 用缓存里的 5h 走决策（状态栏每次刷新会写新鲜缓存）
    缓存 stale/non200 → 自己发请求（_query_active_usage，100s 节流）

  拿到 5h 后判定：
    5h >= 99       → 切换（成功也不退出，继续盯新 active）
    5h < 99        → 10s 一拍继续盯
  查询失败/无数据  → 10s 后再看缓存
  全候选用尽       → sleep 到最早 reset + 60s 再醒
  disabled 文件    → 退出
  运行超 7 天      → 退出（兜底）

设计核心：业务用尽时状态栏查 /api/oauth/usage 拿到的是 200 + 100%（实测验证），
守护只需要读到 100% 就切，不再依赖"真 429 vs cf-edge 429"的脆弱判断
（cf 提前拦截会让真用尽被误判为查询限流）。响应延迟 ≤10s。

单例保护：~/.ccs/usage-monitor.pid
"""
import json, os, sys, time, hashlib, atexit
import urllib.request, urllib.error
from datetime import datetime, timezone

PID_FILE  = os.path.expanduser('~/.ccs/usage-monitor.pid')
LOG       = os.path.expanduser('~/.ccs/auto-switch.log')
DISABLED  = os.path.expanduser('~/.ccs/usage-monitor.disabled')
HEARTBEAT = os.path.expanduser('~/.ccs/statusline-heartbeat')
CACHE_FILE = os.path.expanduser('~/.ccs/usage-shared-cache.json')
CREDS     = os.path.expanduser('~/.claude/.credentials.json')
USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

MONITOR_THRESHOLD  = 90   # 用量分档阈值（保留，未来想分档时改 INTERVAL_SLOW 即可）
SWITCH_THRESHOLD   = 99   # 高于此值触发切换
INTERVAL_IDLE      = 100  # 5h < 90% 闲时轮询间隔
INTERVAL_SLOW      = 100  # 90-98% 紧密期、错误重试、切换失败重试（v3.10.4 起统一 100s）
# v3.10.4 起两档都 100s：与共享缓存 TTL 对齐；实测 30s 会触发 Cloudflare 边缘 429
MAX_ERRORS         = 5
MAX_RUNTIME        = 86400 * 7  # 7 天（实质无限，disabled 文件才是真正的停止信号）

# v3.10.6：状态栏心跳门控。用户离开 Claude Code 时状态栏停止刷新，心跳 mtime 不再更新。
# 守护每轮先看心跳：静默 ≥ ACTIVE_WINDOW 就进 idle-recheck 模式，IDLE_RECHECK 一次只看
# mtime，不发任何 HTTP 请求。心跳恢复立刻回正常轮询。
# 真 429（用尽）路径不受门控影响——用尽就该切，跟用户在不在用无关。
# STARTUP_GRACE：守护刚启动时给的宽限期，无视心跳门控正常轮询。覆盖"首次装完还没刷新过
# 状态栏"或"开机自启时状态栏还没起来"的场景，避免守护一启动就误判为静默。
ACTIVE_WINDOW = 300   # 状态栏 5min 内有刷新视为活跃
IDLE_RECHECK  = 300   # 静默时每 5min 看一次心跳
STARTUP_GRACE = 600   # 启动后 10min 内无视心跳门控

# v3.10.7：缓存优先调度。
# 守护每 CACHE_TICK 秒看一次共享缓存：状态栏每次刷新会写最新 usage，守护读到就走决策。
# 缓存 stale ≥ CACHE_MAX_AGE 时（如用户在用 Claude 但状态栏不再刷新）才自己发请求。
# 比之前 100s 固定轮询响应快 10×，HTTP 量基本不增（状态栏本来就在打）。
CACHE_TICK     = 10
CACHE_MAX_AGE  = 100  # 与 anthropic_http.CACHE_TTL 对齐


def log(msg):
    try:
        from datetime import datetime
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(f"[{datetime.now().strftime('%F %T')}] [monitor] {msg}\n")
    except Exception:
        pass


def _read_pid():
    try:
        return int(open(PID_FILE).read().strip())
    except Exception:
        return None


def _pid_alive(pid):
    # Windows 上 os.kill(pid, 0) 不抛 OSError，用 psutil 或 /proc 都不可靠；
    # 改用 OpenProcess + GetExitCodeProcess（只在 Windows 生效）
    if sys.platform == 'win32':
        try:
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if not handle:
                return False
            code = ctypes.c_ulong(0)
            ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            ctypes.windll.kernel32.CloseHandle(handle)
            return code.value == 259  # STILL_ACTIVE
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _write_pid():
    try:
        os.makedirs(os.path.dirname(PID_FILE), exist_ok=True)
        open(PID_FILE, 'w').write(str(os.getpid()))
    except Exception:
        pass


def _remove_pid():
    try:
        if os.path.exists(PID_FILE) and _read_pid() == os.getpid():
            os.remove(PID_FILE)
    except Exception:
        pass


def _acquire_singleton():
    """已有活跃进程则退出，否则写入自身 pid。返回 True 表示成功占用。"""
    existing = _read_pid()
    if existing and _pid_alive(existing):
        return False  # 已有监控进程在跑
    _write_pid()
    # 二次确认（极低概率并发 spawn 时的防护）
    time.sleep(0.05)
    if _read_pid() != os.getpid():
        return False
    return True


def _active_token():
    """读 ~/.claude/.credentials.json 取当前 active token。每轮都重读，
    避免守护把切换前的旧 token 一直缓存住。"""
    if not os.path.exists(CREDS):
        return None
    try:
        return json.load(open(CREDS, encoding='utf-8'))['claudeAiOauth']['accessToken']
    except Exception:
        return None


def _read_cached_usage(token):
    """直接读 ~/.ccs/usage-shared-cache.json 里 token 的 usage entry，不发请求。

    返回 (five_hour, resets_at, extra, age_s)：
      - (float, str, None, age)      : 缓存里是 200，正常用量数据
      - (None, None, 'no-data', age) : 缓存里是 429 / 5xx / 解析失败等，没有有效 5h 数据
      - (None, None, 'miss', None)   : 缓存里没这个条目（首次启动 / token 刚换）
    age_s 是 entry 距今秒数；'miss' 时为 None。

    v3.10.8：不再区分 429 子类型。业务用尽时状态栏拿到的是 200 + 100%，
    缓存里的 429 一律按"暂未读到有效数据"处理，下一轮 10s 后再看。
    """
    if not token:
        return (None, None, 'miss', None)
    th = hashlib.md5(token.encode()).hexdigest()[:8]
    key = f'{th}:{USAGE_URL}'
    try:
        cache = json.load(open(CACHE_FILE, encoding='utf-8'))
    except Exception:
        return (None, None, 'miss', None)
    entry = cache.get(key)
    if not entry:
        return (None, None, 'miss', None)
    age = time.time() - entry.get('ts', 0)
    if entry.get('code') == 200:
        try:
            body = bytes.fromhex(entry.get('body_hex', '')) if entry.get('body_hex') else b''
            resp = json.loads(body)
            fh = resp.get('five_hour') or {}
            return (float(fh.get('utilization') or 0.0), fh.get('resets_at') or '', None, age)
        except Exception:
            pass
    return (None, None, 'no-data', age)


def _query_active_usage():
    """查 ~/.claude/.credentials.json 里 token 的 5h 用量。
    返回 (five_hour:float, resets_at:str) 或 (None, None)。
    走 anthropic_http 共享 cookie jar，避免 Cloudflare _cfuvid 缺失导致的边缘 429。
    v3.10.8：不再区分 429 子类型——任何非 200 一律视为"这轮没拿到"。"""
    creds = os.path.expanduser('~/.claude/.credentials.json')
    if not os.path.exists(creds):
        return None, None
    try:
        token = json.load(open(creds, encoding='utf-8'))['claudeAiOauth']['accessToken']
    except Exception:
        return None, None
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, script_dir)
        from anthropic_http import request_anthropic
    except Exception:
        return None, None
    # 守护是兜底自查，必然是缓存 stale 时才走到——明确禁用 helper 内的缓存层
    # 避免读到 100s+ 的旧缓存还以为查到了。
    code, body, _headers = request_anthropic(
        'https://api.anthropic.com/api/oauth/usage', token, timeout=8,
        caller='monitor', allow_cache=False)
    if code == 200:
        try:
            resp = json.loads(body)
            fh = resp.get('five_hour') or {}
            return float(fh.get('utilization') or 0.0), fh.get('resets_at') or ''
        except Exception:
            pass
    return None, None


def _do_switch(five_hour, resets_at, force=False, active_got_429=False):
    """调 auto_switch_core 完成切换。
    返回 dict: {switched, next_reset_at, reason}。
    next_reset_at 仅在"全候选用尽"时由核心给出，供守护 sleep 到那时再醒。"""
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, script_dir)
        import auto_switch_core as core
        result = core.decide_and_switch(
            five_hour, resets_at, force_switch=force, active_got_429=active_got_429)
        return {
            'switched': result.get('switched', False),
            'next_reset_at': result.get('next_reset_at'),
            'reason': result.get('reason', ''),
        }
    except Exception as e:
        log(f'switch call failed: {e}')
        return {'switched': False, 'next_reset_at': None, 'reason': f'exception: {e}'}


def _parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except Exception:
        return None


def _statusline_active(window=ACTIVE_WINDOW):
    """状态栏 window 秒内是否刷新过。心跳文件不存在或读不到 mtime 都视为不活跃。"""
    try:
        return (time.time() - os.path.getmtime(HEARTBEAT)) < window
    except OSError:
        return False


def _idle_recheck_loop(reason):
    """用户静默时进入：每 IDLE_RECHECK 秒只看心跳 mtime，不发任何 HTTP 请求。
    心跳恢复活跃 / disabled 标志出现 / 超过 MAX_RUNTIME 才返回。
    返回 True 表示被 disabled 中断，调用方应退出主循环。"""
    log(f'monitor: statusline idle ({reason}), entering idle-recheck (no polling until user returns)')
    while True:
        if os.path.exists(DISABLED):
            return True
        if _statusline_active():
            log('monitor: statusline activity detected, resuming polling')
            return False
        if _sleep_responsive(IDLE_RECHECK):
            return True


def _sleep_responsive(seconds, slice_s=30):
    """切片 sleep：每 slice_s 秒醒一次看 disabled 标志。提前感知关开关。
    返回 True 表示被 disabled 中断，调用方应退出主循环。"""
    end = time.time() + seconds
    while time.time() < end:
        if os.path.exists(DISABLED):
            return True
        time.sleep(min(slice_s, max(0.1, end - time.time())))
    return False


def _sleep_until_reset(reset_iso, safety_s=60):
    """sleep 到 reset_iso + safety_s。返回 True 表示被 disabled 中断。"""
    reset_dt = _parse_iso(reset_iso)
    if not reset_dt:
        return _sleep_responsive(INTERVAL_SLOW)
    now = datetime.now(timezone.utc)
    seconds = (reset_dt - now).total_seconds() + safety_s
    if seconds <= 0:
        return False  # reset 已过，立刻进下一轮
    log(f'monitor: sleeping {int(seconds)}s until {reset_iso} (all candidates exhausted)')
    return _sleep_responsive(seconds)


def main():
    if os.path.exists(DISABLED):
        sys.exit(0)

    if not _acquire_singleton():
        sys.exit(0)  # 已有监控进程

    atexit.register(_remove_pid)
    log(f'monitor started (pid={os.getpid()})')

    start_time = time.time()
    errors = 0
    last_low_log = 0.0   # 上次 "5h<90% idle" 心跳日志的时间戳，每 10min 一条避免刷屏
    last_self_query = 0.0  # 上次守护自己发请求的时间，用于 stale 节流

    while True:
        # 超时保护
        if time.time() - start_time > MAX_RUNTIME:
            log('monitor exit: max runtime reached')
            break

        # 关闭开关检查
        if os.path.exists(DISABLED):
            log('monitor exit: disabled flag found')
            break

        # v3.10.6：用户没在用 Claude Code 时不轮询。
        # 状态栏不刷新 → 用量不会涨 → polling 没意义；空轮询只会累积 cf-429。
        # 启动后 STARTUP_GRACE 内无视门控，避免开机自启时状态栏未起 / 首装未刷新就误停。
        in_grace = (time.time() - start_time) <= STARTUP_GRACE
        if not in_grace and not _statusline_active():
            if _idle_recheck_loop('no recent statusline activity'):
                break
            continue

        # v3.10.7：缓存优先。先看共享缓存，状态栏每次刷新都会写新鲜数据进去。
        # 缓存新鲜（age < CACHE_MAX_AGE）→ 用缓存里的 usage 走决策，不发请求。
        # 缓存 miss/stale → 自己发请求，但同样有 100s 节流避免和状态栏抢着打 CF。
        token = _active_token()
        five_hour, resets_at, extra, age = _read_cached_usage(token)

        # v3.10.8：判定大幅简化——只看 five_hour 百分比，不再区分真 429 / cf-edge 429。
        # 业务用尽时状态栏查 /api/oauth/usage 拿到的是 200 + 100%（多次实测验证），
        # 守护读到 100% 就切，比之前判 429 头部可靠得多。
        # 缓存里如果是 429（任何种类）当作"暂未读到有效数据"，下一轮 10s 后再看。
        cache_fresh = (
            age is not None
            and age < CACHE_MAX_AGE
            and extra is None  # _read_cached_usage：extra=None 表示 200/有效 5h；其他都不是有效数据
            and five_hour is not None
        )
        if not cache_fresh:
            # 缓存里没有有效数据：节流后自己发请求
            now = time.time()
            if now - last_self_query < CACHE_MAX_AGE:
                # 距上次自查不到 100s，再等一拍看状态栏会不会写新值
                if _sleep_responsive(CACHE_TICK):
                    break
                continue
            last_self_query = now
            q_five_hour, q_reset = _query_active_usage()
            if q_five_hour is not None:
                five_hour = q_five_hour
                resets_at = q_reset or ''
            else:
                errors += 1
                log(f'monitor: no usage data this tick ({errors}), waiting for fresh cache')
                if _sleep_responsive(CACHE_TICK):
                    break
                continue

        errors = 0  # 拿到有效数据就重置

        # 用量低于 90%：闲时不动；每 10min 记一条心跳日志确认守护活着
        if five_hour < MONITOR_THRESHOLD:
            now = time.time()
            if now - last_low_log >= 600:
                src = f'cache age={int(age)}s' if cache_fresh else 'self-query'
                log(f'monitor: 5h={five_hour}% (< {MONITOR_THRESHOLD}%, {src})')
                last_low_log = now
            if _sleep_responsive(CACHE_TICK):
                break
            continue

        # 触发切换
        if five_hour >= SWITCH_THRESHOLD:
            src = f'cache age={int(age)}s' if cache_fresh else 'self-query'
            log(f'monitor: 5h={five_hour}% ({src}), triggering switch')
            r = _do_switch(five_hour, resets_at)
            next_reset = r.get('next_reset_at')
            if r['switched'] and next_reset:
                if _sleep_until_reset(next_reset):
                    break
                continue
            if r['switched']:
                if _sleep_responsive(INTERVAL_SLOW):
                    break
                continue
            if next_reset:
                if _sleep_until_reset(next_reset):
                    break
                continue
            log('monitor: switch not completed, retry')
            if _sleep_responsive(INTERVAL_SLOW):
                break
            continue

        # 90-98% 紧密期：10s 一拍盯着，等到 99% 立刻切
        if _sleep_responsive(CACHE_TICK):
            break

    _remove_pid()


if __name__ == '__main__':
    main()
