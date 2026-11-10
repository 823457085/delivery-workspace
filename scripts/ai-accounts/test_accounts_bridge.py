"""Generic bridge tests; no real process, login, credential or Keychain access."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import common


# common adds cursor-accounts to sys.path; load this bridge by its exact file.
spec = importlib.util.spec_from_file_location('generic_accounts_bridge', Path(__file__).with_name('bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

FAKE_SECRET = 'fake-secret-never-emit'
CODEX_URL = 'https://auth.openai.com/oauth/authorize?state=fixture&code_challenge=fixture'
CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?state=fixture&code_challenge=fixture'


class FakeSelector:
    def __enter__(self):
        self.registered = {}
        return self

    def __exit__(self, *args):
        return False

    def register(self, fileobj, events):
        self.registered[fileobj] = SimpleNamespace(fd=123, fileobj=fileobj)

    def unregister(self, fileobj):
        self.registered.pop(fileobj)

    def get_map(self):
        return self.registered

    def select(self, timeout):
        return [(key, 1) for key in self.registered.values()]


class AccountsBridgeTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.output = io.StringIO()
        self.stack.enter_context(patch.object(bridge._cursor, 'OUTPUT', self.output))
        self.stack.enter_context(patch.object(common, 'Keychain',
                                             side_effect=AssertionError('Real Keychain forbidden')))
        for name in ('run', 'call', 'Popen', 'check_output'):
            self.stack.enter_context(patch.object(bridge.subprocess, name,
                                                 side_effect=AssertionError('Real subprocess forbidden')))

    def events(self):
        return [json.loads(line) for line in self.output.getvalue().splitlines()]

    def login(self, chunks, provider='codex', code=0):
        child = Mock()
        child.poll.return_value = code
        child.wait.return_value = code
        adapter = Mock(provider=provider)
        adapter.command.return_value = ['fixture-cli']
        adapter.login_args.return_value = ['login']
        adapter.child_env.return_value = {'HOME': '/fixture-only'}
        with patch.object(bridge.subprocess, 'Popen', return_value=child) as popen, \
                patch.object(bridge.selectors, 'DefaultSelector', FakeSelector), \
                patch.object(bridge.os, 'read', side_effect=[*chunks, b'']):
            result = bridge.login_runner(adapter)
        child.stdout.close.assert_called_once_with()
        self.assertEqual(popen.call_args.args[0], ['fixture-cli', 'login'])
        self.assertEqual(popen.call_args.kwargs['env'], {'HOME': '/fixture-only'})
        return result

    def test_only_exact_official_hosts_and_paths_are_allowed(self):
        for provider, targets in bridge.LOGIN_TARGETS.items():
            for host, path in targets:
                url = 'https://' + host + path + '?state=fixture'
                with self.subTest(provider=provider, url=url):
                    self.assertEqual(bridge.official_login_url(provider, 'Login: ' + url + '\n'), url)
                    for rejected in (
                            'http://' + host + path,
                            'https://' + host + '.evil.test' + path,
                            'https://evil.test/' + host + path,
                            'https://' + host + '@evil.test' + path,
                            'https://evil.test@' + host + path,
                            'https://' + host + ':443' + path,
                            'https://' + host + path + '/other',
                            'https://' + host + '/other',
                            url + '#fragment',
                            'https://[invalid' + path):
                        with self.subTest(rejected=rejected):
                            self.assertIsNone(bridge.official_login_url(provider, rejected))
        self.assertIsNone(bridge.official_login_url('codex', CLAUDE_URL))
        self.assertIsNone(bridge.official_login_url('claude', CODEX_URL))

    def test_login_emits_only_complete_official_url_once_without_raw_logs(self):
        for provider, url in (('codex', CODEX_URL), ('claude', CLAUDE_URL)):
            with self.subTest(provider=provider):
                self.output.seek(0)
                self.output.truncate()
                chunks = [
                    (FAKE_SECRET + '\nhttps://evil.test/oauth/authorize?token=' + FAKE_SECRET + '\n').encode(),
                    url[:45].encode(),
                    (url[45:] + '\n').encode(),
                    (url + '\nRaw stderr: ' + FAKE_SECRET + '\n').encode(),
                ]
                self.assertEqual(self.login(chunks, provider), 0)
                self.assertEqual(self.events(), [{'type': 'login', 'url': url}])
                self.assertNotIn(FAKE_SECRET, self.output.getvalue())
                self.assertNotIn('evil.test', self.output.getvalue())

    def test_unterminated_url_and_failed_child_logs_are_not_emitted(self):
        self.assertEqual(self.login([CODEX_URL.encode()]), 0)
        self.assertEqual(self.events(), [])
        self.assertEqual(self.login([(FAKE_SECRET + '\n').encode()], code=7), 7)
        self.assertEqual(self.events(), [])

    def test_login_result_identifies_the_canonical_saved_slot_without_credentials(self):
        import codex_adapter
        manager = Mock()
        manager.login.return_value = 'existing-slot'
        with tempfile.TemporaryDirectory() as directory:
            manager.data = Path(directory)
            with patch.object(bridge.sys, 'argv', ['bridge.py', 'codex', 'login', 'requested-slot']), \
                    patch.object(bridge.sys, 'platform', 'darwin'), \
                    patch.object(codex_adapter, 'CodexAdapter', return_value=Mock(label='Codex')), \
                    patch.object(bridge, 'Manager', return_value=manager):
                self.assertEqual(bridge.main(), 0)
        manager.login.assert_called_once_with('requested-slot')
        self.assertEqual(self.events(), [{'type': 'result', 'message': 'Codex：已保存账号，当前使用的账号未改变',
                                         'accountName': 'existing-slot'}])

    def inspect_manager(self, current=None):
        manager = Mock()
        manager.db = {'accounts': {'work': {'email': 'work@example.test', 'team': 'Fixture team',
                                            'credentials': FAKE_SECRET}}, 'pending': False}
        manager.adapter.current.return_value = current
        manager.adapter.active_pids.return_value = []
        manager.adapter.validate.return_value = {'credentials': FAKE_SECRET}
        manager.adapter.identity.return_value = {'email': 'work@example.test', 'team': 'Fixture team',
                                                  'key': 'fixture-account', 'credentials': FAKE_SECRET}
        return manager

    def test_inspect_verifies_current_login_and_emits_only_identity_metadata(self):
        manager = self.inspect_manager({'email': 'work@example.test', 'team': 'Fixture team',
                                        'identity': 'fixture-account', 'displayName': 'Fixture',
                                        'verified': False, 'credentials': FAKE_SECRET})
        with patch.object(bridge.sys, 'platform', 'darwin'):
            bridge.inspect(manager)
        result = self.events()[0]
        self.assertTrue(result['available'])
        self.assertEqual(result['accounts'], [{'name': 'work', 'email': 'work@example.test', 'team': 'Fixture team',
                                               'displayName': '', 'identity': ''}])
        self.assertEqual(result['current'], {'email': 'work@example.test', 'team': 'Fixture team',
                                             'identity': 'fixture-account', 'displayName': 'Fixture',
                                             'verified': True})
        self.assertEqual(result['blockedReason'], '')
        self.assertNotIn(FAKE_SECRET, self.output.getvalue())
        manager.stored.assert_not_called()
        manager.adapter.validate.assert_called_once_with()

    def test_inspect_recovers_cli_identity_without_cached_account_metadata(self):
        manager = self.inspect_manager()
        with patch.object(bridge.sys, 'platform', 'darwin'):
            bridge.inspect(manager)
        result = self.events()[0]
        self.assertTrue(result['current']['verified'])
        self.assertEqual(result['current']['identity'], 'fixture-account')
        self.assertNotIn(FAKE_SECRET, self.output.getvalue())

    def test_inspect_failed_verification_preserves_cached_identity_and_safe_error(self):
        for error in (bridge.Error('官方 CLI 未确认登录'), OSError(FAKE_SECRET),
                      bridge.subprocess.TimeoutExpired('fixture', 1, output=FAKE_SECRET)):
            with self.subTest(error=type(error).__name__):
                manager = self.inspect_manager({'email': 'work@example.test', 'team': 'Fixture team',
                                                'identity': 'fixture-account', 'verified': True,
                                                'credentials': FAKE_SECRET})
                manager.adapter.validate.side_effect = error
                manager.adapter.active_pids.return_value = [1234]
                with patch.object(bridge.sys, 'platform', 'darwin'):
                    bridge.inspect(manager)
                result = self.events()[-1]
                self.assertTrue(result['available'])
                self.assertEqual(result['current']['email'], 'work@example.test')
                self.assertFalse(result['current']['verified'])
                self.assertNotIn('进程运行', result['blockedReason'])
                self.assertTrue(result['blockedReason'])
                self.assertNotIn(FAKE_SECRET, self.output.getvalue())

    def test_inspect_identity_changes_cannot_be_marked_verified(self):
        for identity in ({'key': 'other-account', 'email': 'work@example.test'},
                         {'key': 'fixture-account', 'email': 'other@example.test'}):
            manager = self.inspect_manager({'email': 'work@example.test', 'identity': 'fixture-account'})
            manager.adapter.identity.return_value = identity
            with patch.object(bridge.sys, 'platform', 'darwin'):
                bridge.inspect(manager)
            result = self.events()[-1]
            self.assertFalse(result['current']['verified'])
            self.assertEqual(result['current']['identity'], 'fixture-account')
            self.assertIn('身份在检查期间变化', result['blockedReason'])

    def test_inspect_missing_login_keeps_account_management_available(self):
        manager = self.inspect_manager()
        manager.adapter.validate.side_effect = bridge.Error('请先完成官方登录。')
        with patch.object(bridge.sys, 'platform', 'darwin'):
            bridge.inspect(manager)
        result = self.events()[-1]
        self.assertTrue(result['available'])
        self.assertIsNone(result['current'])

    def test_inspect_sanitizes_internal_errors_and_prioritizes_pending_recovery(self):
        manager = Mock()
        manager.db = {'accounts': {}, 'pending': False}
        manager.adapter.check_environment.side_effect = OSError(FAKE_SECRET)
        with patch.object(bridge.sys, 'platform', 'darwin'):
            bridge.inspect(manager)
        self.assertFalse(self.events()[0]['available'])
        self.assertNotIn(FAKE_SECRET, self.output.getvalue())
        manager.adapter.check_environment.side_effect = None
        manager.adapter.active_pids.return_value = [1234]
        manager.adapter.current.return_value = None
        manager.db['pending'] = True
        with patch.object(bridge.sys, 'platform', 'darwin'):
            bridge.inspect(manager)
        result = self.events()[-1]
        self.assertTrue(result['pendingRecovery'])
        self.assertEqual(result['activePids'], [1234])
        self.assertIn('先恢复', result['blockedReason'])

    def test_inspect_unsupported_platform_does_not_access_provider(self):
        manager = Mock()
        manager.db = {'accounts': {}, 'pending': False}
        with patch.object(bridge.sys, 'platform', 'linux'):
            bridge.inspect(manager)
        self.assertFalse(self.events()[0]['available'])
        manager.adapter.check_environment.assert_not_called()
        manager.adapter.current.assert_not_called()


if __name__ == '__main__':
    unittest.main()
