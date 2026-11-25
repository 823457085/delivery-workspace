"""Write credentials without exposing them in process arguments."""
import ctypes
from pathlib import Path
import subprocess


def put_password_with_security(service, account, value, keychain_path=None):
    """Keep security(1)'s reader and writer in the same macOS Keychain partition."""
    if keychain_path is not None and not Path(keychain_path).is_file():
        return -25294  # errSecNoSuchKeychain; security(1) can otherwise use the default.

    def quote(text):
        return '"' + text.replace('\\', '\\\\').replace('"', '\\"') + '"'

    fields = [service, account, value]
    command = 'add-generic-password -U -s %s -a %s -w %s' % tuple(map(quote, fields))
    if keychain_path is not None:
        command += ' ' + quote(str(keychain_path))
    line = (command + '\n').encode('utf-8')
    if len(line) >= 4096:  # security(1) has a fixed-size interactive input buffer.
        return None
    return subprocess.run(['/usr/bin/security', '-q', '-i'], input=line,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                          timeout=30).returncode


def put_password(service, account, value, keychain_path=None):
    """Return an OSStatus; optional keychain_path isolates OS integration tests."""
    if keychain_path is not None and not Path(keychain_path).is_file():
        return -25294  # errSecNoSuchKeychain; SecKeychainOpen alone accepts missing paths.
    security = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
    core = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    pointer, uint32 = ctypes.c_void_p, ctypes.c_uint32

    def bind(library, name, arguments, result=ctypes.c_int32):
        function = getattr(library, name)
        function.argtypes, function.restype = arguments, result
        return function

    release = bind(core, 'CFRelease', [pointer], None)
    open_keychain = bind(security, 'SecKeychainOpen', [ctypes.c_char_p, ctypes.POINTER(pointer)])
    default_keychain = bind(security, 'SecKeychainCopyDefault', [ctypes.POINTER(pointer)])
    keychain_status = bind(security, 'SecKeychainGetStatus', [pointer, ctypes.POINTER(uint32)])
    get_interaction = bind(security, 'SecKeychainGetUserInteractionAllowed', [ctypes.POINTER(ctypes.c_ubyte)])
    set_interaction = bind(security, 'SecKeychainSetUserInteractionAllowed', [ctypes.c_ubyte])
    find = bind(security, 'SecKeychainFindGenericPassword',
                [pointer, uint32, ctypes.c_char_p, uint32, ctypes.c_char_p,
                 ctypes.POINTER(uint32), ctypes.POINTER(pointer), ctypes.POINTER(pointer)])
    modify = bind(security, 'SecKeychainItemModifyAttributesAndData', [pointer, pointer, uint32, pointer])
    delete = bind(security, 'SecKeychainItemDelete', [pointer])
    service_bytes, account_bytes, password = service.encode('utf-8'), account.encode('utf-8'), value.encode('utf-8')
    keychain, item = pointer(), pointer()
    interaction = ctypes.c_ubyte()
    status = get_interaction(ctypes.byref(interaction))
    if status:
        return status
    status = set_interaction(False)
    if status:
        return status
    created, written = False, False

    def locate():
        return find(keychain, len(service_bytes), service_bytes, len(account_bytes), account_bytes,
                    None, None, ctypes.byref(item))

    try:
        if keychain_path is not None:
            status = open_keychain(str(keychain_path).encode('utf-8'), ctypes.byref(keychain))
            if status:
                return status
        status = locate()
        if status == -25300:  # errSecItemNotFound
            if not keychain:
                status = default_keychain(ctypes.byref(keychain))
                if status:
                    return status
            state = uint32()
            status = keychain_status(keychain, ctypes.byref(state))
            if status or not state.value & 1:  # kSecUnlockStateStatus
                return status or -25308  # errSecInteractionNotAllowed
            # security(1) must create the item to retain its ACL/partition policy.
            # The argument is an empty placeholder, never the credential. No -U:
            # a concurrent creation must fail rather than erase an existing item.
            result = subprocess.run(['/usr/bin/security', 'add-generic-password', '-s', service,
                                     '-a', account, '-w', '', *([str(keychain_path)] if keychain_path else [])],
                                    capture_output=True, timeout=30)
            if result.returncode:
                return result.returncode
            created = True
            status = locate()
        if status:
            return status
        status = modify(item, None, len(password), password)
        written = status == 0
        return status
    finally:
        try:
            if created and not written:
                if item:
                    delete(item)
                else:
                    subprocess.run(['/usr/bin/security', 'delete-generic-password', '-s', service,
                                    '-a', account, *([str(keychain_path)] if keychain_path else [])],
                                   capture_output=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            pass  # Preserve the original failed write; no account metadata has been committed.
        finally:
            try:
                if item:
                    release(item)
                if keychain:
                    release(keychain)
            finally:
                set_interaction(interaction)
