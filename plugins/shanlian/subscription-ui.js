export async function copyTextWithFallback(text, options = {}) {
  const writeClipboard = options.writeClipboard ?? globalThis.navigator?.clipboard?.writeText?.bind(globalThis.navigator.clipboard);
  if (writeClipboard) {
    try {
      await writeClipboard(text);
      return { copied: true, method: 'clipboard' };
    } catch {
      // fall through to textarea copy
    }
  }
  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.append(textarea);
    try {
      textarea.select();
      if (document.execCommand('copy')) {
        return { copied: true, method: 'execCommand' };
      }
    } catch {
      // ignore clipboard failures in restricted contexts
    } finally {
      textarea.remove();
    }
  }
  return { copied: false, method: 'none' };
}

export function subscriptionUrlFields(state) {
  const legacy = Boolean(state?.ready && state.fullUrl);
  const direct = Boolean(state?.directReady && state.directFullUrl);
  return {
    full: legacy ? state.fullUrl : '',
    provider: legacy ? state.providerUrl || '' : '',
    directFull: direct ? state.directFullUrl : '',
    directProvider: direct ? state.directProviderUrl || '' : '',
    visible: legacy || direct,
  };
}

export function writeRuleFields(form, rules = {}) {
  form.elements.lanDirect.checked = rules.lanDirect ?? true;
  form.elements.chinaDirect.checked = rules.chinaDirect ?? false;
  form.elements.ruleFallback.value = rules.fallback ?? '闪连节点';
  form.elements.customRules.value = rules.custom ?? '';
}

export function readRuleFields(form) {
  return {
    lanDirect: form.elements.lanDirect.checked,
    chinaDirect: form.elements.chinaDirect.checked,
    fallback: form.elements.ruleFallback.value,
    custom: form.elements.customRules.value,
  };
}
