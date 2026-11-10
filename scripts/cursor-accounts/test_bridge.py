"""Bridge checks with fake credentials and isolated local fixture subprocesses."""
import contextlib
import copy
import io
import json
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import bridge
from test_cursor_accounts import FakeKeychain, snapshot


OFFICIAL_URL = ('https://cursor.com/loginDeepControl?challenge=fixture-challenge'
                '&uuid=fixture-uuid&mode=login&redirectTarget=cli&supportsTeamLogin=true')
FAKE_TOKEN = 'fixture-secret-token-never-output'


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.output = io.StringIO()
        self.stack.enter_context(patch.object(bridge, 'OUTPUT', self.output))
        self.stack.enter_context(patch.object(bridge.accounts, 'DATA', self.root / 'data'))
        self.stack.enter_context(patch.object(bridge.accounts, 'CONFIG', self.root / 'config.json'))
        self.stack.enter_context(patch.object(bridge.accounts, 'Keychain',
                                            side_effect=AssertionError('Real Keychain forbidden')))
        self.stack.enter_context(patch.object(bridge.accounts, 'cursor_command',
                                            side_effect=AssertionError('Real Cursor forbidden')))

    def events(self):
        return [json.loads(line) for line in self.output.getvalue().splitlines()]

    def fixture_login(self, source):
        script = self.root / 'fake_login.py'
        script.write_text(source)
        with patch.object(bridge.accounts, 'cursor_command', return_value=[sys.executable, str(script)]):
            return bridge.login_runner()

    def test_official_login_url_whitelist(self):
        self.assertEqual(bridge.official_login_url('Login: ' + OFFICIAL_URL + '\n'), OFFICIAL_URL)
        for url in (
                'http://cursor.com/loginDeepControl?challenge=x',
                'https://cursor.com.evil.test/loginDeepControl?challenge=x',
                'https://evil.test/cursor.com/loginDeepControl?challenge=x',
                'https://cursor.com@evil.test/loginDeepControl?challenge=x',
                'https://evil.test@cursor.com/loginDeepControl?challenge=x',
                'https://cursor.com:443/loginDeepControl?challenge=x',
                'https://cursor.com/other?challenge=x',
                'https://cursor.com/loginDeepControl',
                'https://cursor.com/loginDeepControl?challenge=x#fragment',
                'https://[invalid/loginDeepControl?challenge=x'):
            with self.subTest(url=url):
                self.assertIsNone(bridge.official_login_url(url))

    def test_login_runner_only_emits_complete_official_url(self):
        source = (
            'import sys, time\n'
            'print(' + repr('Raw token: ' + FAKE_TOKEN) + ', flush=True)\n'
            'print("https://evil.test/loginDeepControl?challenge=bad", flush=True)\n'
            'sys.stdout.write(' + repr(OFFICIAL_URL[:80]) + ')\n'
            'sys.stdout.flush()\n'
            'time.sleep(0.03)\n'
            'print(' + repr(OFFICIAL_URL[80:]) + ', flush=True)\n'
            'print(' + repr(OFFICIAL_URL) + ', flush=True)\n'
            'print(' + repr('Other raw log: ' + FAKE_TOKEN) + ', file=sys.stderr)\n')
        self.assertEqual(self.fixture_login(source), 0)
        self.assertEqual(self.events(), [{'type': 'login', 'url': OFFICIAL_URL}])
        self.assertNotIn(FAKE_TOKEN, self.output.getvalue())
        self.assertNotIn('evil.test', self.output.getvalue())
        self.assertNotIn('Raw token', self.output.getvalue())

    def test_login_runner_does_not_publish_unterminated_url(self):
        self.assertEqual(self.fixture_login('import sys\nsys.stdout.write(' + repr(OFFICIAL_URL) + ')\n'), 0)
        self.assertEqual(self.events(), [])

    def test_login_runner_failed_child_does_not_expose_raw_logs(self):
        source = ('import sys\nprint(' + repr(FAKE_TOKEN) + ', file=sys.stderr)\nsys.exit(7)\n')
        self.assertEqual(self.fixture_login(source), 7)
        self.assertEqual(self.events(), [])

    def inspect_with_manager(self, manager, cached=None, pids=None):
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(bridge.accounts, 'Manager', return_value=manager))
            stack.enter_context(patch.object(bridge.accounts, 'check_environment'))
            stack.enter_context(patch.object(bridge.accounts, 'cursor_command', return_value=['fake-cursor']))
            stack.enter_context(patch.object(bridge.accounts, 'active_agents', return_value=pids or []))
            stack.enter_context(patch.object(bridge.accounts, 'read_json', return_value=cached or {}))
            stack.enter_context(patch.object(bridge.sys, 'platform', 'darwin'))
            bridge.inspect()
        return self.events()[-1]

    def test_inspect_only_emits_account_summary(self):
        manager = Mock()
        manager.db = {'accounts': {'work': {'email': 'work@example.test', 'team': 'Team',
                                            'credentials': FAKE_TOKEN}}, 'pending': False}
        manager.verify.return_value = {'email': 'work@example.test', 'teamName': 'Team',
                                       'accessToken': FAKE_TOKEN, 'refreshToken': FAKE_TOKEN}
        result = self.inspect_with_manager(manager)
        self.assertEqual(result['accounts'], [{'name': 'work', 'email': 'work@example.test', 'team': 'Team',
                                               'displayName': '', 'identity': ''}])
        self.assertEqual(result['current'], {'email': 'work@example.test', 'team': 'Team', 'verified': True,
                                             'displayName': '',
                                             'identity': bridge.accounts.account_identity({'authInfo': manager.verify.return_value})})
        self.assertTrue(result['available'])
        self.assertEqual(result['blockedReason'], '')
        manager.snapshot.assert_not_called()
        manager.stored.assert_not_called()
        self.assertNotIn(FAKE_TOKEN, self.output.getvalue())

    def test_inspect_failure_uses_unverified_cached_summary(self):
        manager = Mock()
        manager.db = {'accounts': {}, 'pending': False}
        manager.verify.side_effect = bridge.accounts.Error('网络暂不可用')
        cached = {'authInfo': {'email': 'cached@example.test', 'teamName': 'Cached team',
                               'accessToken': FAKE_TOKEN}, 'credentials': FAKE_TOKEN}
        result = self.inspect_with_manager(manager, cached=cached)
        self.assertEqual(result['current'], {'email': 'cached@example.test', 'team': 'Cached team', 'verified': False,
                                             'displayName': '',
                                             'identity': bridge.accounts.account_identity({'authInfo': cached['authInfo']})})
        self.assertEqual(result['blockedReason'], '网络暂不可用')
        self.assertNotIn(FAKE_TOKEN, self.output.getvalue())
        manager.snapshot.assert_not_called()

    def test_inspect_pending_recovery_takes_precedence_over_busy(self):
        manager = Mock()
        manager.db = {'accounts': {}, 'pending': True}
        manager.verify.return_value = {'email': 'work@example.test'}
        result = self.inspect_with_manager(manager, pids=['1234'])
        self.assertEqual(result['activePids'], [1234])
        self.assertTrue(result['pendingRecovery'])
        self.assertIn('恢复原账号', result['blockedReason'])

    def test_main_result_suppresses_manager_logs(self):
        manager = Mock()
        manager.save.side_effect = lambda name: print('Raw manager log ' + FAKE_TOKEN)
        with patch.object(bridge.sys, 'argv', ['bridge.py', 'save', 'work']), \
                patch.object(bridge.sys, 'platform', 'darwin'), \
                patch.object(bridge.accounts, 'check_environment'), \
                patch.object(bridge.accounts, 'Manager', return_value=manager):
            self.assertEqual(bridge.main(), 0)
        manager.save.assert_called_once_with('work')
        self.assertEqual(self.events(), [{'type': 'result', 'message': '已保存当前 Cursor 账号'}])
        self.assertNotIn(FAKE_TOKEN, self.output.getvalue())

    def test_main_login_result_uses_saved_slot_instead_of_requested_alias(self):
        manager = Mock()
        with patch.object(bridge.sys, 'argv', ['bridge.py', 'login', 'new-alias']), \
                patch.object(bridge.sys, 'platform', 'darwin'), \
                patch.object(bridge.accounts, 'check_environment'), \
                patch.object(bridge.accounts, 'Manager', return_value=manager), \
                patch.object(bridge, 'add_account', return_value='existing-slot') as add_account:
            self.assertEqual(bridge.main(), 0)
        add_account.assert_called_once_with(manager, 'new-alias')
        self.assertEqual(self.events(), [{'type': 'result', 'message': '已保存 Cursor 账号，当前使用的账号未改变',
                                         'accountName': 'existing-slot'}])

    def native_account(self):
        keys = FakeKeychain()
        manager = bridge.accounts.Manager(keys)
        current = snapshot('work@example.test', 'fake-current')
        manager.restore_snapshot(current)
        config = bridge.accounts.read_json(bridge.accounts.CONFIG, {})
        config.update({'theme': 'dark', 'permissions': {'shell': False},
                       'privacyCache': {'existing': True}})
        bridge.accounts.write_json(bridge.accounts.CONFIG, config)
        keys.writes.clear()
        return manager, keys, current, bridge.accounts.CONFIG.read_bytes()

    def isolated_login(self, directories, result=0, cancel=False):
        def login(command, env):
            self.assertEqual(command, ['fake-cursor'])
            directory = Path(env['HOME'])
            directories.append(directory)
            self.assertNotEqual(directory, Path.home())
            config_home = directory / '.cursor'
            self.assertEqual(env['AGENT_CLI_CREDENTIAL_STORE'], 'file')
            self.assertEqual(env['CURSOR_CONFIG_DIR'], str(config_home))
            self.assertEqual(env['CURSOR_DATA_DIR'], str(config_home))
            self.assertEqual(env['NO_OPEN_BROWSER'], '1')
            self.assertEqual(env['CURSOR_AGENT_DISABLE_DEBUG_LOG'], '1')
            bridge.accounts.write_json(config_home / 'auth.json', {
                'accessToken': FAKE_TOKEN, 'refreshToken': FAKE_TOKEN + '-refresh',
                'apiKey': None, 'ignoredSecret': FAKE_TOKEN})
            bridge.accounts.write_json(config_home / 'cli-config.json', {
                'authInfo': {'email': 'new@example.test', 'activeTeamId': 2,
                             'displayName': 'New account', 'ignoredSecret': FAKE_TOKEN}})
            if cancel:
                raise KeyboardInterrupt
            return result
        return login

    def test_add_account_while_agent_runs_keeps_current_credentials_and_config(self):
        manager, keys, current, original_config = self.native_account()
        directories = []
        status = {'isAuthenticated': True, 'userInfo': {
            'email': 'new@example.test', 'teamId': 2, 'teamName': 'New team',
            'accessToken': FAKE_TOKEN}}
        original_save = manager.save_snapshot

        def save_after_cleanup(name, value):
            self.assertEqual(len(directories), 1)
            self.assertFalse(directories[0].exists())
            return original_save(name, value)

        with patch.object(bridge.accounts, 'cursor_command', return_value=['fake-cursor']), \
                patch.object(bridge.accounts, 'active_agents', return_value=['9214']), \
                patch.object(bridge, 'login_runner', side_effect=self.isolated_login(directories)), \
                patch.object(bridge.subprocess, 'run', return_value=subprocess.CompletedProcess(
                    ['fake-cursor'], 0, json.dumps(status), '')) as run_status, \
                patch.object(manager, 'save_snapshot', side_effect=save_after_cleanup):
            self.assertEqual(bridge.add_account(manager, 'new'), 'new')
        self.assertEqual(manager.snapshot(), current)
        self.assertEqual(bridge.accounts.CONFIG.read_bytes(), original_config)
        self.assertEqual(keys.writes, [(bridge.accounts.SERVICE, 'new')])
        self.assertEqual(manager.stored('new'), {
            'credentials': {'cursor-access-token': FAKE_TOKEN,
                            'cursor-refresh-token': FAKE_TOKEN + '-refresh',
                            'cursor-api-key': None},
            'authInfo': {'email': 'new@example.test', 'activeTeamId': 2,
                         'displayName': 'New account', 'teamId': 2, 'teamName': 'New team'}})
        self.assertFalse(manager.db['pending'])
        args, kwargs = run_status.call_args
        self.assertEqual(args[0], ['fake-cursor', 'status', '--format', 'json'])
        self.assertEqual(kwargs['cwd'], str(directories[0]))
        self.assertEqual(kwargs['env']['HOME'], str(directories[0]))
        self.assertEqual(kwargs['env']['AGENT_CLI_CREDENTIAL_STORE'], 'file')
        self.assertNotIn(FAKE_TOKEN, self.output.getvalue())

    def test_cancelled_or_failed_add_leaves_current_account_and_removes_temporary_files(self):
        for cancel in (True, False):
            with self.subTest(cancel=cancel):
                manager, keys, current, original_config = self.native_account()
                original_db = copy.deepcopy(manager.db)
                directories = []
                with patch.object(bridge.accounts, 'cursor_command', return_value=['fake-cursor']), \
                        patch.object(bridge.accounts, 'active_agents', return_value=['9214']), \
                        patch.object(bridge, 'login_runner', side_effect=self.isolated_login(
                            directories, result=7, cancel=cancel)), \
                        patch.object(bridge.subprocess, 'run',
                                     side_effect=AssertionError('Failed login must not query status')):
                    with self.assertRaises(KeyboardInterrupt if cancel else bridge.accounts.Error):
                        bridge.add_account(manager, 'new')
                self.assertEqual(manager.snapshot(), current)
                self.assertEqual(bridge.accounts.CONFIG.read_bytes(), original_config)
                self.assertEqual(manager.db, original_db)
                self.assertEqual(keys.writes, [])
                self.assertEqual(len(directories), 1)
                self.assertFalse(directories[0].exists())
                self.assertNotIn(FAKE_TOKEN, self.output.getvalue())

    def test_add_rejects_different_identity_without_overwriting_existing_slot(self):
        for email in ('different@example.test', 'existing@example.test'):
            with self.subTest(email=email):
                manager, keys, current, original_config = self.native_account()
                saved = snapshot('existing@example.test', 'fake-existing', team_id=1)
                manager.save_snapshot('new', saved)
                original_db = copy.deepcopy(manager.db)
                keys.writes.clear()
                directories = []
                status = {'isAuthenticated': True, 'userInfo': {'email': email, 'teamId': 2}}
                with patch.object(bridge.accounts, 'cursor_command', return_value=['fake-cursor']), \
                        patch.object(bridge, 'login_runner', side_effect=self.isolated_login(directories)), \
                        patch.object(bridge.subprocess, 'run', return_value=subprocess.CompletedProcess(
                            ['fake-cursor'], 0, json.dumps(status), '')):
                    with self.assertRaisesRegex(bridge.accounts.Error, '账号或团队与已有账号不一致'):
                        bridge.add_account(manager, 'new')
                self.assertEqual(manager.snapshot(), current)
                self.assertEqual(bridge.accounts.CONFIG.read_bytes(), original_config)
                self.assertEqual(manager.db, original_db)
                self.assertEqual(manager.stored('new'), saved)
                self.assertEqual(keys.writes, [])
                self.assertFalse(directories[0].exists())

    def test_add_requires_verified_identity_before_saving(self):
        for status in ({'isAuthenticated': False},
                       {'isAuthenticated': True},
                       {'isAuthenticated': True, 'userInfo': {}}):
            with self.subTest(status=status):
                manager, keys, current, original_config = self.native_account()
                directories = []
                with patch.object(bridge.accounts, 'cursor_command', return_value=['fake-cursor']), \
                        patch.object(bridge, 'login_runner', side_effect=self.isolated_login(directories)), \
                        patch.object(bridge.subprocess, 'run', return_value=subprocess.CompletedProcess(
                            ['fake-cursor'], 0, json.dumps(status), '')):
                    with self.assertRaisesRegex(bridge.accounts.Error, '未能确认新账号登录'):
                        bridge.add_account(manager, 'new')
                self.assertEqual(manager.snapshot(), current)
                self.assertEqual(bridge.accounts.CONFIG.read_bytes(), original_config)
                self.assertEqual(keys.writes, [])
                self.assertFalse(directories[0].exists())

    def test_main_login_uses_isolated_add_and_propagates_cancellation(self):
        manager = Mock()
        with patch.object(bridge.sys, 'argv', ['bridge.py', 'login', 'new']), \
                patch.object(bridge.sys, 'platform', 'darwin'), \
                patch.object(bridge.accounts, 'check_environment'), \
                patch.object(bridge.accounts, 'Manager', return_value=manager), \
                patch.object(bridge, 'add_account', side_effect=KeyboardInterrupt) as add_account:
            with self.assertRaises(KeyboardInterrupt):
                bridge.main()
        add_account.assert_called_once_with(manager, 'new')
        manager.login.assert_not_called()

    def test_stop_login_waits_for_interrupt_before_returning(self):
        child = Mock()
        child.poll.return_value = None
        bridge.stop_login(child)
        child.send_signal.assert_called_once_with(signal.SIGINT)
        child.wait.assert_called_once_with(timeout=8)
        child.terminate.assert_not_called()

    def test_stop_login_escalates_after_interrupt_timeout(self):
        child = Mock()
        child.poll.return_value = None
        child.wait.side_effect = [subprocess.TimeoutExpired('fake-login', 8), 0]
        bridge.stop_login(child)
        child.terminate.assert_called_once_with()
        self.assertEqual(child.wait.call_count, 2)

    def test_stop_login_ignores_repeated_cancel_until_child_exits(self):
        handlers = {signal.SIGINT: bridge.interrupt, signal.SIGTERM: bridge.interrupt}
        child = Mock()
        child.poll.return_value = None
        stopped = []

        def set_handler(number, handler):
            previous = handlers[number]
            handlers[number] = handler
            return previous

        def wait_for_child(**kwargs):
            for number in (signal.SIGINT, signal.SIGTERM):
                if callable(handlers[number]):
                    handlers[number](number, None)
            stopped.append(True)
            return 0
        child.wait.side_effect = wait_for_child
        with patch.object(bridge.signal, 'signal', side_effect=set_handler):
            try:
                bridge.stop_login(child)
            except KeyboardInterrupt:
                self.fail('Repeated cancellation returned before the login child stopped')
        self.assertEqual(stopped, [True])
        self.assertEqual(handlers, {signal.SIGINT: bridge.interrupt, signal.SIGTERM: bridge.interrupt})

    def test_entrypoint_cancellation_result_reflects_pending_recovery(self):
        for pending, expected_type, expected_exit in ((False, 'result', 130), (True, 'error', 1)):
            with self.subTest(pending=pending):
                manager = Mock()
                manager.db = {'accounts': {}, 'pending': pending}
                output = io.StringIO()
                with patch.object(bridge.sys, 'argv', ['bridge.py', 'login', 'new']), \
                        patch.object(bridge.sys, 'platform', 'darwin'), \
                        patch.object(bridge.os, 'umask'), \
                        patch.object(bridge.signal, 'signal'), \
                        patch.object(bridge.accounts, 'check_environment'), \
                        patch.object(bridge.accounts, 'read_json', return_value={'pending': pending}), \
                        patch.object(bridge.accounts, 'Manager', return_value=manager), \
                        patch.object(bridge.accounts, 'cursor_command', side_effect=KeyboardInterrupt), \
                        contextlib.redirect_stdout(output):
                    with self.assertRaises(SystemExit) as exit_result:
                        runpy.run_path(bridge.__file__, run_name='__main__')
                self.assertEqual(exit_result.exception.code, expected_exit)
                events = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0]['type'], expected_type)
                self.assertNotIn(FAKE_TOKEN, output.getvalue())
                manager.login.assert_not_called()

    def test_stop_login_cannot_return_while_child_is_alive(self):
        child = Mock()
        child.poll.return_value = None
        child.wait.side_effect = subprocess.TimeoutExpired('fake-login', 8)
        with patch.object(bridge.os, '_exit', side_effect=SystemExit) as exit_process:
            with self.assertRaises(SystemExit):
                bridge.stop_login(child)
        exit_process.assert_called_once_with(1)
        self.assertEqual(self.events()[0]['type'], 'error')
        self.assertIn('保留恢复标记', self.events()[0]['message'])

    def test_cancel_stops_child_before_transaction_rolls_back(self):
        keys = FakeKeychain()
        manager = bridge.accounts.Manager(keys, login_runner=bridge.login_runner)
        before = snapshot('work@example.test', 'fake-work')
        manager.restore_snapshot(before)
        order = []
        original_restore = manager.restore_snapshot

        def rollback(value):
            order.append('rollback')
            original_restore(value)

        child = Mock()
        child.poll.return_value = None
        child.send_signal.side_effect = lambda value: order.append('interrupt-child')
        child.wait.side_effect = lambda **kwargs: order.append('child-stopped') or 0
        child.stdout.close.side_effect = lambda: order.append('pipe-closed')
        selector = Mock()
        selector.select.side_effect = KeyboardInterrupt
        selector_context = Mock()
        selector_context.__enter__ = Mock(return_value=selector)
        selector_context.__exit__ = Mock(return_value=False)
        with patch.object(bridge.accounts, 'active_agents', return_value=[]), \
                patch.object(bridge.accounts, 'cursor_command', return_value=['fake-cursor']), \
                patch.object(bridge.subprocess, 'Popen', return_value=child), \
                patch.object(bridge.selectors, 'DefaultSelector', return_value=selector_context), \
                patch.object(manager, 'restore_snapshot', side_effect=rollback), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(KeyboardInterrupt):
                manager.login('new')
        self.assertEqual(order, ['interrupt-child', 'child-stopped', 'pipe-closed', 'rollback'])
        self.assertEqual(manager.snapshot(), before)
        self.assertFalse(manager.db['pending'])
        self.assertEqual(self.events(), [])


if __name__ == '__main__':
    unittest.main()
