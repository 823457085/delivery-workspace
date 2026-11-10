import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from claude_adapter import AUTH_FIELD, SERVICE, ClaudeAdapter, Error


class FakeKeychain:
    def __init__(self):
        self.values = {}
        self.gets = 0

    def get(self, service, account):
        self.gets += 1
        return self.values.get((service, account))

    def put(self, service, account, value):
        if value is None:
            self.values.pop((service, account), None)
        else:
            self.values[(service, account)] = value


class ClaudeAdapterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.keychain = FakeKeychain()
        self.binary = self.home / "claude"
        self.binary.write_text("#!/bin/sh\nexit 99\n")
        self.binary.chmod(0o700)
        self.adapter = ClaudeAdapter(
            keychain=self.keychain, home=self.home,
            env={"DELIVERY_CLAUDE_BIN": str(self.binary), "PATH": "/usr/bin:/bin"},
        )
        self.oauth = {"accessToken": "fake-access", "refreshToken": "fake-refresh",
                      "scopes": ["user:inference"], "expiresAt": 4102444800000}
        self.account = {"accountUuid": "account-a", "emailAddress": "a@example.test",
                        "organizationUuid": "org-a", "organizationName": "Team A"}
        # No production settings are consulted by isolated tests.
        self.environment_check = patch.object(self.adapter, "check_environment")
        self.environment_check.start()
        self.addCleanup(self.environment_check.stop)

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def seed(self, oauth=True):
        self.keychain.put(SERVICE, self.adapter.account, json.dumps({
            **({AUTH_FIELD: self.oauth} if oauth else {}), "mcpOAuth": {"keep": "original"},
        }))
        self.write(self.adapter.config, {
            **({"oauthAccount": self.account} if oauth else {}),
            "theme": "dark", "projects": {"project-a": {"trust": True}},
        })
        self.write(self.adapter.credentials, {"unrelated": {"keep": 7}})

    def status(self, **overrides):
        value = {
            "loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
            "email": "a@example.test", "orgId": "org-a", "orgName": "Team A",
            "configDirectory": str(self.home / ".claude"),
        }
        value.update(overrides)
        return subprocess.CompletedProcess([], 0, json.dumps(value), "secret-stderr")

    def test_restore_only_auth_fields_and_preserves_latest_unrelated_values(self):
        self.seed()
        original = self.adapter.snapshot()
        self.assertEqual(set(original["keychain"]), {AUTH_FIELD})
        self.assertEqual(set(original["config"]), {"oauthAccount"})
        self.adapter.restore({})
        cleared = json.loads(self.keychain.get(SERVICE, self.adapter.account))
        self.assertEqual(cleared, {"mcpOAuth": {"keep": "original"}})
        config = json.loads(self.adapter.config.read_text())
        self.assertNotIn("oauthAccount", config)
        config["theme"] = "light"
        self.write(self.adapter.config, config)
        self.adapter.restore(original)
        self.assertEqual(self.adapter.snapshot(), original)
        config = json.loads(self.adapter.config.read_text())
        self.assertEqual(config["theme"], "light")
        self.assertEqual(config["projects"], {"project-a": {"trust": True}})

    def test_plain_and_hex_unicode_native_json_preserve_other_fields_on_restore(self):
        self.seed()
        native = {AUTH_FIELD: self.oauth, "mcpOAuth": {"keep": "其他登录信息 🔒"},
                  "displayName": "测试账号"}
        plain = json.dumps(native, ensure_ascii=False)
        for value in (plain, plain.encode().hex()):
            self.keychain.put(SERVICE, self.adapter.account, value)
            self.assertEqual(self.adapter._read_keychain(), native)
            original = self.adapter.snapshot()
            self.assertEqual(original['keychain'], {AUTH_FIELD: self.oauth})
            self.adapter.restore({})
            self.assertEqual(json.loads(self.keychain.get(SERVICE, self.adapter.account)),
                             {key: item for key, item in native.items() if key != AUTH_FIELD})
            self.adapter.restore(original)
            self.assertEqual(json.loads(self.keychain.get(SERVICE, self.adapter.account)), native)

    def test_rollback_no_original_account_removes_new_auth_and_preserves_other_data(self):
        self.seed(oauth=False)
        original = self.adapter.snapshot()
        self.keychain.put(SERVICE, self.adapter.account, json.dumps({
            AUTH_FIELD: self.oauth, "mcpOAuth": {"keep": "newer"},
        }))
        self.write(self.adapter.config, {"oauthAccount": self.account, "theme": "newer"})
        self.write(self.adapter.credentials, {AUTH_FIELD: self.oauth, "newPreference": True})
        self.adapter.restore(original)
        self.assertEqual(json.loads(self.keychain.get(SERVICE, self.adapter.account)),
                         {"mcpOAuth": {"keep": "newer"}})
        self.assertEqual(json.loads(self.adapter.config.read_text()), {"theme": "newer"})
        self.assertEqual(json.loads(self.adapter.credentials.read_text()), {"newPreference": True})

    def test_empty_original_stores_are_deleted_after_rollback(self):
        original = self.adapter.snapshot()
        self.keychain.put(SERVICE, self.adapter.account, json.dumps({AUTH_FIELD: self.oauth}))
        self.write(self.adapter.config, {"oauthAccount": self.account})
        self.write(self.adapter.credentials, {AUTH_FIELD: self.oauth})
        self.adapter.restore(original)
        self.assertIsNone(self.keychain.get(SERVICE, self.adapter.account))
        self.assertFalse(self.adapter.config.exists())
        self.assertFalse(self.adapter.credentials.exists())

    def test_invalid_snapshot_rejected_before_any_write(self):
        self.seed()
        before = dict(self.keychain.values)
        with self.assertRaises(Error):
            self.adapter.restore({"config": {"theme": "bad"}})
        self.assertEqual(self.keychain.values, before)

    def test_malformed_native_store_does_not_get_overwritten(self):
        self.seed()
        for raw in ('not-json SECRET', '7b1', 'fffe', '{"token":"SECRET",'.encode().hex(),
                    '["SECRET"]', '["SECRET"]'.encode().hex()):
            self.keychain.put(SERVICE, self.adapter.account, raw)
            before = dict(self.keychain.values)
            with self.assertRaises(Error) as caught:
                self.adapter.restore({})
            self.assertNotIn('SECRET', str(caught.exception))
            self.assertNotIn('SECRET'.encode().hex(), str(caught.exception))
            self.assertEqual(self.keychain.values, before)

    def test_current_uses_only_cached_metadata(self):
        self.seed()
        with patch("claude_adapter.subprocess.run") as run:
            self.assertEqual(self.adapter.current(), {
                "email": "a@example.test", "team": "Team A", "verified": False,
                "identity": "account:account-a|org:org-a", "displayName": "",
            })
        self.assertEqual(self.keychain.gets, 0)
        run.assert_not_called()

    def test_validate_returns_snapshot_and_calls_only_official_status(self):
        self.seed()
        with patch("claude_adapter.subprocess.run", return_value=self.status()) as run:
            snapshot = self.adapter.validate()
        self.assertEqual(self.adapter.identity(snapshot)["key"], "account:account-a|org:org-a")
        self.assertEqual(run.call_args.args[0],
                         [str(self.binary), "auth", "status", "--json"])
        self.assertEqual(run.call_args.kwargs["cwd"], self.home)
        self.assertEqual(run.call_args.kwargs["env"]["HOME"], str(self.home))
        self.assertEqual(run.call_args.kwargs["env"]["NO_OPEN_BROWSER"], "1")
        self.assertEqual(run.call_args.kwargs["env"]["BROWSER"], "/usr/bin/true")
        self.assertEqual(run.call_args.kwargs["env"]["TERM"], "dumb")
        self.assertNotIn("accessToken", self.adapter.identity(snapshot))

    def test_validate_fallback_credentials_and_status_identity(self):
        self.write(self.adapter.credentials, {AUTH_FIELD: self.oauth})
        with patch("claude_adapter.subprocess.run", return_value=self.status()):
            snapshot = self.adapter.validate()
        self.assertEqual(self.adapter.identity(snapshot), {
            "email": "a@example.test", "team": "Team A", "key": "email:a@example.test|org:org-a",
        })

    def test_same_account_in_different_organizations_has_distinct_key(self):
        self.seed()
        original = self.adapter.snapshot()
        other = self.adapter.snapshot()
        other["config"]["oauthAccount"]["organizationUuid"] = "org-b"
        self.assertNotEqual(self.adapter.identity(original)["key"],
                            self.adapter.identity(other)["key"])
        with patch("claude_adapter.subprocess.run",
                   return_value=self.status(accountUuid="account-a", orgId=None)):
            self.assertEqual(self.adapter.identity(self.adapter.validate())["key"],
                             "account:account-a|org:org-a")

    def test_auth_changes_during_status_are_not_silently_saved(self):
        self.seed()

        def status_with_external_change(*args, **kwargs):
            self.keychain.put(SERVICE, self.adapter.account, json.dumps({
                AUTH_FIELD: {**self.oauth, "accessToken": "changed-secret"},
            }))
            return self.status()

        with patch("claude_adapter.subprocess.run", side_effect=status_with_external_change):
            with self.assertRaises(Error) as caught:
                self.adapter.validate()
        self.assertIn("检查期间发生变化", str(caught.exception))
        self.assertNotIn("changed-secret", str(caught.exception))

    def test_validate_rejects_mismatched_email_org_and_non_oauth(self):
        self.seed()
        for overrides in ({"email": "b@example.test"}, {"orgId": "org-b"},
                          {"authMethod": "api_key"}, {"loggedIn": False},
                          {"configDirectory": str(self.home / "other")}):
            with self.subTest(overrides=overrides):
                with patch("claude_adapter.subprocess.run",
                           return_value=self.status(**overrides)):
                    with self.assertRaises(Error):
                        self.adapter.validate()

    def test_validate_requires_real_local_oauth_field_and_identifiable_status(self):
        self.seed(oauth=False)
        with patch("claude_adapter.subprocess.run", return_value=self.status()):
            with self.assertRaises(Error):
                self.adapter.validate()
        self.seed()
        with patch("claude_adapter.subprocess.run", return_value=self.status(email=None)):
            with self.assertRaises(Error):
                self.adapter.validate()

    def test_status_errors_never_expose_stdout_stderr_or_exception(self):
        self.seed()
        failures = [
            subprocess.CompletedProcess([], 1, "secret-stdout", "secret-stderr"),
            subprocess.TimeoutExpired("secret-command", 30, output="secret-output"),
            OSError("secret-os-error"),
        ]
        for failure in failures:
            kwargs = {"side_effect": failure} if isinstance(failure, Exception) else {"return_value": failure}
            with patch("claude_adapter.subprocess.run", **kwargs):
                with self.assertRaises(Error) as caught:
                    self.adapter.validate()
            self.assertNotIn("secret", str(caught.exception))

    def test_override_settings_rejected_without_execution(self):
        for setting in (
            {"env": {"CLAUDE_CONFIG_DIR": "/other"}},
            {"env": {"ANTHROPIC_API_KEY": "secret"}},
            {"env": {"CLAUDE_CODE_OAUTH_REFRESH_TOKEN": "secret"}},
            {"env": {"CLAUDE_CODE_SIMPLE": "1"}},
            {"apiKeyHelper": "secret-helper"},
            {"forceLoginMethod": "console"},
            {"forceLoginMethod": "gateway"},
        ):
            with self.subTest(setting=setting):
                with self.assertRaises(Error) as caught:
                    self.adapter._check_settings(setting)
                self.assertNotIn("secret", str(caught.exception))

    def test_environment_checks_configuration_without_reading_keychain(self):
        settings = self.home / ".claude/settings.json"
        for config in ({"primaryApiKey": "secret"}, {"apiKeyHelper": "secret-helper"}):
            contents = {self.adapter.config: config} if "primaryApiKey" in config else {settings: config}
            with patch.object(self.adapter, "_read", side_effect=lambda path: contents.get(path, {})):
                with patch("claude_adapter.Path.glob", return_value=[]):
                    with patch("claude_adapter.Path.exists", return_value=False):
                        with self.assertRaises(Error) as caught:
                            ClaudeAdapter.check_environment(self.adapter)
            self.assertNotIn("secret", str(caught.exception))
        self.assertEqual(self.keychain.gets, 0)

    def test_explicit_missing_binary_does_not_silently_use_another_cli(self):
        self.adapter.env["DELIVERY_CLAUDE_BIN"] = str(self.home / "missing")
        with patch("claude_adapter.shutil.which", return_value=str(self.binary)) as which:
            with self.assertRaises(Error):
                self.adapter.command()
        which.assert_not_called()

    def test_official_native_install_is_used_before_legacy_delivery_install(self):
        native = self.home / ".local/bin/claude"
        legacy = self.home / ".local/share/delivery-ai-clis/node_modules/.bin/claude"
        for binary in (native, legacy):
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.write_text("#!/bin/sh\nexit 0\n")
            binary.chmod(0o700)
        self.adapter.env.pop("DELIVERY_CLAUDE_BIN")
        self.assertEqual(self.adapter.command(), [str(native)])
        native.unlink()
        self.assertEqual(self.adapter.command(), [str(legacy)])
        self.adapter.env["DELIVERY_CLAUDE_BIN"] = str(self.binary)
        self.assertEqual(self.adapter.command(), [str(self.binary)])

    def test_symlink_store_refused(self):
        external = self.home / "external.json"
        self.write(external, {"oauthAccount": self.account})
        self.adapter.config.symlink_to(external)
        with self.assertRaises(Error):
            self.adapter.restore({})
        self.assertEqual(json.loads(external.read_text()), {"oauthAccount": self.account})

    def test_login_and_active_process_interface(self):
        self.assertEqual(self.adapter.login_args(), ["auth", "login", "--claudeai"])
        with patch("claude_adapter.active_cli_pids", return_value=[123]) as active:
            self.assertEqual(self.adapter.active_pids(), [123])
        active.assert_called_once_with("claude")


if __name__ == "__main__":
    unittest.main()
