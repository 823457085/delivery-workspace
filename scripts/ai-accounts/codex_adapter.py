"""Codex ChatGPT accounts using its official file credential store."""
import base64
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile

from common import Error, active_cli_pids, login_resources, read_json, write_json


class CodexAdapter:
    provider = 'codex'
    label = 'Codex'

    def __init__(self, home=None, env=None):
        self.env = dict(os.environ if env is None else env)
        self.home = Path(home or Path.home())
        self.config_home = Path(self.env.get('CODEX_HOME') or self.home / '.codex').expanduser()
        self.auth = self.config_home / 'auth.json'

    def command(self):
        explicit = self.env.get('DELIVERY_CODEX_BIN')
        choices = [explicit] if explicit else [
                   str(self.home / 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'),
                   '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
                   shutil.which('codex')]
        for path in choices:
            if path and Path(path).is_file() and os.access(path, os.X_OK):
                return [path]
        raise Error('未找到 Codex CLI，请先安装官方 CLI。')

    def check_environment(self):
        self.command()
        conflicts = [key for key in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
                                     'CODEX_AUTH_TOKEN', 'CHATGPT_ACCESS_TOKEN') if self.env.get(key)]
        if conflicts:
            raise Error('环境变量覆盖了 Codex 官方登录配置，请先移除：' + ', '.join(conflicts))
        config = self.config_home / 'config.toml'
        text = config.read_text() if config.exists() else ''
        # Refuse alternate stores/providers rather than write an unused auth.json.
        for key, allowed in (('cli_auth_credentials_store', ('file',)),
                             ('model_provider', ('openai',)),
                             ('forced_login_method', ('chatgpt',))):
            values = re.findall(r'^\s*' + key + r'\s*=\s*["\']([^"\']+)["\']', text, re.M)
            if any(value not in allowed for value in values):
                raise Error('当前 Codex 配置 %s 不支持本机账号切换。' % key)

    def child_env(self):
        env = dict(self.env)
        for key in ('CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_APP_TOOLS_PIPE_PATH',
                    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_PERMISSION_PROFILE'):
            env.pop(key, None)
        env.update(CODEX_HOME=str(self.config_home), NO_OPEN_BROWSER='1', BROWSER='/usr/bin/true', TERM='dumb')
        return env

    def login_args(self):
        return ['login']

    @contextlib.contextmanager
    def isolated_login(self):
        self.check_environment()
        command = self.command()[0]
        # Official login may stop an older callback server on this fixed port.
        # Do not disturb a login started outside this account manager.
        try:
            with socket.create_connection(('127.0.0.1', 1455), timeout=0.25):
                raise Error('已有 Codex 登录进行中，请完成后重试。')
        except ConnectionRefusedError:
            pass
        except OSError:
            raise Error('无法确认 Codex 登录端口是否空闲，请稍后重试。') from None
        with login_resources() as resources:
            directory = resources.enter_context(tempfile.TemporaryDirectory(prefix='delivery-codex-login-'))
            config_home = Path(directory)
            config_home.chmod(0o700)
            config = self.config_home / 'config.toml'
            if config.exists():
                shutil.copyfile(config, config_home / 'config.toml')
                (config_home / 'config.toml').chmod(0o600)
            env = dict(self.env, CODEX_HOME=str(config_home), DELIVERY_CODEX_BIN=command)
            staged = CodexAdapter(home=self.home, env=env)
            staged.login_cwd = config_home
            staged.check_environment()
            yield staged

    def active_pids(self):
        return active_cli_pids(self.provider)

    def snapshot(self):
        value = read_json(self.auth, None)
        if value is not None and not isinstance(value, dict):
            raise Error('Codex 本地认证文件格式不支持。')
        return {'auth': value}

    def restore(self, snapshot):
        self.config_home.mkdir(parents=True, exist_ok=True, mode=0o700)
        value = snapshot.get('auth')
        if value is None:
            self.auth.unlink(missing_ok=True)
        elif isinstance(value, dict):
            write_json(self.auth, value)
        else:
            raise Error('Codex 账号备份格式不支持。')

    def identity(self, snapshot):
        auth = snapshot.get('auth') or {}
        tokens = auth.get('tokens') or {}
        claims = {}
        try:
            part = tokens.get('id_token', '').split('.')[1]
            claims = json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
        except (ValueError, IndexError, TypeError):
            pass
        if not isinstance(claims, dict):
            claims = {}
        profile = claims.get('https://api.openai.com/profile') or {}
        info = claims.get('https://api.openai.com/auth') or {}
        email = claims.get('email') or (profile.get('email') if isinstance(profile, dict) else '') or ''
        account = tokens.get('account_id') or (info.get('chatgpt_account_id') if isinstance(info, dict) else '') or ''
        user = claims.get('sub') or email
        key = str(user) + '|' + str(account) if user and account else ''
        plan = info.get('chatgpt_plan_type', '') if isinstance(info, dict) else ''
        return {'email': str(email), 'team': str(plan), 'key': key}

    def current(self):
        info = self.identity(self.snapshot())
        return {'email': info['email'], 'team': info['team'], 'verified': False,
                'identity': info['key']} if info['key'] else None

    def validate(self):
        before = self.snapshot()
        auth = before.get('auth') or {}
        tokens = auth.get('tokens') or {}
        if auth.get('OPENAI_API_KEY') or auth.get('auth_mode') not in (None, 'chatgpt'):
            raise Error('当前 Codex 使用 API Key；此入口管理 ChatGPT 官方登录账号。')
        if not tokens.get('access_token') or not tokens.get('refresh_token') or not self.identity(before)['key']:
            raise Error('未找到可保存的 Codex ChatGPT 登录，请先完成官方登录。')
        result = subprocess.run(self.command() + ['login', 'status'], env=self.child_env(),
                                cwd=getattr(self, 'login_cwd', self.home),
                                capture_output=True, text=True, timeout=20)
        if result.returncode:
            raise Error('Codex CLI 未确认本地登录状态，请重新登录。')
        after = self.snapshot()
        if before != after:
            raise Error('Codex 登录凭据在检查期间变化，请结束其他登录后重试。')
        return after
