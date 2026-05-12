#!/usr/bin/env bash
# Mac 端状态栏 API 连通性测试
# 用法：bash test-mac-api.sh
#
# 测试三件事：
#   1. 能否从 mac Keychain 读到 OAuth token
#   2. 能否成功调 /api/oauth/profile（用户/邮箱/套餐）
#   3. 能否成功调 /api/oauth/usage（5h / 7d 速率）
# 任一步骤失败都会打印诊断信息

echo "===================================="
echo "  Claude Code 状态栏 mac 兼容性测试"
echo "===================================="
echo ""

# 1) 平台检测
echo "[1/4] 平台检测"
uname_s=$(uname -s)
echo "  uname -s : $uname_s"
if [ "$uname_s" != "Darwin" ]; then
  echo "  ⚠ 这个测试脚本是为 macOS 设计的（uname -s 不是 Darwin），继续仅作参考"
fi
echo "  python3  : $(command -v python3 || echo '未找到')"
echo "  security : $(command -v security || echo '未找到')"
echo ""

# 2) 读 token
echo "[2/4] 读取 OAuth token"
echo "  路径 A: ~/.claude/.credentials.json（文件方式）"
if [ -f "$HOME/.claude/.credentials.json" ]; then
  echo "  → 文件存在"
  token_a=$(python3 -c "
import json
try:
    d = json.load(open('$HOME/.claude/.credentials.json', encoding='utf-8'))
    print(d['claudeAiOauth']['accessToken'])
except Exception as e:
    print('ERR:'+str(e))
" 2>&1)
  if [[ "$token_a" == ERR:* ]]; then
    echo "  → 文件读取失败：${token_a#ERR:}"
    token_a=""
  else
    echo "  → 取到 token（长度=${#token_a}, 末 8 位=${token_a: -8}）"
  fi
else
  echo "  → 文件不存在"
  token_a=""
fi

echo ""
echo "  路径 B: macOS Keychain（service=\"Claude Code-credentials\", account=\"$USER\"）"
echo "  → 首次执行可能弹出 Keychain 授权对话框，请点「始终允许」"
sec_out=$(security find-generic-password -s "Claude Code-credentials" -a "$USER" -w 2>&1)
sec_rc=$?
if [ $sec_rc -eq 0 ]; then
  token_b=$(echo "$sec_out" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(d['claudeAiOauth']['accessToken'])
except Exception as e:
    print('ERR:'+str(e))
" 2>&1)
  if [[ "$token_b" == ERR:* ]]; then
    echo "  → Keychain 返回内容不是合法 JSON：${token_b#ERR:}"
    echo "  → 原始前 80 字符: ${sec_out:0:80}"
    token_b=""
  else
    echo "  → 取到 token（长度=${#token_b}, 末 8 位=${token_b: -8}）"
  fi
else
  echo "  → security 命令退出码=$sec_rc"
  echo "  → 输出: $sec_out"
  token_b=""
fi

# 选用：优先 Keychain（mac 实际存储位置），再 fallback 到文件
token="$token_b"
[ -z "$token" ] && token="$token_a"

if [ -z "$token" ]; then
  echo ""
  echo "[FAIL] 两种方式都拿不到 token，后续 API 测试无法继续"
  exit 1
fi
echo ""
echo "  → 后续测试使用：${token:+Keychain}${token_b:+}${token_a:+ 或文件方式}（实际选用：${token: -8}）"
echo ""

# 3) /api/oauth/profile
echo "[3/4] 调用 /api/oauth/profile"
profile_resp=$(python3 -c "
import urllib.request, json, sys
try:
    req = urllib.request.Request(
        'https://api.anthropic.com/api/oauth/profile',
        headers={
            'Authorization': 'Bearer $token',
            'anthropic-beta': 'oauth-2025-04-20',
            'Accept': 'application/json',
        }
    )
    resp = urllib.request.urlopen(req, timeout=10)
    print('HTTP', resp.status)
    print(resp.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print('HTTP', e.code)
    print(e.read().decode('utf-8'))
except Exception as e:
    print('ERR', type(e).__name__, str(e))
" 2>&1)
echo "$profile_resp" | head -20
echo ""

# 解析关键字段
profile_summary=$(echo "$profile_resp" | python3 -c "
import json, sys
lines = sys.stdin.read().split('\n', 1)
if len(lines) < 2 or not lines[0].startswith('HTTP 200'):
    print('NOT_OK')
    sys.exit()
try:
    d = json.loads(lines[1])
    acc = d.get('account', {})
    org = d.get('organization', {})
    print(f\"name={acc.get('display_name','')} email={acc.get('email','')} org_type={org.get('organization_type','')}\")
except Exception as e:
    print('PARSE_ERR:'+str(e))
" 2>&1)
echo "  解析结果：$profile_summary"
echo ""

# 4) /api/oauth/usage
echo "[4/4] 调用 /api/oauth/usage"
usage_resp=$(python3 -c "
import urllib.request, json, sys
try:
    req = urllib.request.Request(
        'https://api.anthropic.com/api/oauth/usage',
        headers={
            'Authorization': 'Bearer $token',
            'anthropic-beta': 'oauth-2025-04-20',
            'Accept': 'application/json',
        }
    )
    resp = urllib.request.urlopen(req, timeout=10)
    print('HTTP', resp.status)
    print(resp.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    print('HTTP', e.code)
    print(e.read().decode('utf-8'))
except Exception as e:
    print('ERR', type(e).__name__, str(e))
" 2>&1)
echo "$usage_resp" | head -20
echo ""

usage_summary=$(echo "$usage_resp" | python3 -c "
import json, sys
lines = sys.stdin.read().split('\n', 1)
if len(lines) < 2 or not lines[0].startswith('HTTP 200'):
    print('NOT_OK')
    sys.exit()
try:
    d = json.loads(lines[1])
    print(f\"five_hour.utilization={d.get('five_hour',{}).get('utilization','')} seven_day.utilization={d.get('seven_day',{}).get('utilization','')}\")
except Exception as e:
    print('PARSE_ERR:'+str(e))
" 2>&1)
echo "  解析结果：$usage_summary"
echo ""

echo "===================================="
echo "  测试完成"
echo "===================================="
echo "请把上面完整输出贴回来"
