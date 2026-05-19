"""自动切账号核心逻辑。可作为模块 import，也可作为 CLI 直接跑。

CLI 用法（兼容旧版状态栏脚本的调用）：
    python3 auto-switch-core.py <cur_5h_val> <cur_reset_iso>

模块用法：
    from auto_switch_core import decide_and_switch
    decide_and_switch(cur_5h_val=99.5, cur_reset='2026-...', force_switch=False)

force_switch=True 时跳过 5h<99 的预判，直接进入候选评估和切换流程
（守护进程在 429 撞墙时用这个模式）。
"""
import json, os, sys, shutil, subprocess, time, urllib.request, urllib.error
from datetime import datetime, timezone

CFG     = os.path.expanduser('~/.ccs/config.json')
USAGE   = os.path.expanduser('~/.ccs/account-usage.json')
LOG     = os.path.expanduser('~/.ccs/auto-switch.log')
ACC_DIR = os.path.expanduser('~/.ccs/accounts')
LAST_SWITCH = os.path.expanduser('~/.ccs/last-switch.json')

THRESHOLD = 99  # 5h 达到 99% 才触发切换


def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(f"[{datetime.now().strftime('%F %T')}] {msg}\n")
    except Exception:
        pass


def parse_iso(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00'))
    except Exception:
        return None


def save_usage(table):
    try:
        os.makedirs(os.path.dirname(USAGE), exist_ok=True)
        json.dump(table, open(USAGE, 'w', encoding='utf-8'), indent=2)
    except Exception as e:
        log(f'write usage table failed: {e}')


def load_usage():
    if not os.path.exists(USAGE):
        return {}
    try:
        return json.load(open(USAGE, encoding='utf-8')) or {}
    except Exception:
        return {}


def read_account_token(name):
    """从 ccs 快照读账号 OAuth access token（mac 也是这个文件，不是 Keychain）"""
    p = os.path.join(ACC_DIR, f'{name}.credentials.json')
    if not os.path.exists(p):
        return None
    try:
        return json.load(open(p, encoding='utf-8'))['claudeAiOauth']['accessToken']
    except Exception:
        return None


def query_usage_for_token(token):
    """调 /api/oauth/usage 查一个 token 的当前用量。
    返回:
      ('ok', five_hour:float, resets_at:str)  - 200 OK
      ('exhausted', None, None)               - 真 429（响应头带 anthropic-organization-id，后端确认用尽）
      ('error', None, None)                   - 其他错误（网络、5xx、Cloudflare 边缘 429、token 无效等）
    Cloudflare 边缘 429 不算用尽，归到 'error'，避免被乒乓 bug 误伤为"该号已用尽"。
    """
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, script_dir)
        from anthropic_http import request_anthropic, is_real_anthropic_429
    except Exception as e:
        log(f'anthropic_http import failed: {e}')
        return ('error', None, None)
    # helper 自己写日志 + 共享缓存（100s 内重复查同 token 直接返缓存）
    code, body, headers = request_anthropic(
        'https://api.anthropic.com/api/oauth/usage', token, timeout=5, caller='switch-core')
    if code == 200:
        try:
            resp = json.loads(body)
            fh = resp.get('five_hour') or {}
            return ('ok', float(fh.get('utilization') or 0.0), (fh.get('resets_at') or ''))
        except Exception as e:
            log(f'parse usage response failed: {e}')
            return ('error', None, None)
    if code == 429:
        if is_real_anthropic_429(headers):
            return ('exhausted', None, None)
        return ('error', None, None)
    return ('error', None, None)


def query_active_usage():
    """查 ~/.claude/.credentials.json 里那个 token（即当前 Claude Code 进程在用的）
    的 5h 用量。返回 (five_hour:float, resets_at:str, http_code:int|None) 或 None。
    http_code 用于让调用方区分 429（撞墙）和其他错误；Cloudflare 边缘 429 映射为 None
    （视为临时错误，调用方按"非用尽"处理）。"""
    creds_path = os.path.expanduser('~/.claude/.credentials.json')
    if not os.path.exists(creds_path):
        return None
    try:
        token = json.load(open(creds_path, encoding='utf-8'))['claudeAiOauth']['accessToken']
    except Exception:
        return None
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, script_dir)
        from anthropic_http import request_anthropic, is_real_anthropic_429
    except Exception:
        return None
    code, body, headers = request_anthropic(
        'https://api.anthropic.com/api/oauth/usage', token, timeout=5, caller='switch-core')
    if code == 200:
        try:
            resp = json.loads(body)
            fh = resp.get('five_hour') or {}
            return (float(fh.get('utilization') or 0.0), fh.get('resets_at') or '', None)
        except Exception:
            return None
    if code == 429:
        return (None, None, 429) if is_real_anthropic_429(headers) else (None, None, None)
    return (None, None, code)


def write_last_switch(cur, target):
    try:
        json.dump({'from': cur, 'to': target, 'ts': time.time()},
                  open(LAST_SWITCH, 'w', encoding='utf-8'))
    except Exception:
        pass


def update_active_usage(cur, cur_5h_val, cur_reset):
    """更新用量表里 active 的条目；状态栏 tick 每次都调用。"""
    if not (cur and cur_5h_val is not None):
        return
    table = load_usage()
    table[cur] = {
        'five_hour': cur_5h_val,
        'resets_at': cur_reset,
        'checked_at': datetime.now(timezone.utc).isoformat(),
    }
    save_usage(table)


def mark_exhausted(name, table=None):
    """把账号写成"已用尽"（5h=100）。reset 时间沿用表里旧的 future 值；
    若没有旧 future reset，不写 100% 也不写 reset，调用方按 'unknown' 处理。
    返回新的 (table, written:bool) ；written=False 表示没有可信 reset、未写表。"""
    if table is None:
        table = load_usage()
    info = table.get(name) or {}
    old_reset = parse_iso(info.get('resets_at'))
    now = datetime.now(timezone.utc)
    if not (old_reset and old_reset > now):
        return table, False  # 没历史 reset，调用方按 unknown/error 处理
    table[name] = {
        'five_hour': 100.0,
        'resets_at': info['resets_at'],
        'checked_at': now.isoformat(),
        'exhausted_by_429': True,
    }
    save_usage(table)
    return table, True


def decide_and_switch(cur_5h_val, cur_reset, force_switch=False, active_got_429=False):
    """切换决策主入口。
    - cur_5h_val: active 当前 5h 用量百分比（float）；None 时只在 force_switch=True 才有意义
    - cur_reset: active 当前 5h 的 resets_at ISO 字符串
    - force_switch: True 跳过 5h<99 预判，直接进入候选评估（429 撞墙场景）
    - active_got_429: True 表示 active 撞 429 → 把 active 也写表标用尽（用旧 reset）

    返回 dict:
      {'switched': bool, 'target': str|None, 'reason': str,
       'next_reset_at': str|None  # 全用尽时给出最早 reset 的 ISO，供守护 sleep 到那时再醒
      }
    """
    # 读 config
    try:
        cfg = json.load(open(CFG, encoding='utf-8'))
    except Exception as e:
        log(f'read config failed: {e}')
        return {'switched': False, 'target': None, 'reason': 'config error'}

    cur = cfg.get('activeAccount')
    accounts = cfg.get('accounts') or {}
    table = load_usage()
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat()

    # active 撞 429：写表标用尽（沿用旧 future reset；没有就不强写）
    if active_got_429 and cur:
        table, written = mark_exhausted(cur, table)
        if written:
            log(f'{cur}: active 429, marked exhausted with old reset')
        else:
            log(f'{cur}: active 429 but no historical reset to reuse, not marking')
            # 没法标记，端点行为未知，保守不切；让守护进入普通 60s 重试
            return {'switched': False, 'target': None, 'reason': 'active 429 no history'}

    # 触发判定
    if not force_switch:
        if cur_5h_val is None or cur_5h_val < THRESHOLD:
            return {'switched': False, 'target': None, 'reason': 'below threshold'}

    # 评估候选
    candidates = [(n, a) for n, a in accounts.items()
                  if n != cur and (a.get('type') or 'oauth') == 'oauth']
    if not candidates:
        log(f'5h={cur_5h_val}%, no OAuth candidates to switch to')
        return {'switched': False, 'target': None, 'reason': 'no candidates'}

    evaluated = []  # [(name, status, value, reset_iso)]; status: known|exhausted|unknown
    for name, _acct in candidates:
        info = table.get(name)
        reset_dt = parse_iso(info.get('resets_at')) if info else None
        fresh = info and reset_dt and reset_dt > now
        if fresh:
            # reset 还在未来：信缓存，不查（避免触发端点限速；100% 的也不查，免得续 ban）
            evaluated.append((name, 'known', info['five_hour'], info.get('resets_at') or ''))
            continue

        tok = read_account_token(name)
        if not tok:
            log(f'{name}: no token snapshot, mark unknown')
            evaluated.append((name, 'unknown', None, ''))
            continue
        kind, five_hour, resets_at = query_usage_for_token(tok)
        if kind == 'ok':
            table[name] = {
                'five_hour': five_hour,
                'resets_at': resets_at,
                'checked_at': now_iso,
            }
            save_usage(table)
            evaluated.append((name, 'known', five_hour, resets_at))
        elif kind == 'exhausted':
            # 429：按业务约定=用尽。沿用旧 future reset；没有就只能 unknown
            table, written = mark_exhausted(name, table)
            if written:
                log(f'{name}: candidate 429, marked exhausted with old reset')
                evaluated.append((name, 'exhausted', 100.0, table[name]['resets_at']))
            else:
                log(f'{name}: candidate 429 but no historical reset, mark unknown')
                evaluated.append((name, 'unknown', None, ''))
        else:
            log(f'{name}: usage query failed, mark unknown')
            evaluated.append((name, 'unknown', None, ''))

    # 选目标：只切 known<99（删除乐观切 unknown 分支——按用户规则，切到用尽号代价大于等一会）
    target = None
    target_next_reset = None  # 若是"全用尽时切到最早 reset 号"分支，记下它的 reset 时间
    for name, status, val, _r in evaluated:
        if status == 'known' and val is not None and val < THRESHOLD:
            target = name
            break

    if not target:
        # 全用尽：挑"最早能 reset 的号"切过去 + 返回它的 reset 时间，让守护 sleep 到那时再醒。
        # 候选池里 status in (known≥99, exhausted) 的都参与；含 active 自己（看 active 是不是最早恢复的）。
        all_full = []  # [(reset_dt, name, reset_iso)]
        for n, status, val, r in evaluated:
            if status in ('known', 'exhausted') and val is not None and val >= THRESHOLD:
                rd = parse_iso(r)
                if rd and rd > now:
                    all_full.append((rd, n, r))
        # active 自己也要算（让 sleep 时间合理）
        active_info = table.get(cur) or {}
        active_reset = parse_iso(active_info.get('resets_at'))
        if active_reset and active_reset > now:
            all_full.append((active_reset, cur, active_info.get('resets_at') or ''))

        if not all_full:
            log(f'5h={cur_5h_val}%, no switchable candidates (unknown)')
            return {'switched': False, 'target': None, 'reason': 'no switchable'}

        earliest = min(all_full, key=lambda x: x[0])
        earliest_name, earliest_reset = earliest[1], earliest[2]
        # 若最早恢复的就是 active 自己，原地 sleep；否则切过去再 sleep
        if earliest_name == cur:
            log(f'5h={cur_5h_val}%, all exhausted, active {cur} is the earliest to reset at {earliest_reset}')
            return {'switched': False, 'target': None,
                    'reason': 'active is earliest', 'next_reset_at': earliest_reset}
        target = earliest_name
        target_next_reset = earliest_reset
        log(f'5h={cur_5h_val}%, all exhausted; pre-switch to earliest-reset candidate {target} (reset {earliest_reset})')

    # 真切换
    tag = (f'force-switch from {cur} to {target}' if force_switch
           else f'switching from {cur} to {target} (5h={table[target]["five_hour"]}%)')
    log(f'5h={cur_5h_val}% (resets {cur_reset}), {tag}')
    try:
        ccs_bin = shutil.which('ccs') or 'ccs'
        r = subprocess.run([ccs_bin, target], capture_output=True, text=True, timeout=15)
        if r.returncode == 0:
            log(f'switched to {target} OK')
            write_last_switch(cur, target)
            return {'switched': True, 'target': target, 'reason': 'ok',
                    'next_reset_at': target_next_reset}
        else:
            err = (r.stderr or r.stdout or '').strip()[:200]
            log(f'switch failed rc={r.returncode}: {err}')
            return {'switched': False, 'target': target, 'reason': f'rc={r.returncode}'}
    except Exception as e:
        log(f'switch exception: {e} (ccs_bin={shutil.which("ccs")!r})')
        return {'switched': False, 'target': target, 'reason': f'exception: {e}'}


def main_cli():
    """状态栏脚本的 CLI 入口：每次 tick 更新 active 用量 + 触发决策"""
    cur_5h_str = sys.argv[1] if len(sys.argv) > 1 else ''
    cur_reset = sys.argv[2] if len(sys.argv) > 2 else ''

    try:
        cur_5h_val = float(cur_5h_str) if cur_5h_str else None
    except Exception:
        cur_5h_val = None

    # 读 config 拿 active 名字
    try:
        cfg = json.load(open(CFG, encoding='utf-8'))
        cur = cfg.get('activeAccount')
    except Exception as e:
        log(f'read config failed: {e}')
        return

    update_active_usage(cur, cur_5h_val, cur_reset)
    decide_and_switch(cur_5h_val, cur_reset, force_switch=False)


if __name__ == '__main__':
    main_cli()
