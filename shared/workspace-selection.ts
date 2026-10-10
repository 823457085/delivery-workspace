/** 本机选择器只返回目录身份，不传输文件内容，也不代表执行授权。 */
export type WorkspaceSelection = { cancelled: true } | { cancelled: false; workspacePath: string; branch: string; message: string };

/** 远端网页只浏览运行 Delivery 的电脑目录；不包含文件内容，也不代表执行授权。 */
export interface WorkspaceDirectoryListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; kind: 'directory' | 'file' }[];
  truncated: boolean;
}
