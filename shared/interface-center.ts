/** 接口目录与契约元数据；目录导入不代表接口已经联调。 */
export interface ApiGroup { name: string; count: number }
export interface ApiSource {
  kind: 'file' | 'repository' | 'manual' | 'apifox'; label: string;
  repositoryPath?: string; ref?: string; commit?: string; file?: string;
  apifoxTeamId?: string; apifoxProjectId?: string;
}
export interface ApiProject {
  id: string; name: string; description: string; version: string; openapi: string;
  operationCount: number; groups: ApiGroup[]; source: ApiSource; updatedAt: string;
}
export interface ApiOperation {
  key: string; method: string; path: string; summary: string; description: string;
  tags: string[]; deprecated: boolean;
}
export interface ApiOperationDetail extends ApiOperation {
  parameters: unknown[]; requestBody: unknown; responses: Record<string, unknown>;
  security: unknown; servers: unknown[]; raw: unknown;
}
export interface ApiCatalog { projects: ApiProject[] }
export interface ApiProjectDetail { project: ApiProject; operations: ApiOperation[] }
export interface ApiImportPreview {
  title: string; operationCount: number; groups: ApiGroup[];
  added: number; updated: number; removed: number; expectedUpdatedAt: string;
}
export interface ApiProjectImportPreview {
  id: string; title: string; source: string; targetName: string; create: boolean;
  added: number; skipped: number; operationCount: number;
  sync?: { updated: number; removed: number; omittedRequestBodies?: number };
}
export interface ApiRepositoryPreview {
  repositoryPath: string; ref: string; commit: string;
  projects: { file: string; name: string; operationCount: number; groups: ApiGroup[] }[];
}
