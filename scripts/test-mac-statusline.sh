#!/usr/bin/env bash
# Mac 状态栏完整集成测试
# 用法：bash test-mac-statusline.sh
#
# 模拟 Claude Code 传给 statusLine 命令的 stdin JSON，跑完整 statusline-command.sh，
# 把输出抓回来给人肉/眼检查。
#
# 期望：三行输出
#   line1: 绿色 user@host + 黄色 cwd
#   line2: 青色 模型 | 颜色 ctx% | 灰色 $cost | 颜色 5h% | 颜色 7d%
#   line3: 白色 用户名 + 灰色 <email> + 紫色 [Pro/Max/...]
#
# 任何一行缺失或显示乱码（如字面 \e[32m）即为失败，请把完整输出贴回来

set -u

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
TARGET="$SCRIPT_DIR/statusline-command.sh"

echo "===================================="
echo "  Mac 状态栏集成测试"
echo "===================================="
echo ""

if [ ! -f "$TARGET" ]; then
  echo "[FAIL] 找不到 statusline-command.sh：$TARGET"
  exit 1
fi
echo "目标脚本: $TARGET"
echo "Bash 版本: $BASH_VERSION"
echo "Python3: $(command -v python3 || echo '未找到')"
echo ""

# Claude Code 实际传给 statusLine 命令的 stdin JSON 形态
# （字段名与官方文档一致：workspace.current_dir / model.display_name / cost / context_window / rate_limits）
read -r -d '' MOCK_INPUT <<'JSON' || true
{
  "workspace": {"current_dir": "/Users/test/some/project"},
  "model": {"display_name": "Opus 4.7"},
  "context_window": {"used_percentage": 42.5},
  "cost": {"total_cost_usd": 1.2345},
  "rate_limits": {
    "five_hour": {"used_percentage": 47},
    "seven_day": {"used_percentage": 98}
  }
}
JSON

echo "── 模拟输入（缩略）─────────────────────"
echo "$MOCK_INPUT" | head -c 200
echo "..."
echo ""

echo "── 脚本原始输出（包含 ANSI 转义序列，应该看到颜色）──"
echo "$MOCK_INPUT" | bash "$TARGET"
echo ""
echo "── 上面是渲染后的输出 ──"
echo ""

echo "── 脚本输出的"原始字节"（去掉颜色后才能看到纯文本）──"
RAW=$(echo "$MOCK_INPUT" | bash "$TARGET")
# 用 sed 去 ANSI 颜色码，方便检查"内容是否对"
NOCOLOR=$(printf '%s' "$RAW" | python3 -c "
import sys, re
text = sys.stdin.read()
# 去掉 ANSI escape: ESC[...m
clean = re.sub(r'\x1b\[[0-9;]*m', '', text)
# 检测是否有"未渲染"的字面 \e
has_literal_esc = '\\\\e[' in clean or r'\e[' in clean
print(clean)
print('---')
print('LITERAL_ESC_DETECTED' if has_literal_esc else 'NO_LITERAL_ESC')
")
echo "$NOCOLOR"
echo ""

# 简单断言
echo "── 自动检查 ──"
LINE_COUNT=$(printf '%s' "$RAW" | grep -c '' || true)
echo "  行数            : $LINE_COUNT （期望 3）"
echo "  含 ctx:42%      : $(printf '%s' "$RAW" | grep -c 'ctx:42%' || true) （期望 1）"
echo "  含 5h:47%       : $(printf '%s' "$RAW" | grep -c '5h:47%' || true) （期望 1）"
echo "  含 7d:98%       : $(printf '%s' "$RAW" | grep -c '7d:98%' || true) （期望 1）"
echo "  含 \$1.2345     : $(printf '%s' "$RAW" | grep -c '\$1.2345' || true) （期望 1）"
echo "  含 Opus 4.7     : $(printf '%s' "$RAW" | grep -c 'Opus 4.7' || true) （期望 1）"
# 如果脚本有 bug，可能显示字面 "\e[" 而不是真正的 ESC
echo "  字面 \\e[ 残留   : $(printf '%s' "$RAW" | grep -c '\\\\e\[' || true) （期望 0，>0 说明颜色码不被识别）"
echo ""

echo "── 第三行（用户名/邮箱/套餐）检查 ──"
echo "  这一行如果空白，说明 mac Keychain fallback 没生效或 API 调用失败"
echo "  请确认输出里有类似 'Javier Horváth <calychasse@gmail.com> [Pro]' 的内容"
echo ""

echo "===================================="
echo "  测试结束 - 请把上面完整输出贴回来"
echo "===================================="
