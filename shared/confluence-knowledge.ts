/** Confluence 文档按需读取；引用绑定站点和页面，不保存账号或远端正文副本。 */
export interface ConfluenceScope {
  spaceKey: string;
  requirementParentId: string;
  designParentId: string;
}
export interface ConfluencePage {
  id: string;
  reference: string;
  title: string;
  url: string;
  spaceKey: string;
  version: number;
  updatedAt: string;
  excerpt: string;
}
export interface ConfluencePageContent extends ConfluencePage {
  content: string;
  truncated: boolean;
}
export interface ConfluenceConfig {
  site: string;
  scope: ConfluenceScope;
}

export function confluenceReference(site: string, pageId: string) {
  return `confluence:${encodeURIComponent(site)}/${pageId}`;
}
