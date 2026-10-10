/** 笔记以带库标识的引用传递，避免切换知识库后把旧引用解析成另一份文件。 */
export interface AgentNote {
  reference: string;
  path: string;
  title: string;
  excerpt: string;
}
export interface AgentNoteContent extends AgentNote { content: string }
export interface AgentVaultConfig {
  path: string;
  id: string;
  candidates: string[];
}
