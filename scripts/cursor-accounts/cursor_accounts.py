#!/usr/bin/python3
"""macOS Cursor Agent account switcher. Secrets stay in the login Keychain."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile

from keychain_native import put_password

DATA = Path.home() / '.local/share/cursor-accounts'
CONFIG = Path.home() / '.cursor/cli-config.json'
SERVICE = 'local.cursor-accounts.profile'
TOKEN_SERVICES = ('cursor-access-token', 'cursor-refresh-token', 'cursor-api-key')
AUTH_FIELDS = ('authId', 'userId', 'email', 'displayName', 'teamId', 'teamName',
               'organizationId', 'activeTeamId')


class Error(Exception):
    pass


@contextlib.contextmanager
def login_resources():
    resources = contextlib.ExitStack()
    try:
        yield resources
    finally:
        handlers = {}
        try:
            for signum in (signal.SIGINT, signal.SIGTERM):
                handlers[signum] = signal.signal(signum, signal.SIG_IGN)
            resources.close()
        finally:
            for signum, handler in handlers.items():
                signal.signal(signum, handler)


class Keychain:
    """Keep credentials in Keychain and out of process arguments and logs."""
    def get(self, service, account):
        result = subprocess.run(['/usr/bin/security', 'find-generic-password',
                                 '-s', service, '-a', account, '-w'],
                                capture_output=True, text=True, timeout=30)
        if result.returncode == 44:  # errSecItemNotFound
            return None
        if result.returncode:
            raise Error('钥匙串读取失败（代码 %s）；请解锁登录钥匙串并允许访问。' % result.returncode)
        return result.stdout.rstrip('\n')

    def put(self, service, account, value):
        if value is None:
            result = subprocess.run(['/usr/bin/security', 'delete-generic-password',
                                     '-s', service, '-a', account], capture_output=True, timeout=30)
            if result.returncode == 44:
                return
        else:
            if any(char in text for text in (service, account, value) for char in ('\n', '\r', '\0')):
                raise Error('凭据包含不支持的控制字符。')
            status = put_password(service, account, value)
            if status:
                raise Error('钥匙串写入失败（代码 %s）；原账号备份仍保留。' % status)
            return
        if result.returncode:
            raise Error('钥匙串写入失败（代码 %s）；原账号备份仍保留。' % result.returncode)


def keychain_json(value):
    """security -w hex-encodes non-ASCII data; decode only JSON objects here."""
    try:
        if not isinstance(value, str):
            raise ValueError
        try:
            result = json.loads(value)
        except json.JSONDecodeError:
            if not re.fullmatch(r'(?:[0-9A-Fa-f]{2})+', value):
                raise ValueError from None
            result = json.loads(bytes.fromhex(value).decode('utf-8'))
        if not isinstance(result, dict):
            raise ValueError
        return result
    except (ValueError, TypeError):
        raise Error('账号凭据格式无法读取，请重新登录该账号。') from None


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def cursor_command():
    agent = Path.home() / '.local/bin/cursor-agent'
    if agent.is_file():
        return [str(agent)]
    cursor = shutil.which('cursor')
    if cursor:
        return [cursor, 'agent']
    raise Error('未找到 Cursor Agent，请先安装官方 CLI。')


def check_environment():
    conflicts = [key for key in ('CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN', 'CURSOR_CONFIG_DIR',
                                'XDG_CONFIG_HOME', 'CURSOR_API_ENDPOINT')
                 if os.environ.get(key)]
    if os.environ.get('AGENT_CLI_CREDENTIAL_STORE', 'default') != 'default':
        conflicts.append('AGENT_CLI_CREDENTIAL_STORE')
    if conflicts:
        raise Error('当前终端覆盖了官方登录配置，请在未设置这些变量的终端使用：' + ', '.join(conflicts))


def active_agents():
    output = subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True, errors='replace')
    commands = subprocess.check_output(['/bin/ps', '-axo', 'pid=,args='], text=True, errors='replace')
    args_by_pid = {}
    for line in commands.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2:
            args_by_pid[fields[0]] = fields[1]
    found = []
    for line in output.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        pid, comm = fields
        try:
            args = shlex.split(args_by_pid.get(pid, ''))
        except ValueError:
            args = []
        name = Path(comm).name.lower()
        is_agent = name in ('cursor-agent', 'cursor agent')
        is_agent |= any('/cursor-agent/versions/' in arg for arg in args[:2])
        is_agent |= bool(args and Path(args[0]).name == 'cursor' and args[1:2] == ['agent'])
        if is_agent and int(pid) != os.getpid():
            found.append(pid)
    return found


def ensure_idle():
    pids = active_agents()
    if pids:
        raise Error('仍有 Cursor Agent 进程（PID: %s）。请先结束任务，再切换或添加账号。' % ', '.join(pids))


def account_identity(snapshot):
    info = snapshot.get('authInfo', {})
    if info.get('userId'):
        user = ['userId', str(info['userId'])]
    elif info.get('authId'):
        user = ['authId', str(info['authId'])]
    elif info.get('email'):
        user = ['email', info['email'].casefold()]
    else:
        return ''
    team = info.get('activeTeamId')
    if team is None:
        team = info.get('teamId')
    team = ['teamId', str(team)] if team is not None else ['teamName', info.get('teamName', '')]
    organization = info.get('organizationId')
    return json.dumps([user, team, ['organizationId', str(organization) if organization is not None else '']],
                      ensure_ascii=False, separators=(',', ':'))


def account_metadata(snapshot):
    info = snapshot.get('authInfo', {})
    identity = account_identity(snapshot)
    if not identity:
        raise Error('无法确认当前账号身份，请先完成官方登录。')
    return {'email': info.get('email', ''), 'team': info.get('teamName', ''),
            'displayName': info.get('displayName') if isinstance(info.get('displayName'), str) else '',
            'identity': identity}


class Manager:
    def __init__(self, keychain=None, login_runner=None):
        self.keys = keychain or Keychain()
        self.login_runner = login_runner
        self.db = read_json(DATA / 'accounts.json', {'accounts': {}, 'pending': False})

    def commit(self):
        write_json(DATA / 'accounts.json', self.db)

    def snapshot(self):
        config = read_json(CONFIG, {})
        return {'credentials': {s: self.keys.get(s, 'cursor-user') for s in TOKEN_SERVICES},
                'authInfo': {k: v for k, v in config.get('authInfo', {}).items() if k in AUTH_FIELDS}}

    def restore_snapshot(self, snapshot):
        for service in TOKEN_SERVICES:
            self.keys.put(service, 'cursor-user', snapshot['credentials'].get(service))
        self.write_auth_info(snapshot.get('authInfo', {}))

    def write_auth_info(self, info):
        config = read_json(CONFIG, {})
        config['authInfo'] = info
        config.pop('privacyCache', None)
        write_json(CONFIG, config)

    def stored(self, name):
        value = self.keys.get(SERVICE, name)
        if value is None:
            raise Error('未找到账号：' + name)
        snapshot = keychain_json(value)
        if not isinstance(snapshot.get('credentials'), dict) or not isinstance(snapshot.get('authInfo'), dict):
            raise Error('账号凭据格式无法读取，请重新登录该账号。')
        return snapshot

    def save_snapshot(self, name, snapshot):
        metadata = account_metadata(snapshot)
        matches = [slot for slot, info in self.db['accounts'].items()
                   if (info.get('identity') or account_identity(self.stored(slot))) == metadata['identity']]
        if name not in self.db['accounts'] and matches:
            name = matches[-1]
        self.keys.put(SERVICE, name, json.dumps(snapshot, ensure_ascii=False))
        self.db['accounts'][name] = metadata
        for slot in matches:
            if slot != name:
                del self.db['accounts'][slot]
        self.commit()
        return name

    def deduplicate(self):
        self.check_pending()
        accounts, identities, removed = {}, {}, []
        for name in self.db['accounts']:
            metadata = account_metadata(self.stored(name))
            previous = identities.get(metadata['identity'])
            if previous is not None:
                del accounts[previous]
                removed.append(previous)
            accounts[name] = metadata
            identities[metadata['identity']] = name
        self.db['accounts'] = accounts
        self.commit()
        return removed

    def verify(self):
        result = subprocess.run(cursor_command() + ['status', '--format', 'json'],
                                capture_output=True, text=True, timeout=35)
        try:
            status = json.loads(result.stdout)
        except ValueError:
            raise Error('Cursor 登录状态无法读取，请先运行 cursor agent status。') from None
        if result.returncode or not status.get('isAuthenticated') or not (status.get('userInfo') or {}).get('email'):
            raise Error('未能确认有效登录，请完成网页登录或检查网络后再试。')
        return status['userInfo']

    def verified_snapshot(self):
        before = self.snapshot()
        info = self.verify()
        snap = self.snapshot()
        same_api_key = before['credentials'].get('cursor-api-key') and (
            before['credentials']['cursor-api-key'] == snap['credentials'].get('cursor-api-key'))
        if before['credentials'] != snap['credentials'] and not same_api_key:
            raise Error('登录凭据在检查期间发生变化，请等其他登录操作完成后重试。')
        snap['authInfo'].update({k: v for k, v in info.items() if k in AUTH_FIELDS})
        if not snap['credentials'].get('cursor-access-token'):
            raise Error('当前没有可保存的 Cursor 浏览器登录凭据。')
        return snap

    def save(self, name):
        self.check_pending()
        snap = self.verified_snapshot()
        if name in self.db['accounts'] and account_identity(snap) != account_identity(self.stored(name)):
            raise Error('这个名称已属于另一个账号，请换一个名称。')
        self.save_snapshot(name, snap)
        print('已保存 %s：%s' % (name, snap['authInfo'].get('email', '')))

    def delete(self, name):
        delete_saved_account(self, SERVICE, name)

    def check_pending(self):
        if self.db.get('pending'):
            raise Error('上次切换被中断，请先执行 cursor-accounts restore 恢复原账号。')

    @contextlib.contextmanager
    def transaction(self, target_name=None):
        self.check_pending()
        ensure_idle()
        before = self.snapshot()
        # A cached email is not proof of identity. Match an existing secret and team.
        names = list(self.db['accounts'])
        if target_name in names:
            names.remove(target_name)
            names.insert(0, target_name)
        for name in names:
            if name not in self.db['accounts']:
                continue
            saved = self.stored(name)
            same_secret = any(before['credentials'].get(key) and
                              before['credentials'][key] == saved['credentials'].get(key)
                              for key in ('cursor-refresh-token', 'cursor-api-key'))
            same_team = before['authInfo'].get('activeTeamId') == saved['authInfo'].get('activeTeamId')
            if same_secret and same_team:
                self.save_snapshot(name, dict(saved, credentials=before['credentials']))
        self.keys.put(SERVICE, '@previous', json.dumps(before, ensure_ascii=False))
        self.db['pending'] = True
        self.commit()
        try:
            yield
        except BaseException:
            self.restore_snapshot(before)
            self.db['pending'] = False
            self.commit()
            raise
        else:
            self.db['pending'] = False
            self.commit()

    def use(self, name):
        if name not in self.db['accounts']:
            raise Error('未找到账号：' + name)
        with self.transaction(name):
            target = self.stored(name)  # Read after refreshing the outgoing slot.
            self.restore_snapshot(target)
            current = self.verified_snapshot()
            if current['authInfo'].get('email') != target['authInfo'].get('email'):
                raise Error('账号校验不一致，已尝试恢复原账号。')
            team = target['authInfo'].get('activeTeamId')
            if team is not None and str(team) != str(current['authInfo'].get('teamId')):
                raise Error('团队校验不一致，已尝试恢复原账号。')
            self.write_auth_info(current['authInfo'])
            self.save_snapshot(name, current)
        print('已切换到 %s：%s' % (name, current['authInfo'].get('email', '')))

    def login(self, name):
        self.check_pending()
        expected = self.stored(name) if name in self.db['accounts'] else None
        with self.transaction():
            self.keys.put('cursor-api-key', 'cursor-user', None)
            print('请在官方 Cursor 登录页选择新账号；成功后会自动保存。', flush=True)
            code = self.login_runner() if self.login_runner else subprocess.call(cursor_command() + ['login'])
            if code:
                raise Error('登录未完成，已尝试恢复原账号。')
            snap = self.verified_snapshot()
            if expected is not None and account_identity(snap) != account_identity(expected):
                raise Error('登录账号与已有名称不一致，请用新名称添加。')
            self.write_auth_info(snap['authInfo'])
            self.save_snapshot(name, snap)
        print('已添加并切换到 %s：%s' % (name, snap['authInfo'].get('email', '')))

    def restore(self):
        ensure_idle()
        previous = self.stored('@previous')
        self.db['pending'] = True
        self.commit()
        self.restore_snapshot(previous)
        self.db['pending'] = False
        self.commit()
        print('已恢复上次操作前的本地登录凭据。')

    def list(self):
        print('\n已保存的 Cursor Agent 账号：')
        for name, info in self.db['accounts'].items():
            print('  %-16s %s  %s' % (name, info.get('email', ''), info.get('team', '')))
        if not self.db['accounts']:
            print('  暂无。选择“保存当前账号”开始。')
        if self.db.get('pending'):
            print('  上次操作被中断：请先执行 restore。')


def valid_name(name):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,39}', name):
        raise Error('账号名称请使用 1–40 位英文字母、数字、下划线或短横线。')
    return name


def delete_saved_account(manager, service, name):
    """Called under the account store lock. Only the named saved slot is removed."""
    manager.check_pending()
    name = valid_name(name)
    accounts = manager.db['accounts']
    if name not in accounts:
        raise Error('未找到已保存账号：' + name)
    credential = manager.keys.get(service, name)
    manager.keys.put(service, name, None)
    metadata = accounts.pop(name)
    try:
        manager.commit()
    except BaseException:
        accounts[name] = metadata
        if credential is not None:
            manager.keys.put(service, name, credential)
        raise


def menu(manager):
    while True:
        manager.list()
        print('\n1 保存当前账号  2 添加并登录账号  3 切换账号  4 查看当前登录  5 恢复上次账号  0 退出')
        choice = input('请选择：').strip()
        try:
            if choice == '0':
                return
            if choice == '4':
                subprocess.call(cursor_command() + ['status'])
            elif choice == '5':
                manager.restore()
            elif choice in ('1', '2', '3'):
                name = valid_name(input('账号名称（例如 work / personal）：').strip())
                {'1': manager.save, '2': manager.login, '3': manager.use}[choice](name)
        except (Error, subprocess.TimeoutExpired) as error:
            print('操作未完成：' + str(error))


def main():
    parser = argparse.ArgumentParser(description='Cursor Agent 多账号管理（macOS 钥匙串）')
    sub = parser.add_subparsers(dest='command')
    for command, help_text in (('save', '保存当前登录'), ('login', '网页登录并添加账号'), ('use', '切换已保存账号')):
        sub.add_parser(command, help=help_text).add_argument('name')
    for command in ('list', 'status', 'restore'):
        sub.add_parser(command)
    args = parser.parse_args()
    check_environment()
    if sys.platform != 'darwin':
        raise Error('这个工具仅支持 macOS。')
    if hasattr(args, 'name'):
        valid_name(args.name)
    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)
    DATA.chmod(0o700)
    with (DATA / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Error('另一个账号管理操作正在运行，请先退出它。') from None
        manager = Manager()
        if args.command == 'status':
            return subprocess.call(cursor_command() + ['status'])
        if args.command is None:
            menu(manager)
        elif hasattr(args, 'name'):
            getattr(manager, args.command)(args.name)
        else:
            getattr(manager, args.command)()
    return 0


if __name__ == '__main__':
    os.umask(0o077)
    try:
        sys.exit(main())
    except (Error, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        print('操作未完成：' + str(exc), file=sys.stderr)
        sys.exit(1)
    except (KeyboardInterrupt, EOFError):
        print('\n已退出。', file=sys.stderr)
        sys.exit(130)
