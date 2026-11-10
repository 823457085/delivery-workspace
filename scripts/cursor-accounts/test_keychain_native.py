"""Opt-in macOS checks using synthetic values and a disposable Keychain only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from cursor_accounts import keychain_json
import keychain_native
from keychain_native import put_password


@unittest.skipUnless(sys.platform == 'darwin' and os.environ.get('DELIVERY_TEST_TEMP_KEYCHAIN') == '1',
                     'Set DELIVERY_TEST_TEMP_KEYCHAIN=1 for isolated macOS Keychain checks')
class NativeKeychainTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='delivery-keychain-test-')
        self.addCleanup(self.directory.cleanup)
        self.keychain = str(Path(self.directory.name) / 'fixture.keychain-db')
        self.security('-i', input='create-keychain -p fixture-only "' + self.keychain + '"\n')
        self.addCleanup(self.security, 'delete-keychain', self.keychain)

    def security(self, *arguments, **kwargs):
        return subprocess.run(['/usr/bin/security', *arguments], capture_output=True,
                              text=True, timeout=10, check=True, **kwargs)

    def read(self, account):
        return self.security('find-generic-password', '-s', 'fixture-service', '-a', account,
                             '-w', self.keychain).stdout.rstrip('\n')

    def test_create_update_and_security_read_preserve_large_unicode_json_and_acl(self):
        first = {'auth': {'tokens': {'id_token': 'fixture-' * 4096}}, 'name': '测试账号 🚀'}
        second = {'auth': {'tokens': {'access_token': 'new-fixture-' * 8192}}, 'name': '研发团队'}
        for value in (first, second):
            self.assertEqual(put_password('fixture-service', 'native', json.dumps(value, ensure_ascii=False),
                                          self.keychain), 0)
            self.assertEqual(keychain_json(self.read('native')), value)
        access = self.security('dump-keychain', '-a', self.keychain).stdout
        self.assertIn('/usr/bin/security', access)
        self.assertNotIn('<any>', access)

    def test_updates_existing_security_item_without_changing_its_access_policy(self):
        self.security('-i', input='add-generic-password -s fixture-service -a legacy -w previous "' +
                      self.keychain + '"\n')
        before = self.security('dump-keychain', '-a', self.keychain).stdout
        value = 'fixture-long-token-' * 2048
        self.assertEqual(put_password('fixture-service', 'legacy', value, self.keychain), 0)
        self.assertEqual(self.read('legacy'), value)
        after = self.security('dump-keychain', '-a', self.keychain).stdout
        self.assertEqual(before[before.index('access:'):], after[after.index('access:'):])

    def test_unavailable_keychain_returns_failure_without_touching_default_keychain(self):
        self.assertNotEqual(put_password('fixture-service', 'missing', 'fixture-value',
                                         self.keychain + '.missing'), 0)

    def test_locked_keychain_fails_without_prompt_and_preserves_existing_password(self):
        self.assertEqual(put_password('fixture-service', 'locked', 'fixture-before', self.keychain), 0)
        self.security('lock-keychain', self.keychain)
        self.assertNotEqual(put_password('fixture-service', 'locked', 'fixture-after', self.keychain), 0)
        self.assertNotEqual(put_password('fixture-service', 'new-locked', 'fixture-after', self.keychain), 0)
        self.security('-i', input='unlock-keychain -p fixture-only "' + self.keychain + '"\n')
        self.assertEqual(self.read('locked'), 'fixture-before')

    def test_failed_native_write_preserves_old_item_and_removes_only_new_placeholder(self):
        self.assertEqual(put_password('fixture-service', 'existing', 'fixture-before', self.keychain), 0)
        load = keychain_native.ctypes.CDLL
        native = load('/System/Library/Frameworks/Security.framework/Security')
        native.SecKeychainItemModifyAttributesAndData = lambda *_: -25293
        with patch.object(keychain_native.ctypes, 'CDLL', side_effect=lambda path:
                          native if path.endswith('/Security') else load(path)):
            for account in ('existing', 'new'):
                self.assertEqual(put_password('fixture-service', account, 'fixture-after', self.keychain), -25293)
        self.assertEqual(self.read('existing'), 'fixture-before')
        missing = subprocess.run(['/usr/bin/security', 'find-generic-password', '-s', 'fixture-service',
                                  '-a', 'new', self.keychain], capture_output=True, timeout=10)
        self.assertEqual(missing.returncode, 44)


if __name__ == '__main__':
    unittest.main()
