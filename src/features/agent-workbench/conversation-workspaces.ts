import type { ConversationWorkspace, ConversationWorkspaceState } from '../../../shared/conversation-workspaces';
import { agentConversationProjectPath, type AgentConversation } from './conversation';
export function legacyConversationWorkspace(conversation: AgentConversation): ConversationWorkspace | undefined {
  const path = agentConversationProjectPath(conversation);
  if (!path) return;
  return {id:`project:${path}`,name:path.replaceAll('\\','/').split('/').filter(Boolean).at(-1)||path,projectPaths:[path]};
}
export function conversationWorkspaceId(state: ConversationWorkspaceState, conversation: AgentConversation) {
  if (Object.hasOwn(state.assignments,conversation.id)) return state.assignments[conversation.id];
  return conversation.runs.find(run=>run.workspaceId)?.workspaceId || legacyConversationWorkspace(conversation)?.id || '';
}
export function conversationWorkspaceGroups(state: ConversationWorkspaceState, conversations: AgentConversation[]) {
  const groups = state.workspaces.map(workspace=>({...workspace,conversations:[] as AgentConversation[]}));
  const byId = new Map(groups.map(g=>[g.id,g]));
  const ungrouped = {id:'',name:'未分组',projectPaths:[] as string[],conversations:[] as AgentConversation[]};
  for (const conversation of conversations) {
    const id = conversationWorkspaceId(state,conversation);
    let group = byId.get(id);
    if (!group && id) {
      const legacy = legacyConversationWorkspace(conversation);
      if (legacy?.id===id) {group={...legacy,conversations:[]};groups.push(group);byId.set(id,group);}
    }
    (group||ungrouped).conversations.push(conversation);
  }
  return [...groups,ungrouped];
}
export function reorderConversationWorkspaces(ids: string[], source: string, target: string) {
  if(source===target||!ids.includes(source)||!ids.includes(target))return ids;
  const result=ids.filter(id=>id!==source); result.splice(ids.indexOf(target),0,source);return result;
}
