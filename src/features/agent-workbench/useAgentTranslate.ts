/**
 * 会话翻译为全局阅读开关：开启后标题、消息与右栏记录统一显示译文，原文不变、不写回会话。
 * 译文按“目标语言 + 原文”缓存在内存，成功结果同时写入浏览器本地存储，刷新后直接复用、不重复调用模型；
 * 同一时刻出现的多段文字合并为一次请求，避免逐条调用模型。
 * 流式输出中的文字需稳定一段时间后才翻译，避免每个增量都触发一次翻译。
 */
import { computed, onScopeDispose, reactive, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { agentTranslateLanguages, maxAgentTranslateBatchLength, maxAgentTranslateBatchSize, maxAgentTranslateLength, needsAgentTranslation,
  type AgentTranslateLanguage, type AgentTranslateResult } from '../../../shared/agent-translate';

const storageKey = 'delivery-agent-translate';
type TranslateSettings = { enabled: boolean; target: AgentTranslateLanguage };

function loadSettings(): TranslateSettings {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return { enabled: value.enabled !== false, target: agentTranslateLanguages.includes(value.target) ? value.target : 'zh' };
  } catch { return { enabled: true, target: 'zh' }; }
}

export const agentTranslateSettings = reactive<TranslateSettings>(loadSettings());
watch(agentTranslateSettings, (value) => {
  try { localStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* 存储被禁止时仅本次页面生效 */ }
});

type Entry = { status: 'pending' | 'done' | 'failed'; text?: string; error?: string };
const entries = reactive(new Map<string, Entry>());
const queue = new Map<string, { text: string; target: AgentTranslateLanguage }>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let inFlight = 0;
const maxInFlight = 2;

const entryKey = (text: string, target: AgentTranslateLanguage) => `${target}\n${text}`;

/**
 * 持久缓存：以原文长度 + 两个 32 位哈希作键，只存译文，避免把原文再存一份；
 * 按最近使用淘汰，条数和总字数都设上限，防止占满本地存储。存储被禁止或已满时只保留内存缓存。
 */
const cacheStorageKey = 'delivery-agent-translate-cache.v1';
const maxCachedEntries = 400, maxCachedChars = 1_200_000;
type CachedTranslation = { text: string; usedAt: number };
function hash(text: string, seed: number) {
  let value = seed >>> 0;
  for (let index = 0; index < text.length; index++) value = Math.imul(value ^ text.charCodeAt(index), 16777619) >>> 0;
  return value.toString(36);
}
const cacheKey = (key: string) => `${key.length}:${hash(key, 2166136261)}:${hash(key, 3735928559)}`;
const persisted: Record<string, CachedTranslation> = (() => {
  try {
    const value = JSON.parse(localStorage.getItem(cacheStorageKey) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
})();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const items = Object.entries(persisted).sort((a, b) => b[1].usedAt - a[1].usedAt);
    let chars = 0;
    for (const [index, [key, item]] of items.entries()) {
      chars += item.text.length;
      if (index >= maxCachedEntries || chars > maxCachedChars) delete persisted[key];
    }
    try { localStorage.setItem(cacheStorageKey, JSON.stringify(persisted)); } catch { /* 存储已满或被禁止时仅保留内存缓存 */ }
  }, 500);
}
function cachedEntry(key: string): Entry | undefined {
  const cached = persisted[cacheKey(key)];
  if (typeof cached?.text !== 'string') return undefined;
  cached.usedAt = Date.now(); saveCache();
  const entry: Entry = { status: 'done', text: cached.text };
  entries.set(key, entry);
  return entry;
}
function remember(key: string, text: string) {
  entries.set(key, { status: 'done', text });
  persisted[cacheKey(key)] = { text, usedAt: Date.now() };
  saveCache();
}
const lookup = (key: string) => entries.get(key) || cachedEntry(key);

async function postTranslation(texts: string[], target: AgentTranslateLanguage) {
  const response = await fetch('/api/agent-runtimes/translate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' }, body: JSON.stringify({ texts, target }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || '翻译失败');
  return (data as AgentTranslateResult).translations;
}

function scheduleFlush(delay = 120) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = undefined; flush(); }, delay);
}

/** 按目标语言分组并按长度切批；并发受限，剩余内容在请求完成后继续发送。 */
function flush() {
  while (queue.size && inFlight < maxInFlight) {
    const [first] = queue.values();
    const batch: string[] = [];
    let length = 0;
    for (const [key, item] of queue) {
      if (item.target !== first.target) continue;
      if (batch.length && (batch.length >= maxAgentTranslateBatchSize || length + item.text.length > maxAgentTranslateBatchLength)) break;
      batch.push(item.text); length += item.text.length; queue.delete(key);
    }
    inFlight++;
    postTranslation(batch, first.target)
      .then(translations => batch.forEach((text, index) => remember(entryKey(text, first.target), translations[index])))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        batch.forEach(text => entries.set(entryKey(text, first.target), { status: 'failed', error: message }));
      })
      .finally(() => { inFlight--; if (queue.size) scheduleFlush(0); });
  }
}

function request(text: string, target: AgentTranslateLanguage) {
  const key = entryKey(text, target);
  const current = lookup(key);
  if (current && current.status !== 'failed') return;
  entries.set(key, { status: 'pending' });
  queue.set(key, { text, target });
  scheduleFlush();
}

export function retryAgentTranslation(text: string) {
  const key = entryKey(text.trim(), agentTranslateSettings.target);
  if (entries.get(key)?.status === 'failed') entries.delete(key);
  request(text.trim(), agentTranslateSettings.target);
}

/** 返回当前开关下该段文字的译文状态；stable 为 false 时（如正在流式输出）延后翻译。 */
export function useAgentTranslation(source: MaybeRefOrGetter<string | undefined>, stable: MaybeRefOrGetter<boolean> = true) {
  const text = computed(() => (toValue(source) || '').trim().slice(0, maxAgentTranslateLength));
  const active = computed(() => agentTranslateSettings.enabled && !!text.value && needsAgentTranslation(text.value, agentTranslateSettings.target));
  const settled = shallowRef(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch([text, active, () => toValue(stable)], ([value, enabled, isStable]) => {
    clearTimeout(timer);
    settled.value = false;
    if (!enabled) return;
    if (lookup(entryKey(value, agentTranslateSettings.target))) { settled.value = true; request(value, agentTranslateSettings.target); return; }
    timer = setTimeout(() => { settled.value = true; request(value, agentTranslateSettings.target); }, isStable ? 0 : 2500);
  }, { immediate: true });
  onScopeDispose(() => clearTimeout(timer));
  const entry = computed(() => active.value ? entries.get(entryKey(text.value, agentTranslateSettings.target)) : undefined);
  return computed(() => !active.value ? { visible: false as const }
    : { visible: true as const, waiting: !settled.value, status: entry.value?.status || 'pending', text: entry.value?.text || '', error: entry.value?.error || '', source: text.value });
}
