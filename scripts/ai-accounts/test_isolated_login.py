import base64
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from claude_adapter import AUTH_FIELD, SERVICE, ClaudeAdapter
from codex_adapter import CodexAdapter
from common import Error, login_resources, write_json


class FakeKeychain:
    def __init__(self):
        self.values = {}
        self.reads = []
        self.writes = []

    def get(self, service, account):
        self.reads.append((service, account))
        return self.values.get((service, account))

    def put(self, service, account, value):
        self.writes.append((service, account))
        if value is None:
            self.values.pop((service, account), None)
        else:
            self.values[(service, account)] = value


class IsolatedLoginTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.binary = self.home / "official-cli-fixture"
        self.binary.write_text("#!/bin/sh\nexit 99\n")
        self.binary.chmod(0o700)
        connection = patch("codex_adapter.socket.create_connection",
                           side_effect=ConnectionRefusedError)
        self.connection = connection.start()
        self.addCleanup(connection.stop)

    def codex(self):
        adapter = CodexAdapter(home=self.home, env={
            "HOME": str(self.home), "DELIVERY_CODEX_BIN": str(self.binary),
            "CODEX_THREAD_ID": "parent-thread",
        })
        adapter.config_home.mkdir()
        (adapter.config_home / "config.toml").write_text(
            'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n'
            'forced_chatgpt_workspace_id = "fixture-workspace"\n'
        )
        payload = base64.urlsafe_b64encode(json.dumps({
            "sub": "fixture-user", "email": "fixture@example.test",
        }).encode()).decode().rstrip("=")
        self.codex_auth = {"auth_mode": "chatgpt", "tokens": {
            "id_token": "header." + payload + ".signature",
            "account_id": "fixture-account", "access_token": "fake-access",
            "refresh_token": "fake-refresh",
        }}
        write_json(adapter.auth, {"native": "untouched"})
        return adapter

    def claude(self):
        keys = FakeKeychain()
        adapter = ClaudeAdapter(keychain=keys, home=self.home, env={
            "HOME": str(self.home), "DELIVERY_CLAUDE_BIN": str(self.binary),
        })
        write_json(adapter.config, {
            "oauthAccount": {"accountUuid": "native-user"}, "theme": "dark",
        })
        write_json(adapter.credentials, {"native": "untouched"})
        write_json(adapter.config_home / "settings.json", {
            "forceLoginMethod": "claudeai", "forceLoginOrgUUID": "fixture-org",
        })
        keys.values[(SERVICE, adapter.account)] = json.dumps({
            AUTH_FIELD: {"accessToken": "fake-native-token"}, "mcpOAuth": {"keep": True},
        })
        self.claude_snapshot = {
            "keychain": {AUTH_FIELD: {
                "accessToken": "fake-new-access", "refreshToken": "fake-new-refresh",
            }},
            "credentials": {},
            "config": {"oauthAccount": {
                "accountUuid": "fixture-user", "emailAddress": "fixture@example.test",
                "organizationUuid": "fixture-org",
            }},
        }
        return adapter, keys

    def files(self):
        return {str(path.relative_to(self.home)): path.read_bytes()
                for path in self.home.rglob("*") if path.is_file()}

    def test_codex_login_keeps_native_auth_and_preserves_policy_in_private_directory(self):
        adapter = self.codex()
        before = self.files()
        with adapter.isolated_login() as staged:
            directory = staged.config_home
            self.assertNotEqual(directory, adapter.config_home)
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
            self.assertFalse(staged.auth.exists())
            self.assertEqual((directory / "config.toml").read_bytes(),
                             (adapter.config_home / "config.toml").read_bytes())
            self.assertEqual(stat.S_IMODE((directory / "config.toml").stat().st_mode), 0o600)
            self.assertEqual(staged.child_env()["HOME"], str(self.home))
            self.assertNotIn("CODEX_THREAD_ID", staged.child_env())
            self.assertEqual(staged.command(), [str(self.binary)])
            staged.restore({"auth": self.codex_auth})
            with patch("codex_adapter.subprocess.run",
                       return_value=subprocess.CompletedProcess([], 0)) as run:
                snapshot = staged.validate()
            self.assertEqual(run.call_args.kwargs["cwd"], directory)
            self.assertEqual(snapshot, {"auth": self.codex_auth})
            self.assertEqual(self.files(), before)
        self.assertFalse(directory.exists())
        self.assertEqual(self.files(), before)
        self.assertEqual(adapter.child_env()["CODEX_HOME"], str(adapter.config_home))

    def test_codex_login_exception_always_removes_private_auth(self):
        adapter = self.codex()
        before = self.files()
        with self.assertRaisesRegex(Error, "cancelled"):
            with adapter.isolated_login() as staged:
                directory = staged.config_home
                staged.restore({"auth": self.codex_auth})
                raise Error("cancelled")
        self.assertFalse(directory.exists())
        self.assertEqual(self.files(), before)

    def test_codex_login_refuses_an_existing_callback_server_without_starting_cli(self):
        adapter = self.codex()
        before = self.files()
        self.connection.side_effect = None
        with patch("codex_adapter.subprocess.run") as run:
            with self.assertRaisesRegex(Error, "已有 Codex 登录进行中"):
                with adapter.isolated_login():
                    self.fail("An occupied callback port must prevent login.")
        self.connection.assert_called_once_with(("127.0.0.1", 1455), timeout=0.25)
        run.assert_not_called()
        self.assertEqual(self.files(), before)

    def test_claude_login_only_uses_private_keychain_and_copies_login_policies(self):
        adapter, keys = self.claude()
        before, native_keys = self.files(), dict(keys.values)
        # Host-managed settings are unrelated to these isolated fixtures.
        with patch.object(ClaudeAdapter, "check_environment"):
            with adapter.isolated_login() as staged:
                directory = staged.config_home
                service = SERVICE + "-" + hashlib.sha256(str(directory).encode()).hexdigest()[:8]
                self.assertEqual(staged.service, service)
                self.assertEqual(staged.config, directory / ".claude.json")
                self.assertEqual(staged.credentials, directory / ".credentials.json")
                self.assertEqual(staged.login_cwd, directory.parent)
                self.assertFalse(staged.config.exists())
                self.assertEqual(staged.command(), [str(self.binary)])
                self.assertEqual(staged.child_env()["HOME"], str(self.home))
                self.assertEqual(staged.child_env()["CLAUDE_CONFIG_DIR"], str(directory))
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)
                self.assertEqual(json.loads((directory / "settings.json").read_text()),
                                 {"forceLoginMethod": "claudeai", "forceLoginOrgUUID": "fixture-org"})
                staged.restore(self.claude_snapshot)
                status = subprocess.CompletedProcess([], 0, json.dumps({
                    "loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
                    "email": "fixture@example.test", "accountUuid": "fixture-user",
                    "orgId": "fixture-org", "configDirectory": str(directory),
                }))
                with patch("claude_adapter.subprocess.run", return_value=status) as run:
                    snapshot = staged.validate()
                self.assertEqual(run.call_args.kwargs["cwd"], directory.parent)
                self.assertEqual({key: snapshot[key] for key in self.claude_snapshot},
                                 self.claude_snapshot)
                self.assertNotIn(str(directory), json.dumps(snapshot))
                self.assertEqual(self.files(), before)
                self.assertTrue(all(key[0] == service for key in keys.reads + keys.writes))
        self.assertFalse(directory.parent.exists())
        self.assertEqual(keys.values, native_keys)
        self.assertEqual(self.files(), before)

    def test_claude_failed_login_cleans_private_keychain_and_files(self):
        adapter, keys = self.claude()
        before, native_keys = self.files(), dict(keys.values)
        with patch.object(ClaudeAdapter, "check_environment"):
            with self.assertRaisesRegex(Error, "cancelled"):
                with adapter.isolated_login() as staged:
                    directory = staged.config_home
                    staged.restore(self.claude_snapshot)
                    raise Error("cancelled")
        self.assertFalse(directory.parent.exists())
        self.assertEqual(keys.values, native_keys)
        self.assertEqual(self.files(), before)

    def test_claude_cleanup_ignores_repeated_cancel_and_restores_handlers(self):
        adapter, keys = self.claude()
        before, native_keys = self.files(), dict(keys.values)
        put = keys.put
        cancelled = []

        def cancel(signum, _frame):
            cancelled.append(signum)
            raise KeyboardInterrupt()

        def delete_with_repeated_cancel(service, account, value):
            if value is None:
                os.kill(os.getpid(), signal.SIGINT)
                os.kill(os.getpid(), signal.SIGINT)
                os.kill(os.getpid(), signal.SIGTERM)
            put(service, account, value)

        handlers = {signum: signal.signal(signum, cancel)
                    for signum in (signal.SIGINT, signal.SIGTERM)}
        try:
            with patch.object(ClaudeAdapter, "check_environment"), \
                    patch.object(keys, "put", side_effect=delete_with_repeated_cancel):
                with adapter.isolated_login() as staged:
                    directory = staged.config_home
                    staged.restore(self.claude_snapshot)
            self.assertEqual(cancelled, [])
            self.assertIs(signal.getsignal(signal.SIGINT), cancel)
            self.assertIs(signal.getsignal(signal.SIGTERM), cancel)
        finally:
            for signum, handler in handlers.items():
                signal.signal(signum, handler)
        self.assertFalse(directory.parent.exists())
        self.assertEqual(keys.values, native_keys)
        self.assertEqual(self.files(), before)

    def test_cleanup_failure_still_removes_directory_and_restores_signal_handlers(self):
        handlers = {signum: signal.getsignal(signum)
                    for signum in (signal.SIGINT, signal.SIGTERM)}

        def fail_cleanup():
            raise Error("fixture cleanup failure")

        with self.assertRaisesRegex(Error, "fixture cleanup failure"):
            with login_resources() as resources:
                directory = resources.enter_context(tempfile.TemporaryDirectory())
                resources.callback(fail_cleanup)
        self.assertFalse(Path(directory).exists())
        for signum, handler in handlers.items():
            self.assertEqual(signal.getsignal(signum), handler)

    def test_claude_validate_rejects_native_config_directory_for_isolated_login(self):
        adapter, keys = self.claude()
        native_keys = dict(keys.values)
        with patch.object(ClaudeAdapter, "check_environment"):
            with self.assertRaisesRegex(Error, "配置目录"):
                with adapter.isolated_login() as staged:
                    directory = staged.config_home
                    staged.restore(self.claude_snapshot)
                    status = subprocess.CompletedProcess([], 0, json.dumps({
                        "loggedIn": True, "authMethod": "claude.ai",
                        "configDirectory": str(adapter.config_home),
                    }))
                    with patch("claude_adapter.subprocess.run", return_value=status):
                        staged.validate()
        self.assertFalse(directory.parent.exists())
        self.assertEqual(keys.values, native_keys)

    def test_claude_only_explicit_private_constructor_allows_config_directory_override(self):
        adapter, keys = self.claude()
        adapter.env["CLAUDE_CONFIG_DIR"] = str(self.home / "arbitrary-config")
        with self.assertRaisesRegex(Error, "环境配置"):
            adapter.check_environment()
        self.assertEqual(keys.reads, [])
        with patch.object(ClaudeAdapter, "check_environment"):
            adapter.env.pop("CLAUDE_CONFIG_DIR")
            with adapter.isolated_login() as staged:
                # Call the original method below outside the class patch.
                private_env = dict(staged.env)
                private_directory = staged.config_home
        private = ClaudeAdapter(keychain=keys, home=self.home, env=private_env,
                                _isolated_config_dir=private_directory)
        with patch.object(private, "_read", return_value={}), \
                patch("claude_adapter.Path.glob", return_value=[]), \
                patch("claude_adapter.Path.exists", return_value=False):
            private.check_environment()
            private.env["CLAUDE_CONFIG_DIR"] = str(self.home / "other")
            with self.assertRaises(Error):
                private.check_environment()
        self.assertEqual(keys.reads, [])


if __name__ == "__main__":
    unittest.main()
