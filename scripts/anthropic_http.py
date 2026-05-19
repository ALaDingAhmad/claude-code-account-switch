"""Anthropic OAuth 端点的 HTTP 客户端 helper。

三件事：
  1. 共享 Cloudflare cookie jar（~/.ccs/cf-cookies.txt）
  2. **共享查询缓存**（~/.ccs/usage-shared-cache.json）：按 token hash 分桶，TTL 100s
     monitor / 状态栏 / 切换决策共用这个缓存，全机一分钟最多 1 次真请求
  3. **每次查询都写日志**到 ~/.ccs/auto-switch.log，缓存命中也写
     排查 cf-429 时眼睛能直接看到节奏，不靠猜
"""
import os
import time
import json
import hashlib
import urllib.request
import urllib.error
import http.cookiejar
from datetime import datetime

CCS_DIR = os.path.expanduser('~/.ccs')
COOKIE_FILE = os.path.join(CCS_DIR, 'cf-cookies.txt')
CACHE_FILE  = os.path.join(CCS_DIR, 'usage-shared-cache.json')
LOG_FILE    = os.path.join(CCS_DIR, 'auto-switch.log')

CACHE_TTL = 100  # 秒；与 monitor 闲时轮询节奏一致

_jar = None
_opener = None


def _log(caller, line):
    """每次查询写一行到守护日志。caller 区分调用方：monitor / statusline / switch-core"""
    try:
        os.makedirs(CCS_DIR, exist_ok=True)
        ts = datetime.now().strftime('%F %T')
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(f'[{ts}] [{caller}] {line}\n')
    except Exception:
        pass


def _token_hash(token):
    return hashlib.md5(token.encode()).hexdigest()[:8]


def _load_cache():
    try:
        return json.load(open(CACHE_FILE, encoding='utf-8'))
    except Exception:
        return {}


def _save_cache(cache):
    try:
        os.makedirs(CCS_DIR, exist_ok=True)
        json.dump(cache, open(CACHE_FILE, 'w', encoding='utf-8'))
    except Exception:
        pass


def _get_opener():
    global _jar, _opener
    if _opener is not None:
        return _opener
    os.makedirs(CCS_DIR, exist_ok=True)
    _jar = http.cookiejar.MozillaCookieJar(COOKIE_FILE)
    try:
        _jar.load(ignore_discard=True, ignore_expires=True)
    except (FileNotFoundError, http.cookiejar.LoadError):
        pass
    _opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_jar))
    return _opener


def _save_jar():
    if _jar is None:
        return
    try:
        _jar.save(ignore_discard=True, ignore_expires=True)
    except Exception:
        pass


def _do_request(url, token, timeout, beta):
    """单次真请求，返回 (code, body, headers)。不带任何重试 / 缓存。"""
    opener = _get_opener()
    req = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {token}',
        'anthropic-beta': beta,
        'Accept': 'application/json',
    })
    try:
        r = opener.open(req, timeout=timeout)
        body = r.read()
        headers = dict(r.getheaders())
        _save_jar()
        return r.getcode(), body, headers
    except urllib.error.HTTPError as e:
        body = e.read() if hasattr(e, 'read') else b''
        headers = dict(e.headers.items()) if e.headers else {}
        _save_jar()
        return e.code, body, headers
    except Exception as e:
        return None, b'', {'_exc': str(e)}


def _summarize(url, code, body, headers):
    """生成日志摘要：HTTP 码 + 关键业务字段或 429 类型"""
    # url 末段决定字段含义
    endpoint = url.rsplit('/', 1)[-1]  # 'usage' / 'profile'
    if code == 200:
        try:
            data = json.loads(body)
            if endpoint == 'usage':
                fh = data.get('five_hour') or {}
                return f'http=200 5h={fh.get("utilization")}% reset={fh.get("resets_at", "")[:19]}'
            if endpoint == 'profile':
                acc = data.get('account') or {}
                return f'http=200 email={acc.get("email", "")}'
            return 'http=200'
        except Exception:
            return 'http=200 (parse failed)'
    if code == 429:
        kind = 'real-anthropic' if 'anthropic-organization-id' in headers else 'cf-edge'
        return f'http=429 {kind}'
    if code is None:
        return f'http=ERR ({headers.get("_exc", "?")[:60]})'
    return f'http={code}'


def request_anthropic(url, token, timeout=8, beta='oauth-2025-04-20',
                      caller='unknown', allow_cache=True):
    """请求 Anthropic OAuth 端点（带共享缓存 + 日志）。

    Args:
        url: 完整 URL，如 'https://api.anthropic.com/api/oauth/usage'
        token: OAuth access token
        caller: 调用方标识（monitor / statusline / switch-core），写入日志
        allow_cache: True 则优先用 100s 内的缓存结果；False 强制真请求

    Returns:
        (code:int|None, body:bytes, headers:dict)
        from_cache 信息只在日志体现，不返回。
    """
    th = _token_hash(token)
    cache_key = f'{th}:{url}'
    now = time.time()

    if allow_cache:
        cache = _load_cache()
        entry = cache.get(cache_key)
        if entry and (now - entry.get('ts', 0)) < CACHE_TTL:
            # cache-hit 静默不写日志——避免状态栏每秒 tick 把日志刷成噪音
            # 真请求（下面）和异常路径才写日志
            body = bytes.fromhex(entry.get('body_hex', '')) if entry.get('body_hex') else b''
            return entry.get('code'), body, entry.get('headers') or {}

    code, body, headers = _do_request(url, token, timeout, beta)
    summary = _summarize(url, code, body, headers)
    _log(caller, f'query {url.rsplit("/", 1)[-1]} → {summary}')

    # 写缓存：200 / 429 都缓存（cf-429 缓存意味着 100s 内不再重打 = 给 CF 喘息）
    # 网络错误（code=None）不缓存，让上层尽快重试
    if code is not None:
        cache = _load_cache()
        cache[cache_key] = {
            'ts': now,
            'code': code,
            'body_hex': body.hex(),
            'headers': {k: v for k, v in headers.items() if not k.startswith('_')},
            'summary': summary,
        }
        # 顺手清理 24h 以上的陈旧条目，避免文件无限膨胀
        cache = {k: v for k, v in cache.items() if now - v.get('ts', 0) < 86400}
        _save_cache(cache)

    return code, body, headers


def is_real_anthropic_429(headers):
    """429 时区分：True=Anthropic 后端（含真用尽），False=Cloudflare 边缘拦截"""
    return 'anthropic-organization-id' in (headers or {})
