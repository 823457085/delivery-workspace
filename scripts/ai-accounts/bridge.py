#!/usr/bin/python3
"""Bounded JSONL bridge for local Codex and Claude Code account management."""
from datetime import datetime, timezone
import fcntl
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import time
from urllib.parse import urlsplit

from common import Error, Manager, read_json, valid_name
# Reuse the already-tested cancellation path; it waits for the login child before rollback.
import importlib.util
_spec = importlib.util.spec_from_file_location('cursor_login_bridge', Path(__file__).resolve().parents[1] / 'cursor-accounts/bridge.py')
_cursor = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_cursor)
emit = _cursor.emit
stop_login = _cursor.stop_login

LOGIN_TARGETS = {
    'codex': [('auth.openai.com', '/oauth/authorize'), ('auth.openai.com', '/codex/device')],
    'claude': [('claude.com', '/cai/oauth/authorize'), ('platform.claude.com', '/oauth/authorize'),
               ('claude.ai', '/oauth/authorize')],
}


def official_login_url(provider, text):
    for candidate in re.findall(r'https://[^\s\x1b<>"\']+', text):
        try:
            url = urlsplit(candidate)
            if url.scheme == 'https' and (url.netloc, url.path) in LOGIN_TARGETS[provider] and not url.fragment:
                return candidate
        except ValueError:
            pass
    return None


def login_runner(adapter):
    child = subprocess.Popen(adapter.command() + adapter.login_args(), env=adapter.child_env(),
                             cwd=getattr(adapter, 'login_cwd', adapter.home),
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    text, sent_url = '', None
    deadline = time.monotonic() + 600
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while child.poll() is None or selector.get_map():
                if time.monotonic() > deadline:
                    raise Error('官方登录等待超时，当前账号未改变。')
                for key, _ in selector.select(timeout=0.2):
                    chunk = os.read(key.fd, 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    text = (text + chunk.decode('utf-8', errors='replace'))[-16_000:]
                    complete = text[:max(text.rfind('\n'), text.rfind('\r')) + 1]
                    url = official_login_url(adapter.provider, complete)
                    if url and url != sent_url:
                        emit({'type': 'login', 'url': url})
                        sent_url = url
            return child.wait()
    finally:
        stop_login(child, isolated=True)
        if child.stdout:
            child.stdout.close()


def inspect(manager):
    adapter = manager.adapter
    result = {'type': 'snapshot', 'available': sys.platform == 'darwin', 'accounts': [
        {'name': name, 'email': value.get('email', ''), 'team': value.get('team', ''),
         'displayName': value.get('displayName', ''), 'identity': value.get('identity', '')}
        for name, value in manager.db.get('accounts', {}).items()],
        'current': None, 'pendingRecovery': bool(manager.db.get('pending')),
        'activePids': [], 'blockedReason': '', 'checkedAt': datetime.now(timezone.utc).isoformat()}
    try:
        if not result['available']:
            raise Error('AI 账号管理目前仅支持 macOS。')
        adapter.check_environment()
        result['activePids'] = adapter.active_pids()
        cached = adapter.current()
        if cached:
            result['current'] = {key: cached.get(key, '')
                                 for key in ('email', 'team', 'identity', 'displayName')}
            result['current']['verified'] = False
        if not result['pendingRecovery']:
            try:
                # validate returns credentials: project identity fields only, never emit its snapshot.
                identity = adapter.identity(adapter.validate())
                if not identity.get('key'):
                    raise Error('官方 CLI 未返回可确认的账号身份，请重新登录。')
                if cached and ((cached.get('identity') and cached['identity'] != identity['key'])
                               or (cached.get('email') and identity.get('email')
                                   and cached['email'].casefold() != identity['email'].casefold())):
                    raise Error('本机登录身份在检查期间变化，请刷新状态后重试。')
                result['current'] = {'email': identity.get('email', ''), 'team': identity.get('team', ''),
                                     'identity': identity['key'], 'verified': True,
                                     'displayName': cached.get('displayName', '') if cached else ''}
            except (Error, OSError, ValueError, subprocess.TimeoutExpired) as error:
                result['blockedReason'] = str(error)[:500] if isinstance(error, Error) else '本机登录状态暂时无法核验，请刷新状态后重试。'
    except (Error, OSError, ValueError, subprocess.TimeoutExpired) as error:
        result['available'] = False
        result['blockedReason'] = str(error)[:500] if isinstance(error, Error) else '本机账号状态无法读取，请检查 CLI 安装与配置。'
    if result['activePids'] and not result['blockedReason']:
        result['blockedReason'] = '检测到 %s 进程运行（PID: %s）。仍可切换，已打开的会话继续使用原账号，重新启动后生效。' % (
            adapter.label, ', '.join(map(str, result['activePids'])))
    if result['pendingRecovery']:
        result['blockedReason'] = '上次账号操作被中断，请先恢复上次账号。'
    emit(result)


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in LOGIN_TARGETS or sys.argv[2] not in ('inspect', 'save', 'login', 'use', 'restore', 'delete'):
        raise Error('账号操作不受支持。')
    provider, action = sys.argv[1:3]
    if provider == 'codex':
        from codex_adapter import CodexAdapter
        adapter = CodexAdapter()
    else:
        from claude_adapter import ClaudeAdapter
        adapter = ClaudeAdapter()
    manager = Manager(adapter, login_runner=login_runner)
    if action == 'inspect':
        inspect(manager)
        return 0
    if sys.platform != 'darwin':
        raise Error('AI 账号管理目前仅支持 macOS。')
    adapter.check_environment()
    name = valid_name(sys.argv[3]) if action != 'restore' and len(sys.argv) == 4 else None
    if action != 'restore' and not name:
        raise Error('请提供账号名称。')
    manager.data.mkdir(parents=True, exist_ok=True, mode=0o700)
    manager.data.chmod(0o700)
    saved_name = None
    with (manager.data / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Error('另一个账号管理操作正在运行，请先完成或退出。') from None
        # Re-read metadata only after acquiring the cross-process lock.
        manager = Manager(adapter, login_runner=login_runner)
        if name:
            result = getattr(manager, action)(name)
            if action == 'login':
                saved_name = valid_name(result)
        else:
            manager.restore()
    messages = {'save': '已保存当前账号', 'login': '已保存账号，当前使用的账号未改变',
                'use': '已切换本机登录账号', 'restore': '已恢复上次操作前的本地登录状态',
                'delete': '已删除已保存账号'}
    emit({'type': 'result', 'message': adapter.label + '：' + messages[action],
          **({'accountName': saved_name} if saved_name else {})})
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    signal.signal(signal.SIGINT, _cursor.interrupt)
    signal.signal(signal.SIGTERM, _cursor.interrupt)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        provider = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in LOGIN_TARGETS else ''
        pending = read_json(Path.home() / '.local/share/delivery-ai-accounts' / provider / 'accounts.json', {}).get('pending')
        emit({'type': 'error' if pending else 'result', 'message':
              '取消后仍有待恢复的账号，请先恢复上次账号。' if pending else
              '已取消添加，当前账号未改变。' if len(sys.argv) > 2 and sys.argv[2] == 'login' else '已取消账号操作并恢复原登录状态。'})
        sys.exit(1 if pending else 130)
    except Error as error:
        emit({'type': 'error', 'message': str(error)[:500]})
        sys.exit(1)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        emit({'type': 'error', 'message': '本机账号操作失败，请检查 CLI、钥匙串和恢复状态后重试。'})
        sys.exit(1)
