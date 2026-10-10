/** 所有原系统写操作共用确认、单次提交和冲突刷新策略；与 UI 解耦便于隔离验证，不自动重试业务写入。 */
interface ActionEffects {
  confirm: (title: string, impact: string) => Promise<boolean>;
  send: (key: string, body: string) => Promise<Response>;
  refresh: () => Promise<unknown>;
  success: (message: string) => void;
  error: (message: string) => void;
  pending: (value: boolean) => void;
}
export function createSourceActionExecutor(effects: ActionEffects) {
  let busy = false;
  async function refresh() {
    try { await effects.refresh(); }
    catch { effects.error('状态刷新失败，请手动刷新核对；不要重复提交刚才的操作'); }
  }
  return async function execute(key: string, data: unknown, title: string, impact: string) {
    if (busy) return false;
    busy = true; effects.pending(true);
    let sent = false;
    try {
      const body = JSON.stringify(data);
      if (!await effects.confirm(title, impact)) return false;
      sent = true;
      const response = await effects.send(key, body);
      const result = await response.json();
      if (!response.ok || result.error) {
        effects.error(result.details || result.message || result.error || `执行失败 (${response.status})`);
        if (response.status === 409) await refresh();
        return false;
      }
      effects.success(result.message || '操作已受理，请在当前面板查看最新状态');
      await refresh();
      return true;
    } catch (error) {
      effects.error(`${error instanceof Error ? error.message : String(error)}${sent ? '；执行结果未确认，请先刷新核对状态，勿直接重试' : ''}`);
      return false;
    } finally { busy = false; effects.pending(false); }
  };
}
