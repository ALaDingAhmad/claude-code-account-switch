#!/usr/bin/env bash
# 自动切换逻辑测试
# 使用 mock 的 ccs 命令 + mock 的 /api/oauth/usage
# 验证 4 个场景：
#   1. active < 99%       → 仅更新 active 用量，不切换
#   2. active 99%、bob 47% → 切换到 bob
#   3. active 99%、所有候选都 99% → 不切换（B 方案）
#   4. active 99%、表里 bob 数据过期 → 重查 API，按新数据决策

set -e

WORK=/tmp/ccs-autoswitch-test
SCRIPT_REAL=/mnt/d/aiproject/claude-code-account-switch/scripts/statusline-command.sh

rm -rf "$WORK"
mkdir -p "$WORK/.ccs/accounts" "$WORK/.claude" "$WORK/bin"

# Mock ccs：只记录调用
cat > "$WORK/bin/ccs" <<'BIN'
#!/bin/bash
echo "[$(date '+%T')] ccs $*" >> $HOME/.ccs/ccs-calls.log
exit 0
BIN
chmod +x "$WORK/bin/ccs"

# 隔离环境：HOME 指向 $WORK
run_test() {
  local name="$1" rate5h="$2" rate5h_reset="$3" pre_table="$4"
  # 写表（如果有）
  if [ -n "$pre_table" ]; then
    echo "$pre_table" > "$WORK/.ccs/account-usage.json"
  else
    rm -f "$WORK/.ccs/account-usage.json"
  fi
  rm -f "$WORK/.ccs/ccs-calls.log" "$WORK/.ccs/auto-switch.log"

  # 把切换那段提取出来手工跑（避免运行整个状态栏脚本）
  HOME="$WORK" PATH="$WORK/bin:$PATH" \
    rate5h="$rate5h" rate5h_reset="$rate5h_reset" \
    bash -c "
      # 抽出脚本里 '=== 用量表维护 + 自动切换 ===' 后面到 'fi' 的整段
      sed -n '/=== 用量表维护/,/^fi/p' '$SCRIPT_REAL'
    " 2>&1 > /tmp/extracted.sh
  HOME="$WORK" PATH="$WORK/bin:$PATH" \
    rate5h="$rate5h" rate5h_reset="$rate5h_reset" \
    bash /tmp/extracted.sh

  # 等异步 Python 跑完
  sleep 1.5

  echo ""
  echo "── 用量表 ──"
  cat "$WORK/.ccs/account-usage.json" 2>/dev/null | head -30 || echo "(none)"
  echo "── log ──"
  cat "$WORK/.ccs/auto-switch.log" 2>/dev/null || echo "(empty)"
  echo "── ccs calls ──"
  cat "$WORK/.ccs/ccs-calls.log" 2>/dev/null || echo "(no switch)"
  echo "════════════════════════"
}

# 准备 config.json
cat > "$WORK/.ccs/config.json" <<JSON
{
  "version": 2,
  "activeAccount": "alice",
  "accounts": {
    "alice":   {"type":"oauth","name":"alice"},
    "bob":     {"type":"oauth","name":"bob"},
    "charlie": {"type":"oauth","name":"charlie"}
  }
}
JSON

# 准备 mock 候选 token 文件（让 query 时能 read_account_token；但 API 调用会真去打 anthropic.com，离线测试不靠谱）
# 注意：场景 4 需要 mock API——这次只测 1/2/3 不依赖 API 调用的场景
echo '{"claudeAiOauth":{"accessToken":"bob-token-fake-not-real-just-for-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}' > "$WORK/.ccs/accounts/bob.credentials.json"
echo '{"claudeAiOauth":{"accessToken":"charlie-token-fake"}}' > "$WORK/.ccs/accounts/charlie.credentials.json"

FUTURE_1H=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)+timedelta(hours=1)).isoformat())")
FUTURE_2H=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)+timedelta(hours=2)).isoformat())")
FUTURE_3H=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)+timedelta(hours=3)).isoformat())")

echo "═══════════════════════════════════════════════"
echo "Case 1: active alice 5h=50%，不应该触发切换"
echo "═══════════════════════════════════════════════"
run_test "case1" "50" "$FUTURE_2H" ""

echo "═══════════════════════════════════════════════"
echo "Case 2: active alice 5h=99%，表里 bob=47% (valid) → 应该切到 bob"
echo "═══════════════════════════════════════════════"
PRE_TABLE="{\"bob\":{\"five_hour\":47,\"resets_at\":\"$FUTURE_3H\",\"checked_at\":\"$FUTURE_1H\"},\"charlie\":{\"five_hour\":80,\"resets_at\":\"$FUTURE_3H\",\"checked_at\":\"$FUTURE_1H\"}}"
run_test "case2" "99" "$FUTURE_1H" "$PRE_TABLE"

echo "═══════════════════════════════════════════════"
echo "Case 3: active alice 5h=99%，所有候选 99% → 不应该切换"
echo "═══════════════════════════════════════════════"
PRE_TABLE="{\"bob\":{\"five_hour\":99,\"resets_at\":\"$FUTURE_3H\",\"checked_at\":\"$FUTURE_1H\"},\"charlie\":{\"five_hour\":99,\"resets_at\":\"$FUTURE_2H\",\"checked_at\":\"$FUTURE_1H\"}}"
run_test "case3" "99" "$FUTURE_1H" "$PRE_TABLE"

echo "═══════════════════════════════════════════════"
echo "Case 4: active alice 5h=99%，表里 bob 数据 resets_at 已过期 → 需要重查 API"
echo "         （此场景 API 调用会失败，bob 视为不可用；charlie 表里没数据也调 API 也失败 → 全失败 → 不切）"
echo "═══════════════════════════════════════════════"
PAST_1H=$(python3 -c "from datetime import datetime,timezone,timedelta; print((datetime.now(timezone.utc)-timedelta(hours=1)).isoformat())")
PRE_TABLE="{\"bob\":{\"five_hour\":47,\"resets_at\":\"$PAST_1H\",\"checked_at\":\"$PAST_1H\"}}"
run_test "case4" "99" "$FUTURE_1H" "$PRE_TABLE"
