"""Isolated account-switching checks; never access real credentials or settings."""
import copy
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import cursor_accounts as app


class FakeKeychain:
    def __init__(self):
        self.values = {}
        self.writes = []

    def get(self, service, account):
        return self.values.get((service, account))

    def put(self, service, account, value):
        self.writes.append((service, account))
        if value is None:
            self.values.pop((service, account), None)
        else:
            self.values[service, account] = value


def snapshot(email, token, team='Example', team_id=1):
    return {
        'credentials': {
            'cursor-access-token': token,
            'cursor-refresh-token': token + '-refresh',
            'cursor-api-key': None,
        },
        'authInfo': {'email': email, 'teamName': team, 'teamId': team_id},
    }


class KeychainJSONTests(unittest.TestCase):
    def test_plain_and_security_hex_unicode_json_objects_are_compatible(self):
        saved = snapshot('fixture@example.test', 'fake-token', '研发团队')
        saved['authInfo']['displayName'] = '测试账号 🚀'
        plain = json.dumps(saved, ensure_ascii=False)
        for value in (plain, json.dumps(saved), plain.encode('utf-8').hex(),
                      plain.encode('utf-8').hex().upper()):
            with self.subTest(encoding='hex' if value[:2].lower() == '7b' else 'json'):
                self.assertEqual(app.keychain_json(value), saved)

    def test_bad_hex_utf8_json_and_non_objects_have_only_fixed_safe_error(self):
        secret = 'fixture-sensitive-credential'
        invalid_json = '{"token":"' + secret + '",'
        invalid = (
            None, b'{}', '', '7b1', '7g', '7b 7d', 'fffe', invalid_json,
            invalid_json.encode().hex(), '["' + secret + '"]',
            ('["' + secret + '"]').encode().hex(), json.dumps(secret), 'null', '616263',
        )
        for index, value in enumerate(invalid):
            with self.subTest(case=index), self.assertRaises(app.Error) as caught:
                app.keychain_json(value)
            self.assertEqual(str(caught.exception), '账号凭据格式无法读取，请重新登录该账号。')
            self.assertNotIn(secret, str(caught.exception))
            self.assertNotIn(secret.encode().hex(), str(caught.exception))

    def test_native_hex_looking_tokens_are_returned_unchanged(self):
        for token in ('7b7d', 'deadbeef', '616263'):
            with self.subTest(token=token), patch.object(app.subprocess, 'run',
                    return_value=Mock(returncode=0, stdout=token + '\n')) as run:
                self.assertEqual(app.Keychain().get('cursor-access-token', 'cursor-user'), token)
                self.assertEqual(run.call_args.args[0], ['/usr/bin/security', 'find-generic-password',
                                 '-s', 'cursor-access-token', '-a', 'cursor-user', '-w'])
                self.assertTrue(run.call_args.kwargs['capture_output'])


class KeychainWriteTests(unittest.TestCase):
    def test_large_credentials_bypass_the_interactive_parser_and_subprocess_arguments(self):
        credential = json.dumps({'tokens': {'id_token': 'fixture-' * 6000}, 'name': '测试'})
        with patch.object(app, 'put_password', return_value=0) as write, \
                patch.object(app.subprocess, 'run', side_effect=AssertionError('No subprocess credential writes')):
            app.Keychain().put('fixture-service', 'fixture-account', credential)
        write.assert_called_once_with('fixture-service', 'fixture-account', credential)

    def test_native_write_failure_has_only_a_safe_status_and_preserves_existing_item(self):
        credential = 'fixture-secret'
        with patch.object(app, 'put_password', return_value=-25293), \
                patch.object(app.subprocess, 'run') as run, self.assertRaises(app.Error) as caught:
            app.Keychain().put('fixture-service', 'fixture-account', credential)
        self.assertEqual(str(caught.exception), '钥匙串写入失败（代码 -25293）；原账号备份仍保留。')
        self.assertNotIn(credential, str(caught.exception))
        run.assert_not_called()

    def test_control_characters_are_rejected_before_native_access(self):
        for field in range(3):
            for character in ('\n', '\r', '\0'):
                arguments = ['fixture-service', 'fixture-account', 'fixture-secret']
                arguments[field] += character
                with self.subTest(field=field, character=repr(character)), \
                        patch.object(app, 'put_password') as write, self.assertRaises(app.Error):
                    app.Keychain().put(*arguments)
                write.assert_not_called()

    def test_delete_still_uses_security_and_missing_item_is_idempotent(self):
        with patch.object(app.subprocess, 'run', return_value=Mock(returncode=44)) as run, \
                patch.object(app, 'put_password') as write:
            app.Keychain().put('fixture-service', 'fixture-account', None)
        self.assertEqual(run.call_args.args[0], ['/usr/bin/security', 'delete-generic-password',
                                              '-s', 'fixture-service', '-a', 'fixture-account'])
        write.assert_not_called()


class AccountIdentityTests(unittest.TestCase):
    def test_stable_user_id_and_selected_team_take_precedence(self):
        first = snapshot('old@example.test', 'fake-old', team_id=1)
        first['authInfo'].update(userId='user-1', authId='auth-old', activeTeamId=2)
        second = snapshot('new@example.test', 'fake-new', team='Renamed team', team_id='2')
        second['authInfo'].update(userId='user-1', authId='auth-new')
        self.assertEqual(app.account_identity(first), app.account_identity(second))
        second['authInfo']['userId'] = 'user-2'
        self.assertNotEqual(app.account_identity(first), app.account_identity(second))

    def test_auth_id_fallback_and_team_or_organization_separate_accounts(self):
        first = snapshot('work@example.test', 'fake-one')
        first['authInfo'].update(authId='auth-1', organizationId='org-1')
        changed_email = copy.deepcopy(first)
        changed_email['authInfo']['email'] = 'different@example.test'
        self.assertEqual(app.account_identity(first), app.account_identity(changed_email))
        for changes in ({'activeTeamId': 0}, {'teamId': 2}, {'organizationId': 'org-2'}):
            other = copy.deepcopy(first)
            other['authInfo'].update(changes)
            with self.subTest(changes=changes):
                self.assertNotEqual(app.account_identity(first), app.account_identity(other))

    def test_email_fallback_casefolds_but_preserves_missing_team_id_name(self):
        first = snapshot('Work@Example.test', 'fake-one', team='L123', team_id=None)
        second = snapshot('work@example.test', 'fake-two', team='L123', team_id=None)
        self.assertEqual(app.account_identity(first), app.account_identity(second))
        second['authInfo']['teamName'] = '另一个团队'
        self.assertNotEqual(app.account_identity(first), app.account_identity(second))
        self.assertEqual(app.account_identity({'authInfo': {}}), '')


class AccountTests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        self.enterContext = stack.enter_context
        temp = self.enterContext(tempfile.TemporaryDirectory())
        self.root = Path(temp)
        self.enterContext(patch.object(app, 'DATA', self.root / 'data'))
        self.enterContext(patch.object(app, 'CONFIG', self.root / 'cli-config.json'))
        self.enterContext(patch.object(app, 'Keychain', side_effect=AssertionError('Real Keychain forbidden')))
        self.idle = self.enterContext(patch.object(app, 'active_agents', return_value=[]))
        self.enterContext(patch.object(app, 'cursor_command', return_value=['fake-cursor']))
        self.run = self.enterContext(patch.object(app.subprocess, 'run', side_effect=AssertionError('Real process forbidden')))
        self.call = self.enterContext(patch.object(app.subprocess, 'call', side_effect=AssertionError('Real process forbidden')))
        self.enterContext(patch('sys.stdout', new=io.StringIO()))
        self.keys = FakeKeychain()
        self.manager = app.Manager(self.keys)
        self.work = snapshot('work@example.test', 'fake-work')
        self.personal = snapshot('personal@example.test', 'fake-personal', 'Old team', 2)
        self.manager.save_snapshot('work', self.work)
        self.manager.save_snapshot('personal', self.personal)
        app.write_json(app.CONFIG, {'theme': 'dark', 'permissions': {'shell': False},
                                    'privacyCache': {'old': True}})
        self.manager.restore_snapshot(self.work)
        self.keys.writes.clear()

    def config(self):
        return app.read_json(app.CONFIG, {})

    def assert_current(self, expected):
        self.assertEqual(self.manager.snapshot(), expected)
        self.assertFalse(self.manager.db['pending'])
        self.assertFalse(app.read_json(app.DATA / 'accounts.json', {})['pending'])

    def test_delete_saved_copy_preserves_current_login_and_recovery(self):
        self.keys.put(app.SERVICE, '@previous', json.dumps(self.personal))
        self.keys.writes.clear()
        self.manager.delete('work')
        self.assertEqual(self.keys.writes, [(app.SERVICE, 'work')])
        self.assertIsNone(self.keys.get(app.SERVICE, 'work'))
        self.assertNotIn('work', app.Manager(self.keys).db['accounts'])
        self.assertEqual(self.manager.stored('personal'), self.personal)
        self.assertEqual(self.manager.stored('@previous'), self.personal)
        self.assert_current(self.work)

    def test_delete_restores_keychain_copy_if_metadata_write_fails(self):
        with patch.object(self.manager, 'commit', side_effect=OSError('fixture write failed')):
            with self.assertRaisesRegex(OSError, 'fixture write failed'):
                self.manager.delete('work')
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertIn('work', app.Manager(self.keys).db['accounts'])
        self.assert_current(self.work)

    def test_switch_preserves_settings_and_updates_team(self):
        verified = dict(self.personal['authInfo'], teamName='New team', teamId=3)
        with patch.object(self.manager, 'verify', return_value=verified):
            self.manager.use('personal')
        self.assertEqual(self.config()['theme'], 'dark')
        self.assertEqual(self.config()['permissions'], {'shell': False})
        self.assertNotIn('privacyCache', self.config())
        self.assertEqual(self.manager.stored('personal')['authInfo'], verified)
        self.assertEqual(self.config()['authInfo'], verified)
        self.assert_current(dict(self.personal, authInfo=verified))
        self.assertEqual(self.manager.db['accounts']['personal']['identity'],
                         app.account_identity(dict(self.personal, authInfo=verified)))

    def test_new_alias_refreshes_canonical_credentials_without_adding_slot(self):
        refreshed = snapshot('WORK@example.test', 'fake-refreshed', team='Updated team')
        refreshed['authInfo']['displayName'] = '官方显示名 L123'
        before_config = app.CONFIG.read_bytes()
        self.assertEqual(self.manager.save_snapshot('work-copy', refreshed), 'work')
        self.assertEqual(list(self.manager.db['accounts']), ['work', 'personal'])
        self.assertEqual(self.manager.stored('work'), refreshed)
        self.assertIsNone(self.keys.get(app.SERVICE, 'work-copy'))
        self.assertEqual(self.keys.writes, [(app.SERVICE, 'work')])
        self.assertEqual(self.manager.db['accounts']['work'], {
            'email': 'WORK@example.test', 'team': 'Updated team', 'displayName': '官方显示名 L123',
            'identity': app.account_identity(refreshed)})
        self.assertEqual(app.CONFIG.read_bytes(), before_config)
        self.assert_current(self.work)

    def test_login_same_identity_refreshes_existing_slot_without_new_alias(self):
        refreshed = snapshot('personal@example.test', 'fake-login-refreshed', team='Updated team', team_id=2)
        refreshed['authInfo']['displayName'] = '官方显示名'
        self.call.side_effect = lambda *args: self.manager.restore_snapshot(refreshed) or 0
        with patch.object(self.manager, 'verify', return_value=refreshed['authInfo']):
            self.manager.login('new-alias')
        self.assertEqual(list(self.manager.db['accounts']), ['work', 'personal'])
        self.assertEqual(self.manager.stored('personal'), refreshed)
        self.assertIsNone(self.keys.get(app.SERVICE, 'new-alias'))
        self.assert_current(refreshed)

    def test_save_existing_name_rejects_same_email_different_team_without_writes(self):
        other_team = snapshot('work@example.test', 'fake-other-team', team='Other team', team_id=2)
        self.manager.save_snapshot('other-team', other_team)
        self.manager.restore_snapshot(other_team)
        before_config = app.CONFIG.read_bytes()
        before_db = (app.DATA / 'accounts.json').read_bytes()
        before_keys = copy.deepcopy(self.keys.values)
        self.keys.writes.clear()
        with patch.object(self.manager, 'verify', return_value=other_team['authInfo']):
            with self.assertRaisesRegex(app.Error, '属于另一个账号'):
                self.manager.save('work')
        self.assertEqual(self.keys.writes, [])
        self.assertEqual(self.keys.values, before_keys)
        self.assertEqual(app.CONFIG.read_bytes(), before_config)
        self.assertEqual((app.DATA / 'accounts.json').read_bytes(), before_db)
        self.assert_current(other_team)

    def test_legacy_login_different_team_rolls_back_without_merging_saved_accounts(self):
        other_team = snapshot('work@example.test', 'fake-other-team', team='Other team', team_id=2)
        self.manager.save_snapshot('other-team', other_team)
        before_accounts = copy.deepcopy(self.manager.db['accounts'])
        self.call.side_effect = lambda *args: self.manager.restore_snapshot(other_team) or 0
        with patch.object(self.manager, 'verify', return_value=other_team['authInfo']):
            with self.assertRaisesRegex(app.Error, '已有名称不一致'):
                self.manager.login('work')
        self.assert_current(self.work)
        self.assertEqual(self.manager.db['accounts'], before_accounts)
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.manager.stored('other-team'), other_team)
        self.assertEqual(self.manager.stored('@previous'), self.work)

    def test_same_user_different_teams_and_organizations_keep_separate_slots(self):
        primary = copy.deepcopy(self.work)
        primary['authInfo'].update(userId='same-user', organizationId='org-1')
        self.manager.save_snapshot('work', primary)
        for name, changes in (('other-team', {'teamId': 2}), ('other-org', {'organizationId': 'org-2'})):
            other = copy.deepcopy(primary)
            other['authInfo'].update(changes)
            self.assertEqual(self.manager.save_snapshot(name, other), name)
            self.assertEqual(self.manager.stored(name), other)
        self.assertEqual(list(self.manager.db['accounts']), ['work', 'personal', 'other-team', 'other-org'])

    def legacy_slot(self, name, saved, encoded=False):
        raw = json.dumps(saved, ensure_ascii=False)
        self.keys.values[app.SERVICE, name] = raw.encode().hex() if encoded else raw
        self.manager.db['accounts'][name] = {'email': saved['authInfo']['email'],
                                             'team': saved['authInfo'].get('teamName', '')}

    def test_new_alias_merges_legacy_metadata_and_refreshes_newest_slot(self):
        self.legacy_slot('work-copy', self.work)
        old_work = self.keys.get(app.SERVICE, 'work')
        refreshed = snapshot('work@example.test', 'fresh-token')
        self.assertEqual(self.manager.save_snapshot('another-alias', refreshed), 'work-copy')
        self.assertEqual(list(self.manager.db['accounts']), ['personal', 'work-copy'])
        self.assertEqual(self.manager.stored('work-copy'), refreshed)
        self.assertEqual(self.keys.get(app.SERVICE, 'work'), old_work)
        self.assertEqual(self.keys.writes, [(app.SERVICE, 'work-copy')])

    def test_deduplicate_keeps_last_slot_and_only_rewrites_metadata(self):
        middle = snapshot('WORK@example.test', 'middle-token')
        newest = snapshot('work@example.test', 'newest-token', team='研发团队')
        newest['authInfo']['displayName'] = '官方名称 🚀'
        other_team = snapshot('work@example.test', 'other-team-token', team='其他团队', team_id=3)
        self.legacy_slot('work-copy', middle)
        self.legacy_slot('work-newest', newest, encoded=True)
        self.legacy_slot('other-team', other_team)
        self.manager.commit()
        before_keys = copy.deepcopy(self.keys.values)
        before_config = app.CONFIG.read_bytes()
        self.assertEqual(self.manager.deduplicate(), ['work', 'work-copy'])
        self.assertEqual(list(self.manager.db['accounts']), ['personal', 'work-newest', 'other-team'])
        self.assertEqual(self.manager.db['accounts']['work-newest'], {
            'email': 'work@example.test', 'team': '研发团队', 'displayName': '官方名称 🚀',
            'identity': app.account_identity(newest)})
        self.assertEqual(self.keys.values, before_keys)
        self.assertEqual(self.keys.writes, [])
        self.assertEqual(app.CONFIG.read_bytes(), before_config)
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.manager.stored('work-copy'), middle)
        self.assertEqual(self.manager.stored('work-newest'), newest)
        self.assertEqual(self.manager.deduplicate(), [])

    def test_deduplicate_pending_recovery_is_rejected_without_mutation(self):
        self.legacy_slot('work-copy', self.work)
        self.manager.db['pending'] = True
        self.manager.commit()
        before_db = (app.DATA / 'accounts.json').read_bytes()
        before_keys = copy.deepcopy(self.keys.values)
        with self.assertRaisesRegex(app.Error, '被中断'):
            self.manager.deduplicate()
        self.assertEqual((app.DATA / 'accounts.json').read_bytes(), before_db)
        self.assertEqual(self.keys.values, before_keys)
        self.assertEqual(self.keys.writes, [])

    def test_switch_to_duplicate_slot_retains_newest_current_credentials(self):
        self.legacy_slot('work-copy', self.work)
        refreshed = copy.deepcopy(self.work)
        refreshed['credentials']['cursor-access-token'] = 'fake-refreshed'
        self.manager.restore_snapshot(refreshed)
        with patch.object(self.manager, 'verify', return_value=refreshed['authInfo']):
            self.manager.use('work-copy')
        self.assert_current(refreshed)
        self.assertEqual(self.manager.stored('work-copy'), refreshed)
        self.assertNotIn('work', self.manager.db['accounts'])
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.manager.stored('personal'), self.personal)

    def test_unicode_hex_profile_switches_without_overwriting_other_accounts(self):
        target = copy.deepcopy(self.personal)
        target['authInfo'].update(displayName='测试账号', teamName='研发团队')
        other = snapshot('other@example.test', 'fake-other', '其他团队')
        for name, saved in (('personal', target), ('other', other)):
            self.manager.save_snapshot(name, saved)
            self.keys.values[app.SERVICE, name] = json.dumps(saved, ensure_ascii=False).encode().hex()
        other_raw = self.keys.get(app.SERVICE, 'other')
        with patch.object(self.manager, 'verify', return_value=target['authInfo']):
            self.manager.use('personal')
        self.assert_current(target)
        self.assertEqual(self.manager.stored('personal'), target)
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.manager.stored('@previous'), self.work)
        self.assertEqual(self.manager.stored('other'), other)
        self.assertEqual(self.keys.get(app.SERVICE, 'other'), other_raw)

    def test_unicode_hex_profile_validation_failure_rolls_back_without_overwrite(self):
        target = copy.deepcopy(self.personal)
        target['authInfo'].update(displayName='中文显示名', teamName='研发团队')
        encoded = json.dumps(target, ensure_ascii=False).encode().hex()
        self.manager.save_snapshot('personal', target)
        self.keys.values[app.SERVICE, 'personal'] = encoded
        other = snapshot('other@example.test', 'fake-other', '其他团队')
        self.manager.save_snapshot('other', other)
        other_raw = self.keys.get(app.SERVICE, 'other')
        with patch.object(self.manager, 'verify', side_effect=app.Error('fixture validation failed')):
            with self.assertRaisesRegex(app.Error, 'fixture validation failed'):
                self.manager.use('personal')
        self.assert_current(self.work)
        self.assertEqual(self.manager.stored('personal'), target)
        self.assertEqual(self.keys.get(app.SERVICE, 'personal'), encoded)
        self.assertEqual(self.manager.stored('work'), self.work)
        self.assertEqual(self.keys.get(app.SERVICE, 'other'), other_raw)

    def test_profile_shape_rejected_before_writes_without_credential_disclosure(self):
        for malformed in ({'credentials': [], 'authInfo': {}},
                          {'credentials': {}, 'authInfo': 'fixture-sensitive'},
                          {'authInfo': {}}, {'credentials': {}}):
            for encoded in (False, True):
                with self.subTest(fields=list(malformed), hex=encoded):
                    raw = json.dumps(malformed)
                    self.keys.values[app.SERVICE, 'personal'] = raw.encode().hex() if encoded else raw
                    self.keys.writes.clear()
                    with self.assertRaises(app.Error) as caught:
                        self.manager.stored('personal')
                    self.assertEqual(str(caught.exception), '账号凭据格式无法读取，请重新登录该账号。')
                    self.assertEqual(self.keys.writes, [])
                    self.assert_current(self.work)

    def test_switch_failure_restores_original_account(self):
        with patch.object(self.manager, 'verify', side_effect=app.Error('network unavailable')):
            with self.assertRaisesRegex(app.Error, 'network unavailable'):
                self.manager.use('personal')
        self.assert_current(self.work)
        self.assertEqual(self.manager.stored('personal'), self.personal)

    def test_wrong_verified_account_rolls_back(self):
        with patch.object(self.manager, 'verify', return_value=self.work['authInfo']):
            with self.assertRaisesRegex(app.Error, '校验不一致'):
                self.manager.use('personal')
        self.assert_current(self.work)

    def test_cancelled_login_rolls_back(self):
        def cancelled_login(*args):
            self.manager.restore_snapshot(self.personal)
            raise KeyboardInterrupt
        self.call.side_effect = cancelled_login
        with self.assertRaises(KeyboardInterrupt):
            self.manager.login('new')
        self.assert_current(self.work)
        self.assertNotIn('new', self.manager.db['accounts'])

    def test_failed_login_rolls_back(self):
        def failed_login(*args):
            self.manager.restore_snapshot(self.personal)
            return 1
        self.call.side_effect = failed_login
        with self.assertRaisesRegex(app.Error, '登录未完成'):
            self.manager.login('new')
        self.assert_current(self.work)
        self.assertNotIn('new', self.manager.db['accounts'])

    def test_refresh_current_slot_before_switching_to_same_account(self):
        refreshed = copy.deepcopy(self.work)
        refreshed['credentials']['cursor-access-token'] = 'fake-refreshed'
        self.manager.restore_snapshot(refreshed)
        with patch.object(self.manager, 'verify', return_value=refreshed['authInfo']):
            self.manager.use('work')
        self.assert_current(refreshed)
        self.assertEqual(self.manager.stored('work'), refreshed)

    def test_refresh_outgoing_slot_when_switching_accounts(self):
        refreshed = copy.deepcopy(self.work)
        refreshed['credentials']['cursor-access-token'] = 'fake-refreshed'
        self.manager.restore_snapshot(refreshed)
        with patch.object(self.manager, 'verify', return_value=self.personal['authInfo']):
            self.manager.use('personal')
        self.assert_current(self.personal)
        self.assertEqual(self.manager.stored('work'), refreshed)
        self.assertEqual(self.manager.stored('@previous'), refreshed)

    def test_stale_cached_email_does_not_overwrite_another_account(self):
        current = copy.deepcopy(self.personal)
        current['credentials']['cursor-access-token'] = 'fake-personal-refreshed'
        current['authInfo'] = self.work['authInfo']
        self.manager.restore_snapshot(current)
        with patch.object(self.manager, 'verify', return_value=self.work['authInfo']):
            self.manager.use('work')
        self.assert_current(self.work)
        self.assertEqual(self.manager.stored('work'), self.work)
        expected_personal = copy.deepcopy(self.personal)
        expected_personal['credentials'] = current['credentials']
        self.assertEqual(self.manager.stored('personal'), expected_personal)

    def test_same_email_different_active_teams_do_not_share_refresh_slot(self):
        primary = copy.deepcopy(self.work)
        primary['authInfo']['activeTeamId'] = 1
        alternate = copy.deepcopy(primary)
        alternate['authInfo'].update(activeTeamId=2, teamId=2, teamName='Other team')
        self.manager.save_snapshot('work', primary)
        self.manager.save_snapshot('work-alt', alternate)
        refreshed = copy.deepcopy(primary)
        refreshed['credentials']['cursor-access-token'] = 'fake-work-refreshed'
        self.manager.restore_snapshot(refreshed)
        with patch.object(self.manager, 'verify', return_value=self.personal['authInfo']):
            self.manager.use('personal')
        self.assert_current(self.personal)
        self.assertEqual(self.manager.stored('work'), refreshed)
        self.assertEqual(self.manager.stored('work-alt'), alternate)

    def test_api_key_identity_refresh_preserves_stored_auth_info(self):
        saved = copy.deepcopy(self.work)
        saved['credentials'].update({'cursor-refresh-token': None, 'cursor-api-key': 'fake-key'})
        self.manager.save_snapshot('work', saved)
        current = copy.deepcopy(saved)
        current['credentials']['cursor-access-token'] = 'fake-work-refreshed'
        current['authInfo'].update(email='stale@example.test', teamName='Stale team')
        self.manager.restore_snapshot(current)
        with patch.object(self.manager, 'verify', return_value=self.personal['authInfo']):
            self.manager.use('personal')
        expected = copy.deepcopy(saved)
        expected['credentials'] = current['credentials']
        self.assertEqual(self.manager.stored('work'), expected)

    def test_explicit_team_mismatch_rolls_back(self):
        target = copy.deepcopy(self.personal)
        target['authInfo']['activeTeamId'] = 2
        self.manager.save_snapshot('personal', target)
        verified = dict(target['authInfo'], teamId=3, teamName='Wrong team')
        with patch.object(self.manager, 'verify', return_value=verified):
            with self.assertRaises(app.Error):
                self.manager.use('personal')
        self.assert_current(self.work)
        self.assertEqual(self.manager.stored('personal'), target)

    def test_login_clears_old_api_key_and_failure_restores_it(self):
        original = copy.deepcopy(self.work)
        original['credentials']['cursor-api-key'] = 'fake-old-api-key'
        self.manager.restore_snapshot(original)

        def failed_login(*args):
            self.assertIsNone(self.keys.get('cursor-api-key', 'cursor-user'))
            return 1
        self.call.side_effect = failed_login
        with self.assertRaisesRegex(app.Error, '登录未完成'):
            self.manager.login('new')
        self.assert_current(original)

    def test_busy_process_blocks_mutation_without_writes(self):
        self.idle.return_value = ['1234']
        before_config = app.CONFIG.read_bytes()
        before_db = (app.DATA / 'accounts.json').read_bytes()
        before_keys = copy.deepcopy(self.keys.values)
        for operation in (lambda: self.manager.use('personal'),
                          lambda: self.manager.login('new'), self.manager.restore):
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(app.Error, '1234'):
                    operation()
                self.assertEqual(self.keys.writes, [])
                self.assertEqual(self.keys.values, before_keys)
                self.assertEqual(app.CONFIG.read_bytes(), before_config)
                self.assertEqual((app.DATA / 'accounts.json').read_bytes(), before_db)
        self.call.assert_not_called()
        self.run.assert_not_called()

    def test_pending_operation_blocks_new_work_and_can_recover(self):
        self.keys.put(app.SERVICE, '@previous', json.dumps(self.work))
        self.manager.restore_snapshot(self.personal)
        self.manager.db['pending'] = True
        self.manager.commit()
        self.manager = app.Manager(self.keys)
        self.keys.writes.clear()
        for operation in (lambda: self.manager.save('new'),
                          lambda: self.manager.use('work'), lambda: self.manager.login('new')):
            with self.assertRaisesRegex(app.Error, '被中断'):
                operation()
        self.assertEqual(self.keys.writes, [])
        self.manager.restore()
        self.assert_current(self.work)

    def test_failed_restore_keeps_pending_until_recovered(self):
        self.keys.put(app.SERVICE, '@previous', json.dumps(self.work))
        self.manager.restore_snapshot(self.personal)
        real_put = self.keys.put

        def interrupted_put(service, account, value):
            self.assertTrue(self.manager.db['pending'])
            self.assertTrue(app.read_json(app.DATA / 'accounts.json', {})['pending'])
            if service == 'cursor-refresh-token':
                raise app.Error('keychain write failed')
            real_put(service, account, value)
        with patch.object(self.keys, 'put', side_effect=interrupted_put):
            with self.assertRaisesRegex(app.Error, 'keychain write failed'):
                self.manager.restore()
        self.assertTrue(self.manager.db['pending'])
        self.assertTrue(app.read_json(app.DATA / 'accounts.json', {})['pending'])
        self.manager = app.Manager(self.keys)
        self.manager.restore()
        self.assert_current(self.work)

    def test_config_and_endpoint_environment_overrides_are_rejected(self):
        with patch.dict(app.os.environ, {}, clear=True):
            app.check_environment()
        for variable in ('XDG_CONFIG_HOME', 'CURSOR_API_ENDPOINT', 'CURSOR_CONFIG_DIR',
                         'CURSOR_API_KEY', 'CURSOR_AUTH_TOKEN'):
            with self.subTest(variable=variable), patch.dict(app.os.environ, {variable: 'override'}, clear=True):
                with self.assertRaisesRegex(app.Error, variable):
                    app.check_environment()

    def test_name_validation(self):
        for name in ('work', 'A1_b-c', 'x' * 40):
            self.assertEqual(app.valid_name(name), name)
        for name in ('', '@previous', '../work', '/tmp/account', 'a b', '-work', '_work',
                     '中文', 'x' * 41, 'work\n'):
            with self.subTest(name=name), self.assertRaises(app.Error):
                app.valid_name(name)


if __name__ == '__main__':
    unittest.main()
