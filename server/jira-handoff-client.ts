/** 复用已配置 Jira 的认证，仅访问固定事项路径；不接收客户端 URL 或任意字段。 */
import type { JiraHandoffIssue, JiraHandoffTransition, JiraHandoffUser, JiraHandoffStatus } from '../shared/jira-fix-handoff.js';

export interface JiraHandoffSource {
  readIssue(key: string): Promise<JiraHandoffIssue>;
  transitions(key: string): Promise<JiraHandoffTransition[]>;
  statuses(key: string): Promise<JiraHandoffStatus[]>;
  comment(key: string, body: string): Promise<string>;
  transition(key: string, id: string, fields?: Record<string, string>): Promise<void>;
  assign(key: string, user: JiraHandoffUser): Promise<void>;
  readComment(key: string, id: string): Promise<string>;
}
interface RawUser { name?: string; accountId?: string; displayName?: string; active?: boolean }
function user(value?: RawUser | null): JiraHandoffUser | null {
  if (!value || !(value.name || value.accountId)) return null;
  return { id: value.name || value.accountId!, name: value.displayName || value.name || value.accountId!,
    kind: value.name ? 'name' : 'accountId', active: value.active !== false };
}
export function createJiraHandoffClient(request: (key: string, suffix: string, method?: string, body?: unknown) => Promise<unknown>): JiraHandoffSource {
  return {
    async statuses(key) {
      const raw = await request(key, '/workflow-statuses') as JiraHandoffStatus[];
      if (!Array.isArray(raw) || !raw.length || raw.some(item => !item.id || !item.name)) throw new Error('Jira 未返回完整状态');
      return raw.map(({ id, name }) => ({ id, name }));
    },
    async readIssue(key) {
      const raw = await request(key, '?fields=summary,status,reporter,assignee') as { key: string; fields: {
        summary: string; status: { id: string; name: string }; reporter?: RawUser; assignee?: RawUser } };
      if (raw.key !== key || !raw.fields?.status?.id) throw new Error('Jira 事项返回不完整');
      return { key: raw.key, summary: raw.fields.summary, status: raw.fields.status,
        reporter: user(raw.fields.reporter), assignee: user(raw.fields.assignee) };
    },
    async transitions(key) {
      const raw = await request(key, '/transitions?expand=transitions.fields') as { transitions: (JiraHandoffTransition & {
        fields?: Record<string, { name?: string; required?: boolean; schema?: { type?: string }; operations?: string[] }>;
      })[] };
      if (!Array.isArray(raw.transitions)) throw new Error('Jira 未返回工作流状态');
      return raw.transitions.filter(item => item.id && item.to?.id).map(({ id, name, to, fields }) => {
        const dateFields = Object.entries(fields || {}).filter(([, field]) => field.schema?.type === 'date' && field.operations?.includes('set'))
          .map(([id, field]) => ({ id, name: field.name || id, required: field.required === true }));
        return { id, name, to: { id: to.id, name: to.name }, ...(dateFields.length ? { dateFields } : {}) };
      });
    },
    async comment(key, body) {
      const raw = await request(key, '/comment', 'POST', { body }) as { id?: string };
      if (!raw.id) throw new Error('Jira 未返回评论编号，请在 Jira 核对是否写入');
      return raw.id;
    },
    async transition(key, id, fields) {
      await request(key, '/transitions', 'POST', { transition: { id }, ...(fields && Object.keys(fields).length ? { fields } : {}) });
    },
    async assign(key, value) { await request(key, '/assignee', 'PUT', { [value.kind]: value.id }); },
    async readComment(key, id) {
      const raw = await request(key, `/comment/${encodeURIComponent(id)}`) as { body: string };
      return raw.body;
    },
  };
}
