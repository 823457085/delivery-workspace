"""Account safety checks using only fake credentials and temporary files."""
import base64
import contextlib
import copy
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import Mock, patch

import common
from codex_adapter import CodexAdapter


class FakeKeychain:
    def __init__(self):
        self.values = {}

    def get(self, service, account):
        return self.values.get((service, account))

    def put(self, service, account, value):
        self.values[service, account] = value


def snapshot(account='work', token='fake-work-token', team='Fixture team'):
    return {'identity': {'key': account, 'email': account + '@example.test', 'team': team},
            'credentials': {'access_token': token, 'refresh_token': token + '-refresh'}}


class FakeAdapter:
    provider = 'fixture'
    label = 'Fixture'

    def __init__(self, current):
        self.state = copy.deepcopy(current)
        self.active_pids = Mock(return_value=[])
        self.validate = Mock(side_effect=self.snapshot)

    def snapshot(self):
        return copy.deepcopy(self.state)

    def restore(self, value):
        self.state = copy.deepcopy(value)

    def identity(self, value):
        return value.get('identity', {})

    @contextlib.contextmanager
    def isolated_login(self):
        staged = FakeAdapter({})
        yield staged


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(common, 'Keychain',
                                             side_effect=AssertionError('Real Keychain forbidden')))
        for name in ('run', 'call', 'Popen', 'check_output'):
            self.stack.enter_context(patch.object(common.subprocess, name,
                                                 side_effect=AssertionError('Real subprocess forbidden')))
        self.keys = FakeKeychain()
        self.work = snapshot()
        self.personal = snapshot('personal', 'fake-personal-token')
        self.adapter = FakeAdapter(self.work)
        self.login = Mock(side_effect=AssertionError('Real login forbidden'))
        self.manager = common.Manager(self.adapter, self.keys, self.root / 'data', self.login)
        self.manager.save_snapshot('work', self.work)
        self.manager.save_snapshot('personal', self.personal)

    def assert_current(self, expected, pending=False):
        self.assertEqual(self.adapter.snapshot(), expected)
        self.assertEqual(self.manager.db['pending'], pending)
        self.assertEqual(common.read_json(self.manager.data / 'accounts.json', {})['pending'], pending)

    def test_switch_saves_validated_credentials_and_keeps_backup(self):
        refreshed = snapshot('personal', 'fake-personal-refreshed', 'Updated team')

        def validate():
            self.adapter.restore(refreshed)
            return self.adapter.snapshot()

        self.adapter.validate.side_effect = validate
        self.manager.use('personal')
        self.assert_current(refreshed)
        self.assertEqual(self.manager.stored('personal'), refreshed)
        self.assertEqual(self.manager.stored('@previous'), self.work)
        self.assertEqual(self.manager.db['accounts']['personal']['team'], 'Updated team')
        self.login.assert_not_called()

    def test_unicode_hex_profile_switch_preserves_other_saved_accounts(self):
        target = snapshot('personal', 'fake-personal-token', '研发团队')
        target['identity']['displayName'] = '测试账号'
        other = snapshot('other', 'fake-other-token', '其他团队')
        for name, saved in (('personal', target), ('other', other)):
            self.manager.save_snapshot(name, saved)
            self.keys.values[self.manager.service, name] = json.dumps(saved, ensure_ascii=False).encode().hex()
        other_raw = self.keys.get(self.manager.service, 'other')
        self.manager.use('personal')
        self.assert_current(target)
        self.assertEqual(self.manager.stored('personal'), target)
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.manager.stored('@previous'), self.work)
        self.assertEqual(self.manager.stored('other'), other)
        self.assertEqual(self.keys.get(self.manager.service, 'other'), other_raw)

    def test_unicode_hex_profile_failure_rolls_back_and_keeps_target(self):
        target = snapshot('personal', 'fake-personal-token', '研发团队')
        self.manager.save_snapshot('personal', target)
        encoded = json.dumps(target, ensure_ascii=False).encode().hex()
        self.keys.values[self.manager.service, 'personal'] = encoded
        self.adapter.validate.side_effect = common.Error('fixture validation failed')
        with self.assertRaisesRegex(common.Error, 'fixture validation failed'):
            self.manager.use('personal')
        self.assert_current(self.work)
        self.assertEqual(self.keys.get(self.manager.service, 'personal'), encoded)
        self.assertEqual(self.manager.stored('personal'), target)
        self.assertEqual(self.manager.stored('work'), self.work)

    def test_stored_rejects_malformed_hex_or_non_object_without_secret_error(self):
        for raw in ('7b1', 'fffe', '{"token":"fixture-sensitive",',
                    '["fixture-sensitive"]'.encode().hex()):
            self.keys.values[self.manager.service, 'personal'] = raw
            before = copy.deepcopy(self.keys.values)
            with self.assertRaises(common.Error) as caught:
                self.manager.stored('personal')
            self.assertEqual(str(caught.exception), '账号凭据格式无法读取，请重新登录该账号。')
            self.assertEqual(self.keys.values, before)
            self.assert_current(self.work)

    def test_switch_failure_restores_original_account(self):
        self.adapter.validate.side_effect = common.Error('fixture validation failed')
        with self.assertRaisesRegex(common.Error, 'fixture validation failed'):
            self.manager.use('personal')
        self.assert_current(self.work)
        self.assertEqual(self.manager.stored('personal'), self.personal)

    def test_switch_keyboard_interrupt_restores_original_account(self):
        self.adapter.validate.side_effect = KeyboardInterrupt
        with self.assertRaises(KeyboardInterrupt):
            self.manager.use('personal')
        self.assert_current(self.work)

    def test_identity_mismatch_restores_original_without_overwriting_target(self):
        self.adapter.validate.side_effect = lambda: self.work
        with self.assertRaisesRegex(common.Error, '账号身份不一致'):
            self.manager.use('personal')
        self.assert_current(self.work)
        self.assertEqual(self.manager.stored('personal'), self.personal)

    def test_failed_rollback_keeps_pending_for_manual_recovery(self):
        original_restore = self.adapter.restore

        def restore(value):
            if value == self.work:
                raise OSError('fixture restore failed')
            original_restore(value)

        self.adapter.validate.side_effect = common.Error('fixture validation failed')
        with patch.object(self.adapter, 'restore', side_effect=restore):
            with self.assertRaisesRegex(OSError, 'fixture restore failed'):
                self.manager.use('personal')
        self.assert_current(self.personal, pending=True)
        self.assertEqual(self.manager.stored('@previous'), self.work)
        with self.assertRaisesRegex(common.Error, '先恢复'):
            self.manager.use('work')
        self.manager.restore()
        self.assert_current(self.work)

    def test_failed_explicit_restore_keeps_pending_and_previous(self):
        self.manager.use('personal')
        with patch.object(self.adapter, 'restore', side_effect=OSError('fixture restore failed')):
            with self.assertRaises(OSError):
                self.manager.restore()
        self.assert_current(self.personal, pending=True)
        self.assertEqual(self.manager.stored('@previous'), self.work)

    def test_refresh_outgoing_slot_before_switching_or_reusing_it(self):
        for target in ('personal', 'work'):
            with self.subTest(target=target):
                refreshed = snapshot(token='fake-work-refreshed')
                self.adapter.restore(refreshed)
                self.manager.use(target)
                self.assert_current(self.personal if target == 'personal' else refreshed)
                self.assertEqual(self.manager.stored('work'), refreshed)
                self.assertEqual(self.manager.stored('@previous'), refreshed)

    def test_outgoing_same_email_with_different_identity_does_not_replace_slot(self):
        another = snapshot('different-user', 'fake-other-token')
        another['identity']['email'] = self.work['identity']['email']
        self.adapter.restore(another)
        self.manager.use('personal')
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.manager.stored('@previous'), another)

    def test_login_success_saves_only_after_validation(self):
        refreshed = snapshot('personal', 'fake-personal-refreshed')
        refreshed['config'] = {'oauthAccount': {'displayName': '官方显示名 L123'}}

        def login(adapter):
            self.assertEqual(adapter.snapshot(), {})
            self.assertFalse(self.manager.db['pending'])
            self.assertIsNot(adapter, self.adapter)
            adapter.restore(refreshed)
            return 0

        self.login.side_effect = login
        self.assertEqual(self.manager.login('new'), 'personal')
        self.assert_current(self.work)
        self.assertEqual(self.manager.stored('personal'), refreshed)
        self.assertEqual(list(self.manager.db['accounts']), ['work', 'personal'])
        self.assertEqual(self.manager.db['accounts']['personal']['displayName'], '官方显示名 L123')
        self.assertIsNone(self.keys.get(self.manager.service, 'new'))

    def test_distinct_team_identity_with_same_email_is_not_merged(self):
        other = snapshot('other-team', 'fake-other-team')
        other['identity'].update(email=self.work['identity']['email'], key='work|org:second')
        self.manager.save_snapshot('other-team', other)
        self.assertEqual(list(self.manager.db['accounts']), ['work', 'personal', 'other-team'])
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.manager.stored('other-team'), other)

    def test_existing_slot_name_is_retained_when_saved_metadata_changes(self):
        updated = snapshot('work', 'fake-updated', 'New team name')
        updated['config'] = {'oauthAccount': {'accountName': '官方账号名'}}
        self.assertEqual(self.manager.save_snapshot('work', updated), 'work')
        self.assertEqual(list(self.manager.db['accounts']), ['work', 'personal'])
        self.assertEqual(self.manager.db['accounts']['work']['displayName'], '官方账号名')
        self.assertEqual(self.manager.stored('work'), updated)

    def legacy_slot(self, name, saved, encoded=False):
        raw = json.dumps(saved, ensure_ascii=False)
        self.keys.values[self.manager.service, name] = raw.encode().hex() if encoded else raw
        self.manager.db['accounts'][name] = {'email': saved['identity']['email'],
                                             'team': saved['identity'].get('team', '')}

    def test_new_alias_refreshes_newest_legacy_slot_and_retains_old_secret(self):
        self.legacy_slot('work-copy', self.work)
        old_work = self.keys.get(self.manager.service, 'work')
        refreshed = snapshot('work', 'fresh-work-token')
        self.assertEqual(self.manager.save_snapshot('another-alias', refreshed), 'work-copy')
        self.assertEqual(list(self.manager.db['accounts']), ['personal', 'work-copy'])
        self.assertEqual(self.manager.stored('work-copy'), refreshed)
        self.assertEqual(self.keys.get(self.manager.service, 'work'), old_work)
        self.assertIsNone(self.keys.get(self.manager.service, 'another-alias'))

    def test_deduplicate_keeps_last_slot_without_any_credential_write(self):
        newest = snapshot('work', 'newest-work-token', '研发团队')
        newest['config'] = {'oauthAccount': {'displayName': '官方名称 🚀'}}
        self.legacy_slot('work-copy', self.work)
        self.legacy_slot('work-newest', newest, encoded=True)
        self.manager.commit()
        before_keys = copy.deepcopy(self.keys.values)
        with patch.object(self.keys, 'put', side_effect=AssertionError('Migration must not write credentials')):
            self.assertEqual(self.manager.deduplicate(), ['work', 'work-copy'])
            self.assertEqual(self.manager.deduplicate(), [])
        self.assertEqual(list(self.manager.db['accounts']), ['personal', 'work-newest'])
        self.assertEqual(self.manager.db['accounts']['work-newest'], {
            'email': 'work@example.test', 'team': '研发团队', 'displayName': '官方名称 🚀', 'identity': 'work'})
        self.assertEqual(self.keys.values, before_keys)
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.manager.stored('work-newest'), newest)
        self.assert_current(self.work)

    def test_deduplicate_pending_recovery_is_rejected_without_mutation(self):
        self.legacy_slot('work-copy', self.work)
        self.manager.db['pending'] = True
        self.manager.commit()
        before_db = (self.manager.data / 'accounts.json').read_bytes()
        before_keys = copy.deepcopy(self.keys.values)
        with self.assertRaisesRegex(common.Error, '被中断'):
            self.manager.deduplicate()
        self.assertEqual((self.manager.data / 'accounts.json').read_bytes(), before_db)
        self.assertEqual(self.keys.values, before_keys)

    def test_switch_to_duplicate_slot_preserves_current_refreshed_credentials(self):
        self.legacy_slot('work-copy', self.work)
        refreshed = snapshot('work', 'fake-refreshed-work')
        self.adapter.restore(refreshed)
        self.manager.use('work-copy')
        self.assert_current(refreshed)
        self.assertEqual(self.manager.stored('work-copy'), refreshed)
        self.assertNotIn('work', self.manager.db['accounts'])
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.manager.stored('personal'), self.personal)

    def test_failed_or_cancelled_login_never_changes_original(self):
        for outcome in (1, KeyboardInterrupt):
            with self.subTest(outcome=outcome):
                def login(adapter):
                    adapter.restore(self.personal)
                    if outcome is KeyboardInterrupt:
                        raise KeyboardInterrupt
                    return outcome

                self.login.side_effect = login
                with self.assertRaises(KeyboardInterrupt if outcome is KeyboardInterrupt else common.Error):
                    self.manager.login('new')
                self.assert_current(self.work)
                self.assertNotIn('new', self.manager.db['accounts'])

    def test_login_name_identity_mismatch_restores_original(self):
        self.login.side_effect = lambda adapter: adapter.restore(self.personal) or 0
        with self.assertRaisesRegex(common.Error, '已有名称不一致'):
            self.manager.login('work')
        self.assert_current(self.work)
        self.assertEqual(self.manager.stored('work'), self.work)

    def test_save_refuses_another_identity_using_existing_name(self):
        self.adapter.restore(self.personal)
        with self.assertRaisesRegex(common.Error, '属于另一个账号'):
            self.manager.save('work')
        self.assertEqual(self.manager.stored('work'), self.work)

    def test_missing_identity_cannot_be_saved(self):
        with self.assertRaisesRegex(common.Error, '无法确认'):
            self.manager.save_snapshot('unknown', {'credentials': {'access_token': 'fake-unknown'}})
        self.assertNotIn('unknown', self.manager.db['accounts'])
        self.assertIsNone(self.keys.get(self.manager.service, 'unknown'))

    def test_busy_provider_still_allows_switch_and_restore(self):
        self.adapter.active_pids.return_value = [1234]
        self.manager.use('personal')
        self.assert_current(self.personal)
        self.assertEqual(self.manager.stored('@previous'), self.work)
        self.manager.restore()
        self.assert_current(self.work)
        self.login.assert_not_called()

    def test_busy_provider_can_save_and_add_without_touching_current(self):
        self.adapter.active_pids.return_value = [1234]
        self.login.side_effect = lambda staged: staged.restore(self.personal) or 0
        self.manager.save('work-copy')
        self.manager.login('new')
        self.assert_current(self.work)
        self.assertEqual(list(self.manager.db['accounts']), ['work', 'personal'])
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.manager.stored('personal'), self.personal)
        self.assertIsNone(self.keys.get(self.manager.service, 'work-copy'))
        self.assertIsNone(self.keys.get(self.manager.service, 'new'))
        self.assertIsNone(self.keys.get(self.manager.service, '@previous'))

    def test_metadata_files_never_contain_credentials(self):
        self.manager.use('personal')
        files = [path for path in self.manager.data.rglob('*') if path.is_file()]
        self.assertEqual([path.name for path in files], ['accounts.json'])
        text = files[0].read_text()
        for secret in ('fake-work-token', 'fake-personal-token', 'access_token', 'refresh_token', '@previous'):
            self.assertNotIn(secret, text)
        self.assertEqual(json.loads(text)['accounts']['work'],
                         {'email': 'work@example.test', 'team': 'Fixture team',
                          'displayName': '', 'identity': 'work'})
        self.assertEqual(stat.S_IMODE(self.manager.data.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(files[0].stat().st_mode), 0o600)


def token(claims):
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
    return 'fake-header.' + payload + '.fake-signature'


def codex_auth():
    return {'auth_mode': 'chatgpt', 'OPENAI_API_KEY': None,
            'tokens': {'id_token': token({'sub': 'fixture-user', 'email': 'work@example.test',
                                         'https://api.openai.com/auth': {'chatgpt_plan_type': 'pro'}}),
                       'access_token': 'fake-access-token', 'refresh_token': 'fake-refresh-token',
                       'account_id': 'fixture-account'},
            'last_refresh': '2026-01-01T00:00:00Z', 'future_field': {'preserved': True}}


class ActiveProcessTests(unittest.TestCase):
    def test_codex_daemons_do_not_block_but_one_shot_cli_does(self):
        args = '\n'.join((
            '100 /Applications/Codex/codex -c feature=true app-server --analytics-default-enabled',
            '101 /Applications/Codex/codex -c forced_login_method=chatgpt exec-server --remote fixture',
            '102 /Applications/Codex/codex exec --full-auto fixture-task',
            '103 /usr/local/bin/node /tmp/node_modules/@openai/codex/bin/cli.js exec fixture-task',
        ))
        commands = '\n'.join((
            '100 /Applications/Codex/codex',
            '101 /Applications/Codex/codex',
            '102 /Applications/Codex/codex',
            '103 node',
        ))
        with patch.object(common.subprocess, 'check_output', side_effect=[args, commands]):
            self.assertEqual(common.active_cli_pids('codex'), [102, 103])


class CodexAdapterTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.adapter = CodexAdapter(home=self.root, env={})
        self.command = self.stack.enter_context(patch.object(CodexAdapter, 'command', return_value=['fake-codex']))
        self.run = self.stack.enter_context(patch.object(common.subprocess, 'run',
                                                        side_effect=AssertionError('Real subprocess forbidden')))
        self.stack.enter_context(patch.object(common.subprocess, 'Popen',
                                             side_effect=AssertionError('Real login forbidden')))
        self.stack.enter_context(patch.object(common, 'Keychain',
                                             side_effect=AssertionError('Real Keychain forbidden')))
        self.auth = codex_auth()
        self.adapter.restore({'auth': self.auth})

    def config(self, text):
        (self.adapter.config_home / 'config.toml').write_text(text)

    def test_restore_changes_only_auth_and_preserves_complete_auth_structure(self):
        self.config('model = "fixture-model"\n[projects."/fixture"]\ntrust_level = "trusted"\n')
        sessions = self.adapter.config_home / 'sessions'
        sessions.mkdir()
        session = sessions / 'session.jsonl'
        session.write_text('{"fixture":"conversation"}\n')
        config_before = (self.adapter.config_home / 'config.toml').read_bytes()
        session_before = session.read_bytes()
        previous = self.adapter.snapshot()
        replacement = codex_auth()
        replacement['tokens']['access_token'] = 'fake-second-access'
        self.adapter.restore({'auth': replacement})
        self.assertEqual(self.adapter.snapshot(), {'auth': replacement})
        self.adapter.restore({})
        self.assertFalse(self.adapter.auth.exists())
        self.adapter.restore(previous)
        self.assertEqual(self.adapter.snapshot(), {'auth': self.auth})
        self.assertEqual((self.adapter.config_home / 'config.toml').read_bytes(), config_before)
        self.assertEqual(session.read_bytes(), session_before)
        self.assertEqual(stat.S_IMODE(self.adapter.auth.stat().st_mode), 0o600)

    def test_identity_decodes_jwt_and_current_is_explicitly_unverified(self):
        self.assertEqual(self.adapter.identity({'auth': self.auth}),
                         {'key': 'fixture-user|fixture-account', 'email': 'work@example.test', 'team': 'pro'})
        self.assertEqual(self.adapter.current(), {'email': 'work@example.test', 'team': 'pro', 'verified': False,
                                                 'identity': 'fixture-user|fixture-account'})
        self.run.assert_not_called()
        self.assertNotIn('fake-access-token', json.dumps(self.adapter.current()))

    def test_identity_uses_namespaced_claims_without_top_level_values(self):
        claims = {'https://api.openai.com/profile': {'email': 'profile@example.test'},
                  'https://api.openai.com/auth': {'chatgpt_account_id': 'profile-account',
                                                'chatgpt_plan_type': 'team'}}
        self.assertEqual(self.adapter.identity({'auth': {'tokens': {'id_token': token(claims)}}}),
                         {'key': 'profile@example.test|profile-account',
                          'email': 'profile@example.test', 'team': 'team'})

    def test_malformed_or_missing_jwt_has_no_confirmed_identity(self):
        for value in ('', 'invalid', 'header.%%%invalid.signature', token([]), token({'sub': 'user'})):
            with self.subTest(value=value):
                self.adapter.restore({'auth': {'tokens': {'id_token': value}}})
                self.assertIsNone(self.adapter.current())

    def test_validation_uses_only_official_status_without_returning_cli_output(self):
        self.run.side_effect = None
        self.run.return_value = Mock(returncode=0, stdout='fake-secret-output', stderr='fake-secret-error')
        self.assertEqual(self.adapter.validate(), {'auth': self.auth})
        args, kwargs = self.run.call_args
        self.assertEqual(args[0], ['fake-codex', 'login', 'status'])
        self.assertEqual(kwargs['env']['CODEX_HOME'], str(self.adapter.config_home))
        self.assertTrue(kwargs['capture_output'])
        self.assertNotIn('fake-access-token', json.dumps(args))

    def test_validation_rejects_api_keys_and_other_auth_modes_before_cli(self):
        for changes in ({'OPENAI_API_KEY': 'fake-api-key'}, {'auth_mode': 'apikey'},
                        {'auth_mode': 'chatgptAuthTokens'}):
            with self.subTest(changes=changes):
                self.adapter.restore({'auth': dict(self.auth, **changes)})
                with self.assertRaisesRegex(common.Error, 'API Key'):
                    self.adapter.validate()
        self.run.assert_not_called()

    def test_validation_rejects_missing_refresh_or_access_token_before_cli(self):
        for field in ('access_token', 'refresh_token'):
            with self.subTest(field=field):
                auth = copy.deepcopy(self.auth)
                auth['tokens'].pop(field)
                self.adapter.restore({'auth': auth})
                with self.assertRaisesRegex(common.Error, '官方登录'):
                    self.adapter.validate()
        self.run.assert_not_called()

    def test_validation_rejects_failed_cli_without_leaking_raw_output(self):
        self.run.side_effect = None
        self.run.return_value = Mock(returncode=1, stdout='fake-secret-output', stderr='fake-secret-error')
        with self.assertRaisesRegex(common.Error, '未确认本地登录') as result:
            self.adapter.validate()
        self.assertNotIn('fake-secret', str(result.exception))

    def test_validation_rejects_concurrent_credential_change(self):
        def changed(*args, **kwargs):
            auth = copy.deepcopy(self.auth)
            auth['tokens']['refresh_token'] = 'fake-concurrent-refresh'
            self.adapter.restore({'auth': auth})
            return Mock(returncode=0)

        self.run.side_effect = changed
        with self.assertRaisesRegex(common.Error, '检查期间变化'):
            self.adapter.validate()

    def test_environment_rejects_auth_overrides_without_disclosing_values(self):
        for variable in ('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL',
                         'CODEX_AUTH_TOKEN', 'CHATGPT_ACCESS_TOKEN'):
            with self.subTest(variable=variable):
                adapter = CodexAdapter(home=self.root, env={variable: 'fake-secret-env-value'})
                with self.assertRaisesRegex(common.Error, variable) as result:
                    adapter.check_environment()
                self.assertNotIn('fake-secret-env-value', str(result.exception))

    def test_environment_rejects_non_file_store_and_non_official_provider(self):
        for key, value in (('cli_auth_credentials_store', 'keyring'),
                           ('cli_auth_credentials_store', 'auto'),
                           ('model_provider', 'fixture-provider'),
                           ('forced_login_method', 'api')):
            with self.subTest(key=key, value=value):
                self.config(key + ' = "' + value + '"\n')
                with self.assertRaisesRegex(common.Error, key):
                    self.adapter.check_environment()
        self.config('cli_auth_credentials_store = "file"\nmodel_provider = "openai"\n'
                    'forced_login_method = "chatgpt"\n')
        self.adapter.check_environment()

    def test_child_environment_clears_parent_session_and_keeps_custom_home(self):
        custom_home = self.root / 'custom-codex'
        env = {'CODEX_HOME': str(custom_home), 'PATH': '/fixture/bin'}
        internal = ('CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_APP_TOOLS_PIPE_PATH',
                    'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CODEX_PERMISSION_PROFILE')
        env.update({key: 'parent-session' for key in internal})
        child_env = CodexAdapter(home=self.root, env=env).child_env()
        self.assertEqual(child_env['CODEX_HOME'], str(custom_home))
        self.assertEqual(child_env['PATH'], '/fixture/bin')
        self.assertEqual(child_env['NO_OPEN_BROWSER'], '1')
        self.assertEqual(child_env['BROWSER'], '/usr/bin/true')
        for key in internal:
            self.assertNotIn(key, child_env)
            self.assertIn(key, env)

    def test_snapshot_and_restore_reject_non_object_auth(self):
        self.adapter.auth.write_text('[]')
        with self.assertRaisesRegex(common.Error, '认证文件格式'):
            self.adapter.snapshot()
        with self.assertRaisesRegex(common.Error, '备份格式'):
            self.adapter.restore({'auth': []})


if __name__ == '__main__':
    unittest.main()
