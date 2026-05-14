"""用量监控守护进程。

由状态栏脚本在 active 5h >= 90% 时 spawn，自带调度循环：
  90 <= 5h < 96  → 60s 轮询
  96 <= 5h < 99  → 10s 轮询
  5h >= 99       → 立即切换，退出
  429            → 当作撞墙，立即切换，退出
  5h < 90        → 用量降下来了（切换成功或自然 reset），退出
  连续错误 >= 5  → 退出
  运行超 2 小时  → 退出（防意外泄漏）

单例保护：~/.ccs/usage-monitor.pid
"""
import json, os, sys, time, atexit
import urllib.request, urllib.error

PID_FILE  = os.path.expanduser('~/.ccs/usage-monitor.pid')
LOG       = os.path.expanduser('~/.ccs/auto-switch.log')
DISABLED  = os.path.expanduser('~/.ccs/usage-monitor.disabled')

MONITOR_THRESHOLD  = 90   # 低于此值退出
FAST_THRESHOLD     = 96   # 高于此值进入 10s 模式
SWITCH_THRESHOLD   = 99   # 高于此值触发切换
INTERVAL_SLOW      = 60
INTERVAL_FAST      = 10
MAX_ERRORS         = 5
MAX_RUNTIME        = 7200  # 2 小时


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
    返回 (five_hour:float, resets_at:str) 或 (None, http_code:int) 或 (None, None)。"""
    creds = os.path.expanduser('~/.claude/.credentials.json')
    if not os.path.exists(creds):
        return None, None
    try:
        token = json.load(open(creds, encoding='utf-8'))['claudeAiOauth']['accessToken']
    except Exception:
        return None, None
    try:
        req = urllib.request.Request(
            'https://api.anthropic.com/api/oauth/usage',
            headers={'Authorization': f'Bearer {token}',
                     'anthropic-beta': 'oauth-2025-04-20',
                     'Accept': 'application/json'})
        resp = json.loads(urllib.request.urlopen(req, timeout=8).read())
        fh = resp.get('five_hour') or {}
        return float(fh.get('utilization') or 0.0), fh.get('resets_at') or ''
    except urllib.error.HTTPError as e:
        return None, e.code
    except Exception:
        return None, None


def _do_switch(five_hour, resets_at, force=False):
    """调 auto_switch_core 完成切换。返回 True 表示切换成功。"""
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, script_dir)
        import auto_switch_core as core
        result = core.decide_and_switch(five_hour, resets_at, force_switch=force)
        return result.get('switched', False)
    except Exception as e:
        log(f'switch call failed: {e}')
        return False


def main():
    if os.path.exists(DISABLED):
        sys.exit(0)

    if not _acquire_singleton():
        sys.exit(0)  # 已有监控进程

    atexit.register(_remove_pid)
    log(f'monitor started (pid={os.getpid()})')

    start_time = time.time()
    errors = 0

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

        # 429 → 当作撞墙，直接切
        if five_hour is None and extra == 429:
            log('monitor: 429 received, treating as wall hit, switching')
            _do_switch(None, '', force=True)
            break

        # 其他查询失败
        if five_hour is None:
            errors += 1
            log(f'monitor: query failed ({errors}/{MAX_ERRORS})')
            if errors >= MAX_ERRORS:
                log('monitor exit: too many errors')
                break
            time.sleep(INTERVAL_SLOW)
            continue

        errors = 0  # 查到数据就重置计数

        # 用量降到 90% 以下（切换成功 / 自然 reset） → 退出
        if five_hour < MONITOR_THRESHOLD:
            log(f'monitor exit: 5h={five_hour}% < {MONITOR_THRESHOLD}%, no longer needed')
            break

        # 触发切换
        if five_hour >= SWITCH_THRESHOLD:
            log(f'monitor: 5h={five_hour}%, triggering switch')
            switched = _do_switch(five_hour, extra)
            if switched:
                break  # 切换成功，守护退出
            # 切换失败（全满 / 异常），60s 后重试
            log('monitor: switch not completed, retry in 60s')
            time.sleep(INTERVAL_SLOW)
            continue

        # 90-99% 之间，按频率轮询
        interval = INTERVAL_FAST if five_hour >= FAST_THRESHOLD else INTERVAL_SLOW
        log(f'monitor: 5h={five_hour}%, next check in {interval}s')
        time.sleep(interval)

    _remove_pid()


if __name__ == '__main__':
    main()
