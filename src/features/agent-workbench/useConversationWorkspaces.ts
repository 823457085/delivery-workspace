import { ref, computed, watch, onMounted } from 'vue';
import { ElMessage } from 'element-plus';
import type { AgentConversation } from './conversation';
import type { ConversationWorkspace, ConversationWorkspaceState } from '../../../shared/conversation-workspaces';
import { conversationWorkspaceGroups } from './conversation-workspaces';
export function useConversationWorkspaces(conversations: () => AgentConversation[]) {
  const state=ref<ConversationWorkspaceState>({revision:0,workspaces:[],assignments:{}}),ready=ref(false),busy=ref(false);
  const groups=computed(()=>conversationWorkspaceGroups(state.value,conversations()));
  let queue=Promise.resolve();
  async function read(){const r=await fetch('/api/conversation-workspaces');const data=await r.json();if(!r.ok)throw new Error(data.message);state.value=data;ready.value=true;}
  function mutate(input:Record<string,unknown>){
    const operation=queue.then(async()=>{
      busy.value=true;
      try {
        const r=await fetch('/api/conversation-workspaces',{method:'POST',headers:{'Content-Type':'application/json','X-Delivery-Confirmed':'yes'},body:JSON.stringify({...input,...(input.action==='seed'?{}:{revision:state.value.revision})})});
        const data=await r.json();if(!r.ok)throw new Error(data.message);state.value=data;return data as ConversationWorkspaceState;
      }catch(e){await read().catch(()=>{});throw e;}finally{busy.value=false;}
    });
    queue=operation.then(()=>{},()=>{});return operation;
  }
  const report=(e:unknown)=>ElMessage.error(e instanceof Error?e.message:'工作区操作失败');
  onMounted(()=>{void read().catch(report);});
  watch(()=>ready.value?JSON.stringify(groups.value.filter(g=>g.id&&!state.value.workspaces.some(w=>w.id===g.id)).map(({id,name,projectPaths})=>({id,name,projectPaths}))):'[]', raw=>{
    const workspaces=JSON.parse(raw);if(workspaces.length)void mutate({action:'seed',workspaces}).catch(report);
  });
  return {state,groups,ready,busy,read,
    async save(workspace:Omit<ConversationWorkspace,'id'>&{id?:string}){const result=await mutate({action:'save',workspace});return workspace.id?result.workspaces.find(w=>w.id===workspace.id)!:result.workspaces.at(-1)!;},
    async assign(conversationId:string,workspaceId:string){try{await mutate({action:'assign',conversationId,workspaceId});}catch(e){report(e);}},
    async reorder(ids:string[]){try{await mutate({action:'reorder',ids});}catch(e){report(e);}},
  };
}
