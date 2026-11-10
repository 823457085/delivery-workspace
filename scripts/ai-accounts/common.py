"""Shared, local-only account storage. Credentials never enter the JSONL protocol."""
import contextlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'cursor-accounts'))
from cursor_accounts import Error, Keychain, delete_saved_account, keychain_json, login_resources, read_json, write_json, valid_name


def active_cli_pids(provider):
    commands = {}
    for line in subprocess.check_output(['/bin/ps', '-axo', 'pid=,args='], text=True, errors='replace').splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2:
            try:
                commands[int(fields[0])] = shlex.split(fields[1])
            except ValueError:
                pass
    found = []
    for line in subprocess.check_output(['/bin/ps', '-axo', 'pid=,comm='], text=True, errors='replace').splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        pid, command = int(fields[0]), fields[1]
        name = Path(command).name.lower()
        args = commands.get(pid, [])
        matches = name in (provider, provider + '.exe')
        if provider == 'claude':
            matches |= any('/@anthropic-ai/claude-code/' in arg for arg in args)
        elif provider == 'codex':
            matches |= any('/@openai/codex/' in arg for arg in args)
            # ponytail: app-server/exec-server are long-lived supervisors; the
            # Delivery runtime maintenance lock remains the active-turn guard.
            if matches and (('app-server' in args and not {'exec', 'resume'} & set(args))
                            or 'exec-server' in args):
                matches = False
        if matches and pid != os.getpid():
            found.append(pid)
    return found


class Manager:
    def __init__(self, adapter, keychain=None, data=None, login_runner=None):
        self.adapter = adapter
        self.keys = keychain or Keychain()
        self.data = data or Path.home() / '.local/share/delivery-ai-accounts' / adapter.provider
        self.service = 'local.delivery-ai-accounts.' + adapter.provider
        self.login_runner = login_runner
        self.db = read_json(self.data / 'accounts.json', {'accounts': {}, 'pending': False})

    def commit(self):
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.data.chmod(0o700)
        write_json(self.data / 'accounts.json', self.db)

    def stored(self, name):
        value = self.keys.get(self.service, name)
        if value is None:
            raise Error('未找到账号：' + name)
        return keychain_json(value)

    def save_snapshot(self, name, snapshot):
        metadata = self.account_metadata(snapshot)
        matches = [slot for slot, info in self.db['accounts'].items()
                   if (info.get('identity') or self.adapter.identity(self.stored(slot)).get('key')) == metadata['identity']]
        if name not in self.db['accounts'] and matches:
            name = matches[-1]
        self.keys.put(self.service, name, json.dumps(snapshot, ensure_ascii=False))
        self.db['accounts'][name] = metadata
        for slot in matches:
            if slot != name:
                del self.db['accounts'][slot]
        self.commit()
        return name

    def account_metadata(self, snapshot):
        info = self.adapter.identity(snapshot)
        if not info.get('key'):
            raise Error('无法确认当前账号身份，请先完成官方登录。')
        account = (snapshot.get('config') or {}).get('oauthAccount') or {}
        display_name = next((value for value in (info.get('displayName'), account.get('displayName'),
                                                account.get('accountName')) if isinstance(value, str) and value), '')
        return {'email': info.get('email', ''), 'team': info.get('team', ''),
                'displayName': display_name, 'identity': info['key']}

    def deduplicate(self):
        self.check_pending()
        accounts, identities, removed = {}, {}, []
        for name in self.db['accounts']:
            metadata = self.account_metadata(self.stored(name))
            previous = identities.get(metadata['identity'])
            if previous is not None:
                del accounts[previous]
                removed.append(previous)
            accounts[name] = metadata
            identities[metadata['identity']] = name
        self.db['accounts'] = accounts
        self.commit()
        return removed

    def check_pending(self):
        if self.db.get('pending'):
            raise Error('上次账号操作被中断，请先恢复上次账号。')

    def save(self, name):
        self.check_pending()
        snap = self.adapter.validate()
        if name in self.db['accounts'] and not self.same_identity(snap, self.stored(name)):
            raise Error('这个名称已属于另一个账号，请换一个名称。')
        self.save_snapshot(name, snap)

    def delete(self, name):
        delete_saved_account(self, self.service, name)

    def same_identity(self, left, right):
        a, b = self.adapter.identity(left), self.adapter.identity(right)
        return bool(a.get('key')) and a.get('key') == b.get('key')

    @contextlib.contextmanager
    def transaction(self, target_name=None):
        self.check_pending()
        # 不再以本机 CLI 进程阻止切换：已运行的会话继续使用原凭据，重启后生效；
        # Delivery 自身任务由 runtime 的 withProviderMaintenance 拦截。
        before = self.adapter.snapshot()
        # Preserve tokens renewed by the official CLI before switching away.
        names = list(self.db['accounts'])
        if target_name in names:
            names.remove(target_name)
            names.insert(0, target_name)
        for name in names:
            if name not in self.db['accounts']:
                continue
            if self.same_identity(before, self.stored(name)):
                self.save_snapshot(name, before)
        self.keys.put(self.service, '@previous', json.dumps(before, ensure_ascii=False))
        self.db['pending'] = True
        self.commit()
        try:
            yield
        except BaseException:
            self.adapter.restore(before)
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
            target = self.stored(name)
            self.adapter.restore(target)
            current = self.adapter.validate()
            if not self.same_identity(current, target):
                raise Error('账号身份不一致，已尝试恢复原账号。')
            self.save_snapshot(name, current)

    def login(self, name):
        self.check_pending()
        expected = self.stored(name) if name in self.db['accounts'] else None
        # Adding a profile must never replace credentials used by an active task.
        with self.adapter.isolated_login() as staged:
            if self.login_runner(staged):
                raise Error('登录未完成，当前账号未改变。')
            snap = staged.validate()
            if expected is not None and not self.same_identity(snap, expected):
                raise Error('登录账号与已有名称不一致，请用新名称添加。')
        return self.save_snapshot(name, snap)

    def restore(self):
        previous = self.stored('@previous')
        self.db['pending'] = True
        self.commit()
        self.adapter.restore(previous)
        self.db['pending'] = False
        self.commit()
