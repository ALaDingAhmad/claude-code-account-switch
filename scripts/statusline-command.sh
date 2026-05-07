#!/usr/bin/env bash
# Claude Code 状态栏脚本

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
import json, os, time, urllib.request, hashlib

CREDS = os.path.expanduser('~/.claude/.credentials.json')
CACHE = os.path.expanduser('~/.claude/usage-cache.json')
TTL = 60

try:
    creds = json.load(open(CREDS, encoding='utf-8'))
    token = creds['claudeAiOauth']['accessToken']
    token_hash = hashlib.md5(token.encode()).hexdigest()[:8]

    if os.path.exists(CACHE):
        cache = json.load(open(CACHE, encoding='utf-8'))
        if cache.get('token_hash') == token_hash and time.time() - cache.get('ts', 0) < TTL:
            d = cache['data']
            print(d['five_hour'], d['seven_day'])
            exit()

    req = urllib.request.Request(
        'https://api.anthropic.com/api/oauth/usage',
        headers={'Authorization': f'Bearer {token}', 'anthropic-beta': 'oauth-2025-04-20', 'Accept': 'application/json'}
    )
    resp = json.loads(urllib.request.urlopen(req, timeout=5).read())
    data = {
        'five_hour': resp.get('five_hour', {}).get('utilization', ''),
        'seven_day': resp.get('seven_day', {}).get('utilization', ''),
    }
    json.dump({'token_hash': token_hash, 'ts': time.time(), 'data': data}, open(CACHE, 'w'))
    print(data['five_hour'], data['seven_day'])
except:
    print('', '')
" 2>/dev/null)
rate5h_live=$(echo "$usage_info" | awk '{print $1}')
rate7d_live=$(echo "$usage_info" | awk '{print $2}')
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
  if   [ "$pct" -ge 80 ]; then echo '\e[31m'
  elif [ "$pct" -ge 50 ]; then echo '\e[33m'
  else echo '\e[32m'
  fi
}

# === 第一行：user@host + MSYSTEM + 目录 ===
colored_user_host=$(printf '\e[32m%s@%s\e[0m' "$(whoami)" "$(hostname 2>/dev/null | cut -d. -f1)")
[ -n "$MSYSTEM" ] && colored_msystem=$(printf ' \e[35m%s\e[0m' "$MSYSTEM")
[ -z "$cwd" ] && cwd="$(pwd)"
colored_dir=$(printf '\e[33m%s\e[0m' "$cwd")
line1="${colored_user_host}${colored_msystem} ${colored_dir}"

# === 第二行：模型 | ctx | 费用 | 5h rate ===
line2=""
[ -n "$model" ] && line2=$(printf '\e[36m%s\e[0m' "$model")

if [ -n "$used_pct" ]; then
  used_int=$(python3 -c "print(round(float('$used_pct')))" 2>/dev/null)
  if [ -n "$used_int" ]; then
    c=$(pct_color "$used_int")
    line2="${line2} | $(printf "${c}ctx:%s%%\e[0m" "$used_int")"
  fi
fi

if [ -n "$cost" ]; then
  cost_fmt=$(python3 -c "print(f'\${float(\"$cost\"):.4f}')" 2>/dev/null)
  [ -n "$cost_fmt" ] && line2="${line2} | $(printf '\e[37m$%s\e[0m' "$cost_fmt")"
fi

if [ -n "$rate5h" ]; then
  r=$(python3 -c "print(round(float('$rate5h')))" 2>/dev/null)
  if [ -n "$r" ]; then
    c=$(pct_color "$r")
    line2="${line2} | $(printf "${c}5h:%s%%\e[0m" "$r")"
  fi
fi

if [ -n "$rate7d" ]; then
  r=$(python3 -c "print(round(float('$rate7d')))" 2>/dev/null)
  if [ -n "$r" ]; then
    c=$(pct_color "$r")
    line2="${line2} | $(printf "${c}7d:%s%%\e[0m" "$r")"
  fi
fi

# === 第三行：用户信息（实时 API，带缓存）===
user_info=$(python3 -c "
import json, os, time, urllib.request, hashlib

CREDS = os.path.expanduser('~/.claude/.credentials.json')
CACHE = os.path.expanduser('~/.claude/profile-cache.json')
TTL = 300  # 5分钟缓存

try:
    creds = json.load(open(CREDS, encoding='utf-8'))
    token = creds['claudeAiOauth']['accessToken']
    token_hash = hashlib.md5(token.encode()).hexdigest()[:8]

    if os.path.exists(CACHE):
        cache = json.load(open(CACHE, encoding='utf-8'))
        if cache.get('token_hash') == token_hash and time.time() - cache.get('ts', 0) < TTL:
            d = cache['data']
            print(d['name'], '|', d['email'], '|', d['plan'])
            exit()

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
except:
    pass
" 2>/dev/null)

user_name=$(echo "$user_info" | awk -F' \\| ' '{print $1}')
user_email=$(echo "$user_info" | awk -F' \\| ' '{print $2}')
user_plan=$(echo "$user_info" | awk -F' \\| ' '{print $3}')

line3=""
[ -n "$user_name"  ] && line3=$(printf '\e[97m%s\e[0m' "$user_name")
[ -n "$user_email" ] && line3="${line3} $(printf '\e[90m<%s>\e[0m' "$user_email")"
[ -n "$user_plan"  ] && line3="${line3} $(printf '\e[35m[%s]\e[0m' "$user_plan")"

# === 输出 ===
if [ -n "$line3" ]; then
  printf '%s\n%s\n%s' "$line1" "$line2" "$line3"
else
  printf '%s\n%s' "$line1" "$line2"
fi
