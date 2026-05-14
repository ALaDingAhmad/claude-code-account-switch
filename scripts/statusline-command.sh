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

# 最近 30 分钟内有过自动切换 → 追加红色提示让用户重启 Claude Code
# Claude Code 进程启动时把 token 加载进内存，自动切换只改文件、不改内存中的 token；
# 必须重启 Claude Code 才能让新 token 生效
switch_hint=$(python3 -c "
import json, os, time
from datetime import datetime
p = os.path.expanduser('~/.ccs/last-switch.json')
if not os.path.exists(p): exit()
try:
    d = json.load(open(p, encoding='utf-8'))
    ts = float(d.get('ts', 0))
    if time.time() - ts > 1800: exit()  # 30 分钟外不提示
    to = d.get('to', '?')
    when = datetime.fromtimestamp(ts).strftime('%H:%M')
    print(f'已切到 {to}（{when}），重启 Claude Code 生效')
except Exception:
    pass
" 2>/dev/null)
if [ -n "$switch_hint" ]; then
  hint_colored=$(printf '\033[1;31m⚠ %s\033[0m' "$switch_hint")
  line3="${line3:+${line3} | }${hint_colored}"
fi

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
  # 切换逻辑抽到 auto_switch_core.py（与状态栏脚本同目录），便于守护进程复用
  # 后台异步跑，不阻塞状态栏渲染；错误吞掉避免影响状态栏
  _CORE="$(dirname "$0")/auto_switch_core.py"
  if [ -f "$_CORE" ]; then
    (python3 "$_CORE" "$rate5h" "$rate5h_reset" &) 2>/dev/null
  fi
fi

# 用量监控守护进程：active 5h ≥ 90% 时拉起，自带 60s/10s 调度直到撞墙或下降
# 单例：usage_monitor.py 自己用 pid 文件去重，重复 spawn 也无害
# 关闭整个守护: touch ~/.ccs/usage-monitor.disabled
if [ ! -f "$HOME/.ccs/usage-monitor.disabled" ] && [ -n "$rate5h" ]; then
  _MON="$(dirname "$0")/usage_monitor.py"
  if [ -f "$_MON" ]; then
    _5h_int=$(python3 -c "print(int(float('$rate5h')))" 2>/dev/null)
    if [ -n "$_5h_int" ] && [ "$_5h_int" -ge 90 ]; then
      (python3 "$_MON" &) 2>/dev/null
    fi
  fi
fi
