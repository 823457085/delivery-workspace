"""Read a saved ChatGPT account's quota without switching the execution account."""
import fcntl
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import tempfile
import time

from codex_adapter import CodexAdapter
from common import Error, Manager, valid_name


def query_usage(adapter):
    child = subprocess.Popen(adapter.command() + ['app-server', '--stdio'],
                             env=adapter.child_env(), cwd=adapter.config_home,
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    def send(value):
        child.stdin.write((json.dumps(value) + '\n').encode())
        child.stdin.flush()
    try:
        send({'id': 1, 'method': 'initialize', 'params': {
            'clientInfo': {'name': 'delivery-quota', 'version': '0.1.0'}, 'capabilities': {}}})
        deadline, buffered, size = time.monotonic() + 12, b'', 0
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            while time.monotonic() < deadline:
                if not selector.select(0.2):
                    continue
                chunk = os.read(child.stdout.fileno(), 4096)
                if not chunk:
                    raise Error('额度查询进程已退出')
                buffered += chunk
                size += len(chunk)
                if size > 1_000_000:
                    raise Error('额度响应过大')
                while b'\n' in buffered:
                    line, buffered = buffered.split(b'\n', 1)
                    try:
                        message = json.loads(line)
                    except ValueError:
                        continue
                    if message.get('id') not in (1, 2, 3):
                        continue
                    if message.get('error'):
                        raise Error('已保存账号的额度读取失败，请在账号管理中重新登录')
                    if message['id'] == 1:
                        send({'method': 'initialized'})
                        send({'id': 2, 'method': 'account/read', 'params': {'refreshToken': False}})
                    elif message['id'] == 2:
                        account = (message.get('result') or {}).get('account') or {}
                        if account.get('type') != 'chatgpt':
                            raise Error('额度查询账号未使用 ChatGPT 登录')
                        send({'id': 3, 'method': 'account/rateLimits/read',
                              'params': {'excludeResetCreditDetails': True}})
                    else:
                        return message.get('result') or {}
        raise Error('额度读取超时')
    finally:
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        child.stdin.close()
        child.stdout.close()


def read_saved_usage(manager, name, query=query_usage):
    manager.check_pending()
    if name not in manager.db.get('accounts', {}):
        raise Error('未找到已配置的额度查询账号')
    original = manager.stored(name)
    identity = manager.adapter.identity(original).get('key')
    auth = original.get('auth') or {}
    if not identity or auth.get('OPENAI_API_KEY') or not (auth.get('tokens') or {}).get('access_token'):
        raise Error('额度查询账号未使用 ChatGPT 登录')
    # Only this short-lived process gets the saved login. Never write ~/.codex/auth.json.
    with tempfile.TemporaryDirectory(prefix='delivery-codex-quota-') as directory:
        env = dict(manager.adapter.env, CODEX_HOME=directory,
                   DELIVERY_CODEX_BIN=manager.adapter.command()[0])
        for key in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
                    'CODEX_AUTH_TOKEN', 'CHATGPT_ACCESS_TOKEN'):
            env.pop(key, None)
        staged = CodexAdapter(home=manager.adapter.home, env=env)
        staged.restore(original)
        try:
            result = query(staged)
        finally:
            renewed = staged.snapshot()
            if staged.identity(renewed).get('key') != identity:
                raise Error('额度查询账号身份发生变化')
            # Preserve official token rotation even if the subsequent quota request fails.
            if renewed != original:
                if manager.stored(name) != original:
                    raise Error('已保存账号发生变化，请刷新重试')
                manager.keys.put(manager.service, name, json.dumps(renewed))
        def window(value):
            return {key: value.get(key) for key in ('usedPercent', 'windowDurationMins', 'resetsAt')} if isinstance(value, dict) else None
        def credits(value):
            if not isinstance(value, dict):
                return None
            raw = value.get('balance')
            try:
                balance = float(raw) if isinstance(raw, (int, float, str)) and not isinstance(raw, bool) else None
            except ValueError:
                balance = None
            if balance is not None and (balance != balance or balance in (float('inf'), float('-inf')) or balance < 0):
                balance = None
            has_credits = value.get('hasCredits') is True
            unlimited = value.get('unlimited') is True
            if not has_credits and not unlimited and (balance is None or balance <= 0):
                return None
            return {'hasCredits': has_credits, 'unlimited': unlimited, 'balance': balance}
        def snapshot(value):
            if not isinstance(value, dict):
                return None
            normalized_credits = credits(value.get('credits'))
            return {'planType': value.get('planType'), 'primary': window(value.get('primary')),
                    'secondary': window(value.get('secondary')),
                    **({'credits': normalized_credits} if normalized_credits else {}),
                    **({'spendControlReached': True} if value.get('spendControlReached') is True else {}),
                    **({'rateLimitReachedType': value.get('rateLimitReachedType')}
                       if isinstance(value.get('rateLimitReachedType'), str) else {})}
        # Account identifiers and tokens never cross this bridge; only sanitized numeric credit status is kept.
        by_id = result.get('rateLimitsByLimitId') or {}
        return {'rateLimits': snapshot(result.get('rateLimits')),
                'rateLimitsByLimitId': {key: snapshot(value) for key, value in by_id.items()}}


def main():
    name = valid_name(sys.argv[1]) if len(sys.argv) == 2 else None
    if not name:
        raise Error('请配置额度查询账号')
    manager = Manager(CodexAdapter())
    with (manager.data / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Error('账号管理正在操作，请稍后刷新') from None
        print(json.dumps(read_saved_usage(Manager(manager.adapter), name)))


if __name__ == '__main__':
    os.umask(0o077)
    def interrupt(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    try:
        main()
    except (Error, OSError, ValueError, KeyboardInterrupt):
        # Keep credential-bearing subprocess/OS diagnostics off stdout and stderr.
        print(json.dumps({'error': '已保存账号的额度读取失败，请刷新或在账号管理中重新登录'}))
        sys.exit(1)
