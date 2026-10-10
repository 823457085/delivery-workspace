/** 只持久化用户填写的资料与人工证据；读取时不写入，避免覆盖损坏数据或其他页签的新记录。 */
import { onScopeDispose, shallowRef } from 'vue';
import { STORAGE_KEY, parseRecords, serializeRecords, type DesignRecord } from './domain';

export function useDesignRecords() {
  const records = shallowRef<DesignRecord[]>([]);
  const storageError = shallowRef('');
  function reload() {
    try { records.value = parseRecords(localStorage.getItem(STORAGE_KEY)); storageError.value = ''; }
    catch { storageError.value = '本机资料读取失败，原数据已保留。请先备份浏览器存储；当前禁止覆盖保存。'; }
  }
  function save(record: DesignRecord) {
    try {
      const latest = parseRecords(localStorage.getItem(STORAGE_KEY));
      const next = [...latest.filter((item) => item.input.issueKey !== record.input.issueKey), record];
      localStorage.setItem(STORAGE_KEY, serializeRecords(next));
      records.value = next;
      storageError.value = '';
      return true;
    } catch { storageError.value = '保存失败（存储不可用、空间不足或原数据格式异常），请保留表单并备份资料。'; return false; }
  }
  function remove(key: string) {
    try {
      const next = parseRecords(localStorage.getItem(STORAGE_KEY)).filter((item) => item.input.issueKey !== key);
      localStorage.setItem(STORAGE_KEY, serializeRecords(next)); records.value = next;
      return true;
    } catch { storageError.value = '本机资料未能移除，原记录仍保留。'; return false; }
  }
  function sync(event: StorageEvent) { if (event.key === STORAGE_KEY || event.key === null) reload(); }
  reload();
  window.addEventListener('storage', sync);
  onScopeDispose(() => window.removeEventListener('storage', sync));
  return { records, storageError, save, remove };
}
