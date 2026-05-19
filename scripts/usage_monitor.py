"""用量监控守护进程。

调度循环：
  5h < 99        → 100s 轮询（与共享缓存 TTL 对齐，实测更密会触发 cf-429）
  5h >= 99       → 切换（成功也不退出，继续盯新 active）
  真 429         → 当作 active 用尽，写表 + 切换
  cf-429 / 错误  → 100s 重试
  全候选用尽     → sleep 到最早 reset + 60s 再醒
  disabled 文件  → 退出
  运行超 7 天    → 退出（兜底）

单例保护：~/.ccs/usage-monitor.pid
"""
import json, os, sys, time, atexit
import urllib.request, urllib.error
from datetime import datetime, timezone

PID_FILE  = os.path.expanduser('~/.ccs/usage-monitor.pid')
LOG       = os.path.expanduser('~/.ccs/auto-switch.log')
DISABLED  = os.path.expanduser('~/.ccs/usage-monitor.disabled')

MONITOR_THRESHOLD  = 90   # 用量分档阈值（保留，未来想分档时改 INTERVAL_SLOW 即可）
SWITCH_THRESHOLD   = 99   # 高于此值触发切换
INTERVAL_IDLE      = 100  # 5h < 90% 闲时轮询间隔
INTERVAL_SLOW      = 100  # 90-98% 紧密期、错误重试、切换失败重试（v3.10.4 起统一 100s）
# v3.10.4 起两档都 100s：与共享缓存 TTL 对齐；实测 30s 会触发 Cloudflare 边缘 429
MAX_ERRORS         = 5
MAX_RUNTIME        = 86400 * 7  # 7 天（实质无限，disabled 文件才是真正的停止信号）


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


def _query_active_usage():
    """查 ~/.claude/.credentials.json 里 token 的 5h 用量。
    返回 (five_hour:float, resets_at:str) 或 (None, http_code:int) 或 (None, None)。
    走 anthropic_http 共享 cookie jar，避免 Cloudflare _cfuvid 缺失导致的边缘 429。"""
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
        from anthropic_http import request_anthropic, is_real_anthropic_429
    except Exception:
        return None, None
    code, body, headers = request_anthropic(
        'https://api.anthropic.com/api/oauth/usage', token, timeout=8, caller='monitor')
    if code == 200:
        try:
            resp = json.loads(body)
            fh = resp.get('five_hour') or {}
            return float(fh.get('utilization') or 0.0), fh.get('resets_at') or ''
        except Exception:
            return None, None
    if code == 429:
        # 区分真 429（Anthropic 后端，含用尽）vs Cloudflare 边缘 429
        # helper 已写日志，这里不再重复
        if is_real_anthropic_429(headers):
            return None, 429
        return None, None  # cf-edge 429 当临时错误，主循环 60s 重试
    return None, code


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
    low_ticks = 0  # 5h < 90% 的连续轮次计数，用于稀疏心跳日志

    while True:
        # 超时保护
        if time.time() - start_time > MAX_RUNTIME:
            log('monitor exit: max runtime reached')
            break

        # 关闭开关检查
        if os.path.exists(DISABLED):
            log('monitor exit: disabled flag found')
            break

        five_hour, extra = _query_active_usage()

        # 429 → active 用尽（v3.10.2+ 业务约定）：写表标用尽 + 进切换决策
        if five_hour is None and extra == 429:
            log('monitor: 429 received, marking active exhausted, attempting switch')
            r = _do_switch(None, '', force=True, active_got_429=True)
            next_reset = r.get('next_reset_at')
            if r['switched'] and next_reset:
                # 已切到"最早能 reset 的号"，sleep 到它恢复
                if _sleep_until_reset(next_reset):
                    break
                continue
            if r['switched']:
                # 切到了正常号，下一轮立刻盯它
                if _sleep_responsive(INTERVAL_SLOW):
                    break
                continue
            if next_reset:
                # 没切（active 自己就是最早恢复的），原地 sleep
                if _sleep_until_reset(next_reset):
                    break
                continue
            # active 没历史 reset 或候选全 unknown：保守 60s 重试
            if _sleep_responsive(INTERVAL_SLOW):
                break
            continue

        # 其他查询失败：固定 60s 重试，不退出（网络抖动应自愈）。
        # v3.10.1 前用指数退避 60/120/240/300s，开机自启场景下要 11 分钟才恢复，
        # 期间用量监控完全失明，不值得；统一 60s 即可。
        if five_hour is None:
            errors += 1
            log(f'monitor: query failed ({errors}), retry in {INTERVAL_SLOW}s')
            if _sleep_responsive(INTERVAL_SLOW):
                break
            continue

        errors = 0  # 查到数据就重置计数

        # 用量低于 90%：从状态栏 spawn 时会预判，但从 Web UI spawn 时无条件启动，
        # 所以这里不退出，安静等待 60s 继续轮询（disabled / 超时 才是退出条件）。
        # 每 10 轮（约 10 分钟）记一条心跳日志，确认守护活着；其他轮静默不刷屏。
        if five_hour < MONITOR_THRESHOLD:
            low_ticks += 1
            if low_ticks == 1 or low_ticks % 10 == 0:
                log(f'monitor: 5h={five_hour}% (< {MONITOR_THRESHOLD}%), idle polling every {INTERVAL_IDLE}s')
            if _sleep_responsive(INTERVAL_IDLE):
                break
            continue
        low_ticks = 0  # ≥ 90% 时重置心跳计数

        # 触发切换
        if five_hour >= SWITCH_THRESHOLD:
            log(f'monitor: 5h={five_hour}%, triggering switch')
            r = _do_switch(five_hour, extra)
            next_reset = r.get('next_reset_at')
            if r['switched'] and next_reset:
                # 切到的是"最早能 reset 的用尽号"，sleep 到它恢复
                if _sleep_until_reset(next_reset):
                    break
                continue
            if r['switched']:
                # 切到正常号，继续盯（不退出守护：旧行为 break 后靠 watchdog 拉，乒乓时会失控）
                if _sleep_responsive(INTERVAL_SLOW):
                    break
                continue
            if next_reset:
                # active 自己是最早 reset 的，原地 sleep
                if _sleep_until_reset(next_reset):
                    break
                continue
            log('monitor: switch not completed, retry in 60s')
            if _sleep_responsive(INTERVAL_SLOW):
                break
            continue

        # 90-98% 之间，紧密轮询（60s）；99%+ 已在上面切换分支处理
        log(f'monitor: 5h={five_hour}%, next check in {INTERVAL_SLOW}s')
        if _sleep_responsive(INTERVAL_SLOW):
            break

    _remove_pid()


if __name__ == '__main__':
    main()
