#!/usr/bin/env bash
# Claude Code 状态栏脚本

# 安装时由 ccs statusline install 替换为真实版本号；源码里保持占位
CCS_VERSION="__CCS_VERSION__"

input=$(cat)

parse() {
  python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
try:
    parts = '$1'.split('.')
    v = data
    for p in parts:
        v = v[p]
    print(v if v is not None else '')
except:
    print('')
" <<< "$input" 2>/dev/null
}

cwd=$(parse "workspace.current_dir")
[ -z "$cwd" ] && cwd=$(parse "cwd")
model=$(parse "model.display_name")
used_pct=$(parse "context_window.used_percentage")
cost=$(parse "cost.total_cost_usd")
rate5h=$(parse "rate_limits.five_hour.used_percentage")
rate7d=$(parse "rate_limits.seven_day.used_percentage")

# 动态 home 目录，兼容 Windows Git Bash / Mac / Linux
CLAUDE_DIR="$HOME/.claude"
CREDS_PATH="$CLAUDE_DIR/.credentials.json"

# 从 /api/oauth/usage 实时查用量（带缓存，TTL 60s）
usage_info=$(python3 -c "
import json, os, sys, time, urllib.request, hashlib, subprocess

CREDS = os.path.expanduser('~/.claude/.credentials.json')
CACHE = os.path.expanduser('~/.claude/usage-cache.json')
TTL = 60

def read_token():
    # 先文件（Windows/Linux/WSL），再 Keychain（macOS 唯一来源）
    if os.path.exists(CREDS):
        try:
            return json.load(open(CREDS, encoding='utf-8'))['claudeAiOauth']['accessToken']
        except Exception:
            pass
    if sys.platform == 'darwin':
        try:
            r = subprocess.run(
                ['security', 'find-generic-password', '-s', 'Claude Code-credentials',
                 '-a', os.environ.get('USER', ''), '-w'],
                capture_output=True, text=True, timeout=3)
            if r.returncode == 0:
                return json.loads(r.stdout.strip())['claudeAiOauth']['accessToken']
        except Exception:
            pass
    return None

try:
    token = read_token()
    if not token:
        print('', '')
        sys.exit()
    token_hash = hashlib.md5(token.encode()).hexdigest()[:8]

    if os.path.exists(CACHE):
        cache = json.load(open(CACHE, encoding='utf-8'))
        if cache.get('token_hash') == token_hash and time.time() - cache.get('ts', 0) < TTL:
            d = cache['data']
            print(d['five_hour'], d['seven_day'], d.get('five_hour_reset', ''))
            sys.exit()

    req = urllib.request.Request(
        'https://api.anthropic.com/api/oauth/usage',
        headers={'Authorization': f'Bearer {token}', 'anthropic-beta': 'oauth-2025-04-20', 'Accept': 'application/json'}
    )
    resp = json.loads(urllib.request.urlopen(req, timeout=5).read())
    data = {
        'five_hour': resp.get('five_hour', {}).get('utilization', ''),
        'seven_day': resp.get('seven_day', {}).get('utilization', ''),
        'five_hour_reset': resp.get('five_hour', {}).get('resets_at', ''),
    }
    json.dump({'token_hash': token_hash, 'ts': time.time(), 'data': data}, open(CACHE, 'w'))
    print(data['five_hour'], data['seven_day'], data['five_hour_reset'])
except Exception:
    print('', '', '')
" 2>/dev/null)
rate5h_live=$(echo "$usage_info" | awk '{print $1}')
rate7d_live=$(echo "$usage_info" | awk '{print $2}')
rate5h_reset=$(echo "$usage_info" | awk '{print $3}')
[ -n "$rate5h_live" ] && rate5h="$rate5h_live"
[ -n "$rate7d_live" ] && rate7d="$rate7d_live"

# 从 stats-cache 读取今日统计
today=$(date +%Y-%m-%d)
today_stats=$(python3 -c "
import json, sys, os

stats_file = os.path.expanduser('~/.claude/stats-cache.json')
try:
    with open(stats_file, encoding='utf-8') as f:
        data = json.load(f)
    today = '$today'
    for d in data.get('dailyActivity', []):
        if d['date'] == today:
            print(d.get('messageCount', 0), d.get('sessionCount', 0), d.get('toolCallCount', 0))
            sys.exit()
    print('0 0 0')
except:
    print('0 0 0')
" 2>/dev/null)
today_msg=$(echo "$today_stats" | awk '{print $1}')
today_ses=$(echo "$today_stats" | awk '{print $2}')
today_tool=$(echo "$today_stats" | awk '{print $3}')

# === 颜色函数 ===
pct_color() {
  local pct=$1
  if   [ "$pct" -ge 80 ]; then echo '\033[31m'
  elif [ "$pct" -ge 50 ]; then echo '\033[33m'
  else echo '\033[32m'
  fi
}

# === 第一行：user@host + MSYSTEM + 目录 ===
colored_user_host=$(printf '\033[32m%s@%s\033[0m' "$(whoami)" "$(hostname 2>/dev/null | cut -d. -f1)")
[ -n "$MSYSTEM" ] && colored_msystem=$(printf ' \033[35m%s\033[0m' "$MSYSTEM")
[ -z "$cwd" ] && cwd="$(pwd)"
colored_dir=$(printf '\033[33m%s\033[0m' "$cwd")
line1="${colored_user_host}${colored_msystem} ${colored_dir}"
# 占位符未被替换时（如直接跑源脚本）不显示。
# 这里把占位符串成两段（"__CCS_" + "VERSION__"），避免被 install 时的 sed 一起替换掉
_VERSION_PLACEHOLDER="__CCS_""VERSION__"
if [ -n "$CCS_VERSION" ] && [ "$CCS_VERSION" != "$_VERSION_PLACEHOLDER" ]; then
  line1="${line1} $(printf '\033[90m(ccs %s)\033[0m' "$CCS_VERSION")"
fi

# === 第二行：模型 | ctx | 费用 | 5h rate ===
line2=""
[ -n "$model" ] && line2=$(printf '\033[36m%s\033[0m' "$model")

if [ -n "$used_pct" ]; then
  used_int=$(python3 -c "print(round(float('$used_pct')))" 2>/dev/null)
  if [ -n "$used_int" ]; then
    c=$(pct_color "$used_int")
    line2="${line2} | $(printf "${c}ctx:%s%%\033[0m" "$used_int")"
  fi
fi

if [ -n "$cost" ]; then
  cost_fmt=$(python3 -c "print(f'\${float(\"$cost\"):.4f}')" 2>/dev/null)
  [ -n "$cost_fmt" ] && line2="${line2} | $(printf '\033[38;5;130m%s\033[0m' "$cost_fmt")"
fi

if [ -n "$rate5h" ]; then
  r=$(python3 -c "print(round(float('$rate5h')))" 2>/dev/null)
  if [ -n "$r" ]; then
    c=$(pct_color "$r")
    line2="${line2} | $(printf "${c}5h:%s%%\033[0m" "$r")"
  fi
fi

if [ -n "$rate7d" ]; then
  r=$(python3 -c "print(round(float('$rate7d')))" 2>/dev/null)
  if [ -n "$r" ]; then
    c=$(pct_color "$r")
    line2="${line2} | $(printf "${c}7d:%s%%\033[0m" "$r")"
  fi
fi

# === 第三行：用户信息（实时 API，带缓存）===
user_info=$(python3 -c "
import json, os, sys, time, urllib.request, hashlib, subprocess

CREDS = os.path.expanduser('~/.claude/.credentials.json')
CACHE = os.path.expanduser('~/.claude/profile-cache.json')
TTL = 300  # 5分钟缓存

def read_token():
    if os.path.exists(CREDS):
        try:
            return json.load(open(CREDS, encoding='utf-8'))['claudeAiOauth']['accessToken']
        except Exception:
            pass
    if sys.platform == 'darwin':
        try:
            r = subprocess.run(
                ['security', 'find-generic-password', '-s', 'Claude Code-credentials',
                 '-a', os.environ.get('USER', ''), '-w'],
                capture_output=True, text=True, timeout=3)
            if r.returncode == 0:
                return json.loads(r.stdout.strip())['claudeAiOauth']['accessToken']
        except Exception:
            pass
    return None

try:
    token = read_token()
    if not token:
        sys.exit()
    token_hash = hashlib.md5(token.encode()).hexdigest()[:8]

    if os.path.exists(CACHE):
        cache = json.load(open(CACHE, encoding='utf-8'))
        if cache.get('token_hash') == token_hash and time.time() - cache.get('ts', 0) < TTL:
            d = cache['data']
            print(d['name'], '|', d['email'], '|', d['plan'])
            sys.exit()

    req = urllib.request.Request(
        'https://api.anthropic.com/api/oauth/profile',
        headers={'Authorization': f'Bearer {token}', 'anthropic-beta': 'oauth-2025-04-20', 'Accept': 'application/json'}
    )
    resp = json.loads(urllib.request.urlopen(req, timeout=5).read())
    org_type = resp.get('organization', {}).get('organization_type', '')
    plan_map = {'claude_max': 'Max', 'claude_pro': 'Pro', 'claude_enterprise': 'Enterprise', 'claude_team': 'Team'}
    data = {
        'name': resp['account'].get('display_name', ''),
        'email': resp['account'].get('email', ''),
        'plan': plan_map.get(org_type, org_type),
    }
    json.dump({'token_hash': token_hash, 'ts': time.time(), 'data': data}, open(CACHE, 'w'))
    print(data['name'], '|', data['email'], '|', data['plan'])
except Exception:
    pass
" 2>/dev/null)

user_name=$(echo "$user_info" | awk -F' \\| ' '{print $1}')
user_email=$(echo "$user_info" | awk -F' \\| ' '{print $2}')
user_plan=$(echo "$user_info" | awk -F' \\| ' '{print $3}')

line3=""
[ -n "$user_name"  ] && line3=$(printf '\033[97m%s\033[0m' "$user_name")
[ -n "$user_email" ] && line3="${line3} $(printf '\033[90m<%s>\033[0m' "$user_email")"
[ -n "$user_plan"  ] && line3="${line3} $(printf '\033[35m[%s]\033[0m' "$user_plan")"

# === 输出 ===
if [ -n "$line3" ]; then
  printf '%s\n%s\n%s' "$line1" "$line2" "$line3"
else
  printf '%s\n%s' "$line1" "$line2"
fi

# === 用量表维护 + 自动切换 ===
# 用量表: ~/.ccs/account-usage.json
#   每个账号: { five_hour, resets_at, checked_at }
# 行为:
#   - 每次状态栏 tick 都更新当前 active 的用量
#   - 仅当 active 5h >= 99 时进入切换决策：
#       1. 评估每个候选 OAuth：表里数据有效（now < resets_at）就用；过期或缺失就调 API 刷新
#       2. 优先切到"明确 5h < 99"的候选（按 config.accounts 顺序首个）
#       3. 都查不到用量时（快照 token 过期/网络失败），乐观切到首个 OAuth 候选；
#          ccs 主程序切换时会走完整 refresh 流程，下一 tick 自然恢复正常查询
#       4. 确认全满才不切
#   - 关闭整个功能: touch ~/.ccs/auto-switch.disabled
if [ ! -f "$HOME/.ccs/auto-switch.disabled" ] && [ -n "$rate5h" ]; then
  (python3 - "$rate5h" "$rate5h_reset" <<'PYEOF' &) 2>/dev/null
import json, os, sys, subprocess, urllib.request, urllib.error
from datetime import datetime, timezone

cur_5h_str  = sys.argv[1] if len(sys.argv) > 1 else ''
cur_reset   = sys.argv[2] if len(sys.argv) > 2 else ''

CFG   = os.path.expanduser('~/.ccs/config.json')
USAGE = os.path.expanduser('~/.ccs/account-usage.json')
LOG   = os.path.expanduser('~/.ccs/auto-switch.log')
ACC_DIR = os.path.expanduser('~/.ccs/accounts')

THRESHOLD = 99  # 5h 达到 99% 才触发切换

def log(msg):
    try:
        os.makedirs(os.path.dirname(LOG), exist_ok=True)
        with open(LOG, 'a', encoding='utf-8') as f:
            f.write(f"[{datetime.now().strftime('%F %T')}] {msg}\n")
    except Exception:
        pass

def parse_iso(s):
    if not s: return None
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
    if not os.path.exists(USAGE): return {}
    try:
        return json.load(open(USAGE, encoding='utf-8')) or {}
    except Exception:
        return {}

def read_account_token(name):
    """从 ccs 快照读账号的 OAuth access token (mac 也是这个文件，不是 Keychain)"""
    p = os.path.join(ACC_DIR, f'{name}.credentials.json')
    if not os.path.exists(p): return None
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

# === 读 config ===
try:
    cfg = json.load(open(CFG, encoding='utf-8'))
except Exception as e:
    log(f'read config failed: {e}')
    sys.exit()

cur = cfg.get('activeAccount')
accounts = cfg.get('accounts') or {}
table = load_usage()
now = datetime.now(timezone.utc)
now_iso = now.isoformat()

# === 步骤 1: 更新 active 账号用量（每次 tick 必做）===
try:
    cur_5h_val = float(cur_5h_str) if cur_5h_str else None
except Exception:
    cur_5h_val = None
if cur and cur_5h_val is not None:
    table[cur] = {
        'five_hour': cur_5h_val,
        'resets_at': cur_reset,
        'checked_at': now_iso,
    }
    save_usage(table)

# === 步骤 2: 触发判定 ===
if cur_5h_val is None or cur_5h_val < THRESHOLD:
    sys.exit()  # 没满，不切

# === 步骤 3: 评估候选 ===
candidates = [(n, a) for n, a in accounts.items()
              if n != cur and (a.get('type') or 'oauth') == 'oauth']
if not candidates:
    log(f'5h={cur_5h_val}%, no OAuth candidates to switch to')
    sys.exit()

# 给每个候选评估出 (status, value):
#   status='known': value=用量百分比；'unknown': 查不到（无 token 或 API 失败）
evaluated = []  # [(name, status, value)] 保持 config.accounts 顺序
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
            # 401/网络等失败：快照里的 access_token 可能已被服务端 rotate，
            # 标记为 unknown，留作乐观切兜底（ccs 切换时会走完整 refresh）
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

# 第一轮：明确 5h < 99 的候选优先（按 config.accounts 顺序首个）
target = None
optimistic = False
for name, status, val in evaluated:
    if status == 'known' and val < THRESHOLD:
        target = name
        break

# 第二轮：没有明确可切的，但有 unknown 候选 → 乐观切首个
if not target:
    for name, status, _val in evaluated:
        if status == 'unknown':
            target = name
            optimistic = True
            break

if not target:
    log(f'5h={cur_5h_val}%, all candidates also full (no switch)')
    sys.exit()

# === 步骤 4: 真切换 ===
if optimistic:
    log(f'5h={cur_5h_val}% (resets {cur_reset}), optimistic switch from {cur} to {target} (usage unknown)')
else:
    log(f'5h={cur_5h_val}% (resets {cur_reset}), switching from {cur} to {target} (5h={table[target]["five_hour"]}%)')
try:
    r = subprocess.run(['ccs', target], capture_output=True, text=True, timeout=15)
    if r.returncode == 0:
        log(f'switched to {target} OK')
    else:
        log(f'switch failed rc={r.returncode}: {(r.stderr or r.stdout or "").strip()[:200]}')
except Exception as e:
    log(f'switch exception: {e}')
PYEOF
fi
