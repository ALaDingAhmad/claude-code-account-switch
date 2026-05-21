"""用量监控守护进程。

行为规则定义在 doc/守护进程行为规则.md（讨论改动前必读，不要凭代码反推规则）。

调度循环（v3.11.2 起，按规则重写）：
  每轮：
    检查 disabled / 超时 → 退出
    用户离开（心跳 stale ≥ ACTIVE_WINDOW）：
      不发任何 API，sleep IDLE_TICK（5s）再检查心跳
    用户活跃：
      读共享缓存里 active token 的 200 entry：
        有 < CACHE_MAX_AGE 的新鲜数据 → 走决策
        没有 → 自己发请求 → 走决策（仅这种场景才发请求）
      决策：
        5h ≥ SWITCH_THRESHOLD → 调切换
        5h < SWITCH_THRESHOLD → sleep CACHE_TICK（10s）继续盯
        拿不到数据 → sleep CACHE_TICK 重试
  全候选用尽：sleep 到最早 reset + 60s（唯一允许的长睡）

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

SWITCH_THRESHOLD = 99           # 5h ≥ 触发切换
MAX_RUNTIME      = 86400 * 7    # 7 天（实质无限，disabled 文件才是真正的停止信号）

# 行为参数（修改前同步更新 doc/守护进程行为规则.md）
ACTIVE_WINDOW = 300   # 状态栏心跳 ≤ 这个秒数视为用户活跃（5 分钟）
IDLE_TICK     = 5     # 用户离开时检查心跳的循环间隔——必须短才能快速感知用户回来
CACHE_TICK    = 10    # 用户活跃时主循环节奏
CACHE_MAX_AGE = 100   # 共享缓存里 200 数据的新鲜阈值（与 anthropic_http.CACHE_TTL 对齐）


def log(msg):
    try:
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
    # Windows 上 os.kill(pid, 0) 不抛 OSError，用 OpenProcess + GetExitCodeProcess
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
        return False
    _write_pid()
    time.sleep(0.05)
    if _read_pid() != os.getpid():
        return False
    return True


def _statusline_active(window=ACTIVE_WINDOW):
    """状态栏 window 秒内是否刷新过。心跳文件不存在或读不到 mtime 都视为不活跃。"""
    try:
        return (time.time() - os.path.getmtime(HEARTBEAT)) < window
    except OSError:
        return False


def _active_token():
    """读 ~/.claude/.credentials.json 取当前 active token。每轮都重读避免缓存旧 token。"""
    if not os.path.exists(CREDS):
        return None
    try:
        return json.load(open(CREDS, encoding='utf-8'))['claudeAiOauth']['accessToken']
    except Exception:
        return None


def _read_cached_usage(token):
    """直接读 ~/.ccs/usage-shared-cache.json 里 token 的 usage entry，不发请求。

    返回 (five_hour, resets_at, age_s, ok)：
      - (float, str, age, True)  : 缓存里是 200，数据有效
      - (None,  None, _, False)  : 没有有效数据（miss / 429 / 解析失败等）
    """
    if not token:
        return (None, None, None, False)
    th = hashlib.md5(token.encode()).hexdigest()[:8]
    key = f'{th}:{USAGE_URL}'
    try:
        cache = json.load(open(CACHE_FILE, encoding='utf-8'))
    except Exception:
        return (None, None, None, False)
    entry = cache.get(key)
    if not entry:
        return (None, None, None, False)
    age = time.time() - entry.get('ts', 0)
    if entry.get('code') == 200:
        try:
            body = bytes.fromhex(entry.get('body_hex', '')) if entry.get('body_hex') else b''
            resp = json.loads(body)
            fh = resp.get('five_hour') or {}
            return (float(fh.get('utilization') or 0.0), fh.get('resets_at') or '', age, True)
        except Exception:
            pass
    return (None, None, age, False)


def _query_active_usage():
    """守护自己发一次 /api/oauth/usage 请求。返回 (five_hour:float, resets_at:str) 或 (None, None)。
    任何非 200 视为"这轮没拿到"。"""
    token = _active_token()
    if not token:
        return None, None
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, script_dir)
        from anthropic_http import request_anthropic
    except Exception:
        return None, None
    # 必然是缓存 stale 时才走到——明确禁用 helper 内的缓存层避免读到旧数据
    code, body, _headers = request_anthropic(
        USAGE_URL, token, timeout=8, caller='monitor', allow_cache=False)
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


def _sleep_responsive(seconds, slice_s=5):
    """切片 sleep：每 slice_s 秒醒一次看 disabled 标志，提前感知关开关。
    返回 True 表示被 disabled 中断，调用方应退出主循环。"""
    end = time.time() + seconds
    while time.time() < end:
        if os.path.exists(DISABLED):
            return True
        time.sleep(min(slice_s, max(0.1, end - time.time())))
    return False


def _sleep_until_reset(reset_iso, safety_s=60):
    """sleep 到 reset_iso + safety_s。这是守护唯一允许的"长睡"——
    全候选用尽时等到最早 reset 时间再醒。返回 True 表示被 disabled 中断。"""
    reset_dt = _parse_iso(reset_iso)
    if not reset_dt:
        return _sleep_responsive(CACHE_TICK)
    now = datetime.now(timezone.utc)
    seconds = (reset_dt - now).total_seconds() + safety_s
    if seconds <= 0:
        return False  # reset 已过，立刻进下一轮
    log(f'monitor: sleeping {int(seconds)}s until {reset_iso} (all candidates exhausted)')
    return _sleep_responsive(seconds)


def _decide_and_act(five_hour, resets_at, src):
    """拿到 5h 数据后做决策。返回:
      ('switch_done_long_sleep', reset_iso) : 切到的是最早 reset 号，应 sleep 到那时
      ('switch_done', None)                 : 切到正常号或没切，下一轮短睡继续盯
      ('continue', None)                    : 5h<99，下一轮继续
      ('break', None)                       : disabled，调用方应退出

    写表 active 数据：不在这里写。account-usage.json 是"切换流水账"——
    由 store.switchAccount 在切换执行前用 JS 写。守护职责是看数读决策，不管写表。
    """
    if five_hour < SWITCH_THRESHOLD:
        return ('continue', None)

    log(f'monitor: 5h={five_hour}% ({src}), triggering switch')
    r = _do_switch(five_hour, resets_at)
    next_reset = r.get('next_reset_at')
    if r['switched'] and next_reset:
        return ('switch_done_long_sleep', next_reset)
    if next_reset and not r['switched']:
        # active 自己是最早 reset 的
        return ('switch_done_long_sleep', next_reset)
    if not r['switched']:
        log(f'monitor: switch not completed ({r.get("reason")}), will retry')
    return ('switch_done', None)


def main():
    if os.path.exists(DISABLED):
        sys.exit(0)
    if not _acquire_singleton():
        sys.exit(0)

    atexit.register(_remove_pid)
    log(f'monitor started (pid={os.getpid()})')

    start_time = time.time()
    last_idle_log = 0.0

    while True:
        # 超时保护 / 关闭开关
        if time.time() - start_time > MAX_RUNTIME:
            log('monitor exit: max runtime reached')
            break
        if os.path.exists(DISABLED):
            log('monitor exit: disabled flag found')
            break

        # —— 用户离开：不发任何 API，短睡感知用户回来 ——
        if not _statusline_active():
            now = time.time()
            if now - last_idle_log >= 600:  # 10min 一条心跳日志确认守护活着
                log(f'monitor: user idle, no polling (next heartbeat check in {IDLE_TICK}s)')
                last_idle_log = now
            if _sleep_responsive(IDLE_TICK):
                break
            continue

        last_idle_log = 0.0  # 用户回来重置心跳日志计时

        # —— 用户活跃：优先读缓存 ——
        token = _active_token()
        fh, reset, age, ok = _read_cached_usage(token)
        cache_fresh = ok and age is not None and age < CACHE_MAX_AGE

        if cache_fresh:
            src = f'cache age={int(age)}s'
        else:
            # 缓存不新鲜或没数据 → 守护自己发一次
            fh, reset = _query_active_usage()
            if fh is None:
                # 拿不到（cf-429 / 网络抖动 / token 失效），10s 后再看
                log('monitor: no usage data this tick, retry in CACHE_TICK')
                if _sleep_responsive(CACHE_TICK):
                    break
                continue
            src = 'self-query'

        # —— 决策 ——
        action, payload = _decide_and_act(fh, reset, src)
        if action == 'break':
            break
        if action == 'switch_done_long_sleep':
            if _sleep_until_reset(payload):
                break
            continue
        # continue / switch_done 都是短睡继续盯
        if _sleep_responsive(CACHE_TICK):
            break

    _remove_pid()


if __name__ == '__main__':
    main()
