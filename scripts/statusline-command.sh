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

# 从 /api/oauth/usage 实时查用量。
# 不再用本地 60s 文件缓存——统一走 anthropic_http helper 的共享 100s 缓存（~/.ccs/usage-shared-cache.json）
usage_info=$(python3 -c "
import json, os, sys, subprocess

CREDS = os.path.expanduser('~/.claude/.credentials.json')

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
        print('', '', '')
        sys.exit()

    sys.path.insert(0, os.path.expanduser('~/.claude'))
    from anthropic_http import request_anthropic
    code, body, _ = request_anthropic('https://api.anthropic.com/api/oauth/usage', token, timeout=5, caller='statusline')
    if code != 200:
        print('', '', '')
        sys.exit()
    resp = json.loads(body)
    fh = resp.get('five_hour', {}) or {}
    sd = resp.get('seven_day', {}) or {}
    print(fh.get('utilization', ''), sd.get('utilization', ''), fh.get('resets_at', ''))
except Exception:
    print('', '', '')
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

# === 第三行：用户信息（统一走 anthropic_http helper 的共享缓存）===
user_info=$(python3 -c "
import json, os, sys, subprocess

CREDS = os.path.expanduser('~/.claude/.credentials.json')

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

    sys.path.insert(0, os.path.expanduser('~/.claude'))
    from anthropic_http import request_anthropic
    code, body, _ = request_anthropic('https://api.anthropic.com/api/oauth/profile', token, timeout=5, caller='statusline')
    if code != 200:
        sys.exit()
    resp = json.loads(body)
    org_type = resp.get('organization', {}).get('organization_type', '')
    plan_map = {'claude_max': 'Max', 'claude_pro': 'Pro', 'claude_enterprise': 'Enterprise', 'claude_team': 'Team'}
    name = resp.get('account', {}).get('display_name', '')
    email = resp.get('account', {}).get('email', '')
    plan = plan_map.get(org_type, org_type)
    print(name, '|', email, '|', plan)
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

# 最近 30 分钟内有过自动切换 → 第 4 行显示灰色告知（实测对当前 Claude Code 进程透明，
# 无需重启，下次请求自动用新 token；这里只是告诉用户切换发生了，看个心安）
switch_hint=$(python3 -c "
import json, os, time
from datetime import datetime
p = os.path.expanduser('~/.ccs/last-switch.json')
if not os.path.exists(p): exit()
try:
    d = json.load(open(p, encoding='utf-8'))
    ts = float(d.get('ts', 0))
    if time.time() - ts > 300: exit()  # 5 分钟外不提示
    to = d.get('to', '?')
    when = datetime.fromtimestamp(ts).strftime('%H:%M')
    print(f'最近切到 {to}（{when}）')
except Exception:
    pass
" 2>/dev/null)
line4=""
if [ -n "$switch_hint" ]; then
  line4=$(printf '\033[90m%s\033[0m' "$switch_hint")
fi

# === 输出 ===
# 切换提示独占第 4 行，避免和账号信息挤在一起把窄状态栏撑爆
if [ -n "$line3" ] && [ -n "$line4" ]; then
  printf '%s\n%s\n%s\n%s' "$line1" "$line2" "$line3" "$line4"
elif [ -n "$line3" ]; then
  printf '%s\n%s\n%s' "$line1" "$line2" "$line3"
elif [ -n "$line4" ]; then
  printf '%s\n%s\n%s' "$line1" "$line2" "$line4"
else
  printf '%s\n%s' "$line1" "$line2"
fi
# 注：v3.9.0 起状态栏不再做自动切换 / spawn 守护，仅展示用量
# 自动切换守护进程改为通过 Web UI「账号用量监控」开关启用
