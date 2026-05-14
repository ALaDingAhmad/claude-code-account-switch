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
    返回 (five_hour:float, resets_at:str) 或 None"""
    try:
        req = urllib.request.Request(
            'https://api.anthropic.com/api/oauth/usage',
            headers={'Authorization': f'Bearer {token}',
                     'anthropic-beta': 'oauth-2025-04-20',
                     'Accept': 'application/json'})
        resp = json.loads(urllib.request.urlopen(req, timeout=5).read())
        fh = resp.get('five_hour') or {}
        return float(fh.get('utilization') or 0.0), (fh.get('resets_at') or '')
    except urllib.error.HTTPError as e:
        log(f'API HTTP {e.code} on usage query')
        return None
    except Exception as e:
        log(f'API error on usage query: {e}')
        return None


def query_active_usage():
    """查 ~/.claude/.credentials.json 里那个 token（即当前 Claude Code 进程在用的）
    的 5h 用量。返回 (five_hour:float, resets_at:str, http_code:int|None) 或 None。
    http_code 用于让调用方区分 429（撞墙）和其他错误。"""
    creds_path = os.path.expanduser('~/.claude/.credentials.json')
    if not os.path.exists(creds_path):
        return None
    try:
        token = json.load(open(creds_path, encoding='utf-8'))['claudeAiOauth']['accessToken']
    except Exception:
        return None
    try:
        req = urllib.request.Request(
            'https://api.anthropic.com/api/oauth/usage',
            headers={'Authorization': f'Bearer {token}',
                     'anthropic-beta': 'oauth-2025-04-20',
                     'Accept': 'application/json'})
        resp = json.loads(urllib.request.urlopen(req, timeout=5).read())
        fh = resp.get('five_hour') or {}
        return (float(fh.get('utilization') or 0.0), fh.get('resets_at') or '', None)
    except urllib.error.HTTPError as e:
        return (None, None, e.code)
    except Exception:
        return (None, None, None)


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


def decide_and_switch(cur_5h_val, cur_reset, force_switch=False):
    """切换决策主入口。
    - cur_5h_val: active 当前 5h 用量百分比（float）；None 时只在 force_switch=True 才有意义
    - cur_reset: active 当前 5h 的 resets_at ISO 字符串
    - force_switch: True 跳过 5h<99 预判，直接进入候选评估（429 撞墙场景）
    返回 dict: {'switched': bool, 'target': str|None, 'reason': str}
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

    evaluated = []  # [(name, status, value)]
    for name, _acct in candidates:
        info = table.get(name)
        reset_dt = parse_iso(info.get('resets_at')) if info else None
        fresh = info and reset_dt and reset_dt > now
        if not fresh:
            tok = read_account_token(name)
            if not tok:
                log(f'{name}: no token snapshot, mark unknown')
                evaluated.append((name, 'unknown', None))
                continue
            q = query_usage_for_token(tok)
            if q is None:
                log(f'{name}: usage query failed, mark unknown')
                evaluated.append((name, 'unknown', None))
                continue
            five_hour, resets_at = q
            table[name] = {
                'five_hour': five_hour,
                'resets_at': resets_at,
                'checked_at': now_iso,
            }
            info = table[name]
            save_usage(table)
        evaluated.append((name, 'known', info['five_hour']))

    # 第一轮：known<99 优先
    target = None
    optimistic = False
    for name, status, val in evaluated:
        if status == 'known' and val < THRESHOLD:
            target = name
            break

    # 第二轮：没有 known<99 就乐观切首个 unknown
    if not target:
        for name, status, _val in evaluated:
            if status == 'unknown':
                target = name
                optimistic = True
                break

    if not target:
        log(f'5h={cur_5h_val}%, all candidates also full (no switch)')
        return {'switched': False, 'target': None, 'reason': 'all candidates full'}

    # 真切换
    tag = f'force-switch from {cur} to {target}' if force_switch else \
          (f'optimistic switch from {cur} to {target} (usage unknown)' if optimistic else
           f'switching from {cur} to {target} (5h={table[target]["five_hour"]}%)')
    log(f'5h={cur_5h_val}% (resets {cur_reset}), {tag}')
    try:
        ccs_bin = shutil.which('ccs') or 'ccs'
        r = subprocess.run([ccs_bin, target], capture_output=True, text=True, timeout=15)
        if r.returncode == 0:
            log(f'switched to {target} OK')
            write_last_switch(cur, target)
            return {'switched': True, 'target': target, 'reason': 'ok'}
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
