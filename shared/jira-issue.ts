export interface JiraChoice { id?: string; name?: string; value?: string; key?: string; displayName?: string; accountId?: string }
export interface JiraField { id: string; name: string; required?: boolean; schema?: { type?: string; items?: string }; allowedValues?: JiraChoice[]; defaultValue?: unknown }
export interface JiraPerson { id: string; kind: 'name' | 'accountId'; label: string }
export interface JiraComment { id: string; author: string; body: string; html: string; created: string }
export interface JiraIssueDetail {
  key: string; url: string; summary: string; description: string; descriptionHtml: string; updated: string; created: string;
  status: string; statusCategory: string; type: string; priority: string; project: { id: string; key: string; name: string };
  assignee: string; assigneeUser: JiraPerson | null; reporter: string; fixVersions: string[]; components: string[]; labels: string[];
  startDate: string; endDate: string; dueDate: string;
  parent: { key: string; summary: string } | null; subtasks: { key: string; summary: string; status: string }[];
  links: { id: string; key: string; summary: string; relationship: string; status: string }[];
  attachments: { id: string; filename: string; size: number; mimeType: string; created: string; author: string }[];
  comments: JiraComment[]; commentTotal: number; commentNext: number;
  changes: { id: string; author: string; created: string; items: { field: string; from: string; to: string }[] }[]; changeTotal: number;
  permissions: Record<string, boolean>; warnings: string[]; watching: boolean | null;
  editFields: JiraField[]; fieldValues: Record<string, unknown>;
  transitions: { id: string; name: string; to: string; fields: JiraField[] }[];
}
