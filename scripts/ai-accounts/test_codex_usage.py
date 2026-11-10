"""Saved quota reads: preserve the execution login and keep credentials off the bridge."""
import base64
import json
from pathlib import Path
import tempfile
import unittest

from codex_adapter import CodexAdapter
from codex_usage import read_saved_usage
from common import Error, Manager
from test_accounts import FakeKeychain


def login(token='fixture-access', account='fixture-account'):
    claims = base64.urlsafe_b64encode(json.dumps({'sub': 'fixture-user'}).encode()).decode().rstrip('=')
    return {'auth': {'auth_mode': 'chatgpt', 'tokens': {
        'id_token': 'fixture.' + claims + '.fixture', 'access_token': token,
        'refresh_token': 'fixture-refresh', 'account_id': account}}}


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.adapter = CodexAdapter(home=self.root, env={
            'DELIVERY_CODEX_BIN': '/usr/bin/true', 'OPENAI_API_KEY': 'fixture-execution-key',
            'OPENAI_BASE_URL': 'https://example.invalid/api'})
        self.adapter.restore({'auth': {'auth_mode': 'apikey', 'OPENAI_API_KEY': 'fixture-execution-key'}})
        self.before = self.adapter.auth.read_bytes()
        self.manager = Manager(self.adapter, FakeKeychain(), self.root / 'saved')
        self.manager.save_snapshot('plan', login())

    def test_isolation_sanitization_and_cleanup(self):
        homes = []
        def query(staged):
            homes.append(staged.config_home)
            self.assertNotEqual(staged.config_home, self.adapter.config_home)
            self.assertNotIn('OPENAI_API_KEY', staged.child_env())
            self.assertNotIn('OPENAI_BASE_URL', staged.child_env())
            self.assertEqual(staged.snapshot(), login())
            self.assertEqual(staged.auth.stat().st_mode & 0o777, 0o600)
            return {'accountId': 'private', 'rateLimits': {'planType': 'pro',
                    'primary': {'usedPercent': 41, 'windowDurationMins': 10080},
                    'credits': {'balance': 'private'}}}
        result = read_saved_usage(self.manager, 'plan', query)
        self.assertEqual(result['rateLimits']['primary']['usedPercent'], 41)
        self.assertNotIn('private', json.dumps(result))
        self.assertNotIn('fixture-access', json.dumps(result))
        self.assertEqual(self.adapter.auth.read_bytes(), self.before)
        self.assertFalse(homes[0].exists())

    def test_valid_credits_are_preserved_when_weekly_window_exhausted(self):
        def query(_):
            return {'rateLimits': {'planType': 'prolite',
                    'primary': {'usedPercent': 100, 'windowDurationMins': 10080},
                    'credits': {'hasCredits': True, 'unlimited': False, 'balance': '34648.47'}}}
        result = read_saved_usage(self.manager, 'plan', query)
        self.assertEqual(result['rateLimits']['credits'],
                         {'hasCredits': True, 'unlimited': False, 'balance': 34648.47})

    def test_rotation_preserved_after_failed_quota_request(self):
        def query(staged):
            staged.restore(login('fixture-renewed'))
            raise Error('quota failed')
        with self.assertRaisesRegex(Error, 'quota failed'):
            read_saved_usage(self.manager, 'plan', query)
        self.assertEqual(self.manager.stored('plan'), login('fixture-renewed'))
        self.assertEqual(self.adapter.auth.read_bytes(), self.before)

    def test_identity_change_is_rejected_without_overwriting_saved_account(self):
        def query(staged):
            staged.restore(login(account='different'))
            return {}
        with self.assertRaisesRegex(Error, '身份发生变化'):
            read_saved_usage(self.manager, 'plan', query)
        self.assertEqual(self.manager.stored('plan'), login())
        self.assertEqual(self.adapter.auth.read_bytes(), self.before)

    def test_concurrent_saved_slot_change_is_not_overwritten(self):
        def query(staged):
            staged.restore(login('fixture-renewed'))
            self.manager.keys.put(self.manager.service, 'plan', json.dumps(login('concurrent')))
            return {}
        with self.assertRaisesRegex(Error, '已保存账号发生变化'):
            read_saved_usage(self.manager, 'plan', query)
        self.assertEqual(self.manager.stored('plan'), login('concurrent'))

    def test_missing_account_and_pending_recovery_do_not_query(self):
        def query(_):
            self.fail('must not query')
        with self.assertRaises(Error):
            read_saved_usage(self.manager, 'missing', query)
        self.manager.db['pending'] = True
        with self.assertRaises(Error):
            read_saved_usage(self.manager, 'plan', query)


if __name__ == '__main__':
    unittest.main()
