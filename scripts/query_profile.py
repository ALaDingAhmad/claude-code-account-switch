"""查询单个 OAuth 账号的真实订阅等级（profile API）。

由 web.js 在切换前后调用：判定 active 账号是否已被降级到 free。
走 anthropic_http.request_anthropic：共享 CF cookie jar + 100s 缓存。

用法（stdin 传 token，避免命令行参数泄漏）：
    echo "$ACCESS_TOKEN" | python3 query_profile.py

输出（一行 JSON 到 stdout）：
    {"ok": true, "organizationType": "claude_free", "isFree": true}
    {"ok": true, "organizationType": "claude_pro",  "isFree": false}
    {"ok": false, "error": "code=401"}

退出码：始终 0（错误也走 JSON），调用方按 ok 字段判断。
"""
import json
import os
import sys


def main():
    token = sys.stdin.read().strip()
    if not token:
        print(json.dumps({'ok': False, 'error': 'no token'}))
        return

    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, script_dir)
        # 状态栏装的副本（~/.claude/anthropic_http.py）行为一致，
        # 这里优先用项目内的源文件，便于开发期改完立即生效。
        from anthropic_http import request_anthropic
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'import helper: {e}'}))
        return

    try:
        code, body, _ = request_anthropic(
            'https://api.anthropic.com/api/oauth/profile',
            token, timeout=8, caller='switch-livePlan', allow_cache=True)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'request: {e}'}))
        return

    if code != 200:
        print(json.dumps({'ok': False, 'error': f'code={code}'}))
        return

    try:
        resp = json.loads(body)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'parse: {e}'}))
        return

    org_type = (resp.get('organization') or {}).get('organization_type') or ''
    # 模糊匹配：Anthropic 历史命名见过 claude_free / free_user 等；
    # 包含 free 关键字一律判降级。避免精确匹配被改名打挂。
    is_free = 'free' in org_type.lower()
    print(json.dumps({
        'ok': True,
        'organizationType': org_type,
        'isFree': is_free,
    }))


if __name__ == '__main__':
    main()
