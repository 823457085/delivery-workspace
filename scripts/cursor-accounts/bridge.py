#!/usr/bin/python3
"""JSONL interface for Delivery; no credential value crosses this interface."""
import contextlib
from datetime import datetime, timezone
import fcntl
import io
import json
import os
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

import cursor_accounts as accounts

OUTPUT = sys.stdout


def emit(event):
    OUTPUT.write(json.dumps(event, ensure_ascii=False) + '\n')
    OUTPUT.flush()


def official_login_url(text):
    for candidate in re.findall(r'https://[^\s\x1b<>"\']+', text):
        try:
            url = urlsplit(candidate)
            if (url.scheme == 'https' and url.netloc == 'cursor.com' and
                    url.path == '/loginDeepControl' and url.query and not url.fragment):
                return candidate
        except ValueError:
            pass
    return None


def stop_login(child, isolated=False):
    if child.poll() is not None:
        return
    # A repeated cancellation must not start rollback while the child still writes.
    previous_handlers = {number: signal.signal(number, signal.SIG_IGN)
                         for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        child.send_signal(signal.SIGINT)
        try:
            child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            child.terminate()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                # Do not roll back while an OAuth child may still write credentials.
                emit({'type': 'error', 'message': '官方登录进程尚未退出，请结束它后重试；当前账号未改变。' if isolated else
                      '官方登录进程尚未退出，已保留恢复标记。请结束登录后恢复账号。'})
                os._exit(1)
    finally:
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)


def login_runner(command=None, env=None):
    isolated = env is not None
    env = dict(os.environ if env is None else env, NO_OPEN_BROWSER='1', TERM='dumb')
    child = subprocess.Popen((command or accounts.cursor_command()) + ['login'], env=env,
                             cwd=env['HOME'] if isolated else None,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT)
    text, sent_url = '', None
    deadline = time.monotonic() + 600
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while child.poll() is None or selector.get_map():
                if time.monotonic() > deadline:
                    raise accounts.Error('网页登录等待超时，当前账号未改变。' if isolated else '网页登录等待超时，已尝试恢复原账号。')
                for key, _ in selector.select(timeout=0.2):
                    chunk = os.read(key.fd, 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    text = (text + chunk.decode('utf-8', errors='replace'))[-16_000:]
                    # Wait for the URL's terminating whitespace before publishing it.
                    complete = text[:max(text.rfind('\n'), text.rfind('\r')) + 1]
                    url = official_login_url(complete)
                    if url and url != sent_url:
                        emit({'type': 'login', 'url': url})
                        sent_url = url
            return child.wait()
    finally:
        stop_login(child, isolated=isolated)
        if child.stdout:
            child.stdout.close()


def add_account(manager, name):
    """Official login in a private file store; never replace the active Keychain."""
    manager.check_pending()
    expected = manager.stored(name) if name in manager.db.get('accounts', {}) else None
    command = accounts.cursor_command()
    with accounts.login_resources() as resources:
        directory = resources.enter_context(tempfile.TemporaryDirectory(prefix='delivery-cursor-login-'))
        config_home = Path(directory) / '.cursor'
        config_home.mkdir(mode=0o700)
        env = dict(os.environ, HOME=directory, CURSOR_CONFIG_DIR=str(config_home), CURSOR_DATA_DIR=str(config_home),
                   AGENT_CLI_CREDENTIAL_STORE='file', NO_OPEN_BROWSER='1',
                   BROWSER='/usr/bin/true', TERM='dumb', CURSOR_AGENT_DISABLE_DEBUG_LOG='1')
        if login_runner(command, env):
            raise accounts.Error('登录未完成，当前 Cursor 账号未改变。')
        status = subprocess.run(command + ['status', '--format', 'json'], env=env, cwd=directory,
                                capture_output=True, text=True, timeout=35)
        try:
            value = json.loads(status.stdout)
        except ValueError:
            raise accounts.Error('无法确认新账号登录状态，当前 Cursor 账号未改变。') from None
        info = value.get('userInfo') if isinstance(value, dict) else None
        if status.returncode or not isinstance(info, dict) or not value.get('isAuthenticated') or not info.get('email'):
            raise accounts.Error('未能确认新账号登录，请完成官方网页登录后重试。')
        credentials = accounts.read_json(config_home / 'auth.json', {})
        if not isinstance(credentials, dict) or not credentials.get('accessToken'):
            raise accounts.Error('未找到独立登录凭据，当前 Cursor 账号未改变。')
        config = accounts.read_json(config_home / 'cli-config.json', {})
        cached = config.get('authInfo', {}) if isinstance(config, dict) else {}
        if not isinstance(cached, dict):
            cached = {}
        auth_info = {key: value for key, value in {**cached, **info}.items() if key in accounts.AUTH_FIELDS}
        snap = {'credentials': {service: credentials.get(field) for service, field in (
                    ('cursor-access-token', 'accessToken'), ('cursor-refresh-token', 'refreshToken'),
                    ('cursor-api-key', 'apiKey'))},
                'authInfo': auth_info}
        if expected is not None and accounts.account_identity(snap) != accounts.account_identity(expected):
            raise accounts.Error('登录账号或团队与已有账号不一致，请添加为新账号。')
    return manager.save_snapshot(name, snap)


def inspect():
    manager = accounts.Manager()
    stored = manager.db.get('accounts', {})
    result = {'type': 'snapshot', 'available': sys.platform == 'darwin',
              'accounts': [{'name': name, 'email': value.get('email', ''), 'team': value.get('team', ''),
                            'displayName': value.get('displayName', ''), 'identity': value.get('identity', '')}
                           for name, value in stored.items()],
              'current': None, 'pendingRecovery': bool(manager.db.get('pending')),
              'activePids': [], 'blockedReason': '',
              'checkedAt': datetime.now(timezone.utc).isoformat()}
    try:
        accounts.check_environment()
        accounts.cursor_command()
        if not result['available']:
            raise accounts.Error('Cursor 账号管理目前仅支持 macOS。')
        result['activePids'] = [int(pid) for pid in accounts.active_agents()]
        # Cursor status does not modify the account selection. Never read snapshots here.
        info = manager.verify()
        result['current'] = {'email': info['email'], 'team': info.get('teamName', ''), 'verified': True,
                             'displayName': info.get('displayName', ''),
                             'identity': accounts.account_identity({'authInfo': info})}
    except (accounts.Error, OSError, ValueError, subprocess.TimeoutExpired) as error:
        cached = accounts.read_json(accounts.CONFIG, {}).get('authInfo', {})
        if cached.get('email'):
            result['current'] = {'email': cached['email'], 'team': cached.get('teamName', ''), 'verified': False,
                                 'displayName': cached.get('displayName', ''),
                                 'identity': accounts.account_identity({'authInfo': cached})}
        result['blockedReason'] = str(error)[:500]
        if isinstance(error, accounts.Error) and ('环境' in str(error) or '变量' in str(error) or '未找到' in str(error)):
            result['available'] = False
    if result['activePids']:
        result['blockedReason'] = '仍有 Cursor Agent 或登录进程运行（PID: %s）。可以保存或添加账号；切换、恢复需先结束相关会话。' % ', '.join(map(str, result['activePids']))
    if result['pendingRecovery']:
        result['blockedReason'] = '上次账号操作被中断，请先恢复原账号。'
    emit(result)


def interrupt(_signal, _frame):
    raise KeyboardInterrupt


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('inspect', 'save', 'login', 'use', 'restore', 'delete'):
        raise accounts.Error('账号操作不受支持。')
    action = sys.argv[1]
    if action == 'inspect':
        inspect()
        return 0
    accounts.check_environment()
    if sys.platform != 'darwin':
        raise accounts.Error('Cursor 账号管理目前仅支持 macOS。')
    name = accounts.valid_name(sys.argv[2]) if action != 'restore' and len(sys.argv) == 3 else None
    if action != 'restore' and name is None:
        raise accounts.Error('请提供账号名称。')
    accounts.DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    accounts.DATA.chmod(0o700)
    saved_name = None
    with (accounts.DATA / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise accounts.Error('另一个账号管理操作正在运行，请先完成或退出它。') from None
        manager = accounts.Manager(login_runner=login_runner)
        with contextlib.redirect_stdout(io.StringIO()):
            if action == 'login':
                saved_name = accounts.valid_name(add_account(manager, name))
            elif name:
                getattr(manager, action)(name)
            else:
                manager.restore()
    messages = {'save': '已保存当前 Cursor 账号', 'login': '已保存 Cursor 账号，当前使用的账号未改变',
                'use': '已切换 Cursor 账号', 'restore': '已恢复上次操作前的本地账号',
                'delete': '已删除 Cursor 已保存账号'}
    emit({'type': 'result', 'message': messages[action],
          **({'accountName': saved_name} if saved_name else {})})
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        pending = accounts.read_json(accounts.DATA / 'accounts.json', {}).get('pending')
        emit({'type': 'error' if pending else 'result', 'message':
              '取消后仍有待恢复的账号，请先恢复原账号。' if pending else
              '已取消添加，当前 Cursor 账号未改变。' if len(sys.argv) > 1 and sys.argv[1] == 'login' else
              '已取消账号操作，原账号恢复流程已完成。'})
        sys.exit(1 if pending else 130)
    except (accounts.Error, OSError, ValueError, subprocess.TimeoutExpired) as error:
        emit({'type': 'error', 'message': str(error)[:500]})
        sys.exit(1)
