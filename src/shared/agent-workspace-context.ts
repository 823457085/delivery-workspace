import type { InjectionKey } from 'vue';
/** 页面提供会话草稿入口，业务面板不依赖 Agent 实现；独立页面不提供时不显示带入按钮。 */
export const agentWorkspaceContext: InjectionKey<{
  compose: (prompt: string) => void;
  openRun: (id: string) => void;
  readState: (key: string) => unknown;
  saveState: (key: string, value: unknown) => void;
}> = Symbol('agent-workspace-context');
