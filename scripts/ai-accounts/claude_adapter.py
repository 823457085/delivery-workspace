"""Claude Code's default macOS OAuth store. Secrets never leave snapshots."""

import copy
import contextlib
import getpass
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from common import Error, Keychain, active_cli_pids, keychain_json, login_resources, read_json, write_json


SERVICE = "Claude Code-credentials"
AUTH_FIELD = "claudeAiOauth"
OVERRIDE_ENV = {
    "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE",
    "CLAUDE_CODE_OAUTH_TOKEN_FD", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_SIMPLE",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
}
CONFIG_ERROR = "Claude 本机配置无法安全读取，请先检查官方 CLI 配置。"
STORE_ERROR = "Claude 本机凭据无法安全读写，请检查钥匙串访问权限。"
STATUS_ERROR = "Claude 官方 CLI 未确认本机 OAuth 登录状态，请重新登录。"
IDENTITY_ERROR = "Claude 登录身份与本机账号记录不一致，请重新登录。"


def _text(value):
    return value.strip() if isinstance(value, str) else ""


def _account_identity(account):
    email = _text(account.get("emailAddress") or account.get("email"))
    account_id = _text(account.get("accountUuid") or account.get("accountID")
                       or account.get("accountId"))
    org_id = _text(account.get("organizationUuid") or account.get("orgId"))
    team = _text(account.get("organizationName") or account.get("orgName")) or org_id
    key = f"account:{account_id}" if account_id else (
        f"email:{email.casefold()}" if email else ""
    )
    if key and org_id:
        key += f"|org:{org_id}"
    return {"email": email, "team": team, "key": key}


class ClaudeAdapter:
    provider = "claude"
    label = "Claude Code"

    def __init__(self, keychain=None, home=None, env=None, *, _isolated_config_dir=None):
        self.keychain = keychain if keychain is not None else Keychain()
        self.home = Path(home) if home is not None else Path.home()
        self.env = dict(os.environ if env is None else env)
        self.account = getpass.getuser()
        self.config_home = self.home / ".claude"
        self.config = self.home / ".claude.json"
        self.service = SERVICE
        self._isolated_config_dir = _isolated_config_dir
        if _isolated_config_dir is not None:
            self.config_home = Path(_isolated_config_dir)
            # The official CLI stores global metadata inside a custom config dir.
            self.config = self.config_home / ".claude.json"
            self.service += "-" + hashlib.sha256(str(self.config_home).encode()).hexdigest()[:8]
            self.login_cwd = self.config_home.parent
        self.credentials = self.config_home / ".credentials.json"

    def command(self):
        explicit = self.env.get("DELIVERY_CLAUDE_BIN")
        candidates = ([explicit] if explicit else [
            str(self.home / ".local/bin/claude"),
            str(self.home / ".local/share/delivery-ai-clis/node_modules/.bin/claude"),
            shutil.which("claude", path=self.env.get("PATH", "")),
        ])
        for item in candidates:
            if item and Path(item).is_file() and os.access(item, os.X_OK):
                return [str(Path(item).absolute())]
        raise Error("未找到 Claude Code 官方 CLI，请先安装或检查 CLI 路径。")

    def login_args(self):
        return ["auth", "login", "--claudeai"]

    @contextlib.contextmanager
    def isolated_login(self):
        self.check_environment()
        command = self.command()[0]
        with login_resources() as resources:
            directory = resources.enter_context(tempfile.TemporaryDirectory(prefix="delivery-claude-login-"))
            root = Path(directory)
            root.chmod(0o700)
            config_home = root / ".claude"
            config_home.mkdir(mode=0o700)
            # Preserve login/organization policies, but never copy native auth.
            for name in ("settings.json", "settings.local.json"):
                source = self.config_home / name
                if source.exists():
                    write_json(config_home / name, self._read(source))
            env = dict(self.env, CLAUDE_CONFIG_DIR=str(config_home), DELIVERY_CLAUDE_BIN=command)
            staged = ClaudeAdapter(keychain=self.keychain, home=self.home, env=env,
                                   _isolated_config_dir=config_home)
            def cleanup_keychain():
                try:
                    self.keychain.put(staged.service, staged.account, None)
                except (OSError, ValueError, TypeError, Error):
                    raise Error("Claude 临时登录凭据清理失败，请检查钥匙串访问权限。") from None
            resources.callback(cleanup_keychain)
            staged.check_environment()
            yield staged

    def child_env(self):
        env = dict(self.env)
        env["HOME"] = str(self.home)
        env.update({"NO_OPEN_BROWSER": "1", "BROWSER": "/usr/bin/true", "TERM": "dumb"})
        return env

    def active_pids(self):
        return active_cli_pids(self.provider)

    def _read(self, path):
        try:
            if path.is_symlink() or self.config_home.is_symlink():
                raise Error(CONFIG_ERROR)
            value = read_json(path, {})
            if not isinstance(value, dict):
                raise Error(CONFIG_ERROR)
            return value
        except (OSError, ValueError, TypeError, Error):
            raise Error(CONFIG_ERROR) from None

    def _read_keychain(self):
        try:
            raw = self.keychain.get(self.service, self.account)
            value = keychain_json(raw) if raw is not None else {}
            if not isinstance(value, dict):
                raise Error(STORE_ERROR)
            return value
        except (OSError, ValueError, TypeError, Error):
            raise Error(STORE_ERROR) from None

    def check_environment(self):
        self.command()
        env = dict(self.env)
        if self._isolated_config_dir is not None:
            if env.get("CLAUDE_CONFIG_DIR") != str(self.config_home):
                raise Error(CONFIG_ERROR)
            env.pop("CLAUDE_CONFIG_DIR")
        self._check_settings({"env": env})
        if self._read(self.config).get("primaryApiKey"):
            raise Error("Claude 存在 API Key 登录配置，暂不支持切换原生 OAuth 账号。")
        paths = [
            self.config_home / "settings.json",
            self.config_home / "settings.local.json",
            Path("/Library/Application Support/ClaudeCode/managed-settings.json"),
        ]
        managed = Path("/Library/Application Support/ClaudeCode/managed-settings.d")
        try:
            paths.extend(sorted(managed.glob("*.json")))
        except OSError:
            raise Error(CONFIG_ERROR) from None
        for path in paths:
            self._check_settings(self._read(path))
        # Device-managed policies need their own adapter, rather than guessing
        # the effective macOS preferences hierarchy.
        preferences = Path("/Library/Managed Preferences")
        if any(path.exists() for path in (
            preferences / "com.anthropic.claudecode.plist",
            preferences / self.account / "com.anthropic.claudecode.plist",
        )):
            raise Error("Claude 受系统托管登录策略控制，暂不支持本机账号切换。")

    def _check_settings(self, settings):
        env = settings.get("env", {})
        if not isinstance(env, dict):
            raise Error(CONFIG_ERROR)
        if any(env.get(key) not in (None, "", False, 0) for key in OVERRIDE_ENV):
            raise Error("Claude 存在覆盖原生账号的环境配置，请先移除后再切换。")
        if (settings.get("apiKeyHelper") or settings.get("forceLoginGatewayUrl")
                or settings.get("forceLoginMethod") not in (None, "", "claudeai")):
            raise Error("Claude 存在覆盖原生账号的登录配置，请先移除后再切换。")

    def snapshot(self):
        keychain = self._read_keychain()
        credentials = self._read(self.credentials)
        config = self._read(self.config)
        for value, field in ((keychain, AUTH_FIELD), (credentials, AUTH_FIELD),
                             (config, "oauthAccount")):
            if field in value and value[field] is not None and not isinstance(value[field], dict):
                raise Error(CONFIG_ERROR)
        return copy.deepcopy({
            "keychain": {AUTH_FIELD: keychain[AUTH_FIELD]} if AUTH_FIELD in keychain else {},
            "credentials": {AUTH_FIELD: credentials[AUTH_FIELD]} if AUTH_FIELD in credentials else {},
            "config": {"oauthAccount": config["oauthAccount"]} if "oauthAccount" in config else {},
        })

    def restore(self, snapshot):
        if not isinstance(snapshot, dict):
            raise Error("Claude 账号快照格式无效。")
        # Read/validate everything before the first mutation. The manager owns
        # the cross-store rollback transaction.
        stores = [
            ("keychain", AUTH_FIELD, self._read_keychain()),
            ("credentials", AUTH_FIELD, self._read(self.credentials)),
            ("config", "oauthAccount", self._read(self.config)),
        ]
        merged = {}
        for name, field, current in stores:
            saved = snapshot.get(name, {})
            if not isinstance(saved, dict) or set(saved) - {field}:
                raise Error("Claude 账号快照格式无效。")
            if field in saved and saved[field] is not None and not isinstance(saved[field], dict):
                raise Error("Claude 账号快照格式无效。")
            value = copy.deepcopy(current)
            value.pop(field, None)
            value.update(copy.deepcopy(saved))
            merged[name] = value
        try:
            self.keychain.put(self.service, self.account,
                              json.dumps(merged["keychain"], ensure_ascii=False)
                              if merged["keychain"] else None)
        except (OSError, ValueError, TypeError, Error):
            raise Error(STORE_ERROR) from None
        try:
            for name, path in (("credentials", self.credentials), ("config", self.config)):
                if merged[name]:
                    write_json(path, merged[name])
                elif path.exists():
                    path.unlink()
        except (OSError, ValueError, TypeError, Error):
            raise Error("Claude 本机账号配置恢复失败，请检查配置文件权限。") from None

    def identity(self, snapshot):
        config = snapshot.get("config", {}) if isinstance(snapshot, dict) else {}
        account = config.get("oauthAccount", {}) if isinstance(config, dict) else {}
        cached = _account_identity(account if isinstance(account, dict) else {})
        status = snapshot.get("statusIdentity", {}) if isinstance(snapshot, dict) else {}
        if cached["key"]:
            return cached
        if isinstance(status, dict):
            return {key: _text(status.get(key)) for key in ("email", "team", "key")}
        return cached

    def current(self):
        """Cached metadata only: no keychain prompt, CLI launch or token refresh."""
        account = self._read(self.config).get("oauthAccount")
        if not isinstance(account, dict):
            return None
        identity = _account_identity(account)
        if not identity["key"]:
            return None
        return {"email": identity["email"], "team": identity["team"], "verified": False,
                "identity": identity["key"], "displayName": _text(account.get("displayName"))}

    def validate(self):
        """Check local CLI identity; this deliberately does not claim network validity."""
        self.check_environment()
        before = self.snapshot()
        try:
            result = subprocess.run(
                self.command() + ["auth", "status", "--json"],
                env=self.child_env(), cwd=getattr(self, "login_cwd", self.home), capture_output=True,
                text=True, timeout=30, check=False,
            )
            status = json.loads(result.stdout)
        except (OSError, ValueError, subprocess.SubprocessError):
            raise Error(STATUS_ERROR) from None
        if (result.returncode or not isinstance(status, dict)
                or status.get("loggedIn") is not True
                or status.get("authMethod") != "claude.ai"
                or status.get("apiProvider") not in (None, "firstParty")):
            raise Error(STATUS_ERROR)
        config_directory = status.get("configDirectory")
        if config_directory and (
            not isinstance(config_directory, str)
            or Path(config_directory).resolve() != self.config_home.resolve()
        ):
            raise Error("Claude 官方 CLI 使用的配置目录与本机默认目录不一致。")
        snapshot = self.snapshot()
        if snapshot != before:
            raise Error("Claude 本机登录状态在检查期间发生变化，请停止相关进程后重试。")
        oauth = (snapshot["keychain"].get(AUTH_FIELD)
                 or snapshot["credentials"].get(AUTH_FIELD))
        if not isinstance(oauth, dict) or not _text(oauth.get("accessToken")):
            raise Error(STATUS_ERROR)
        cached = self.identity(snapshot)
        reported = _account_identity(status)
        if not reported["key"]:
            raise Error("Claude 官方 CLI 未返回可确认的账号身份，请重新登录。")
        if cached["key"]:
            comparable = False
            if cached["email"] and reported["email"]:
                comparable = True
                if cached["email"].casefold() != reported["email"].casefold():
                    raise Error(IDENTITY_ERROR)
            if cached["key"].startswith("account:") and reported["key"].startswith("account:"):
                comparable = True
                if cached["key"].split("|org:", 1)[0] != reported["key"].split("|org:", 1)[0]:
                    raise Error(IDENTITY_ERROR)
            if not comparable:
                raise Error(IDENTITY_ERROR)
        account = snapshot["config"].get("oauthAccount") or {}
        cached_org = _text(account.get("organizationUuid"))
        if cached_org and status.get("orgId") and cached_org != status["orgId"]:
            raise Error(IDENTITY_ERROR)
        snapshot["statusIdentity"] = reported
        return snapshot
