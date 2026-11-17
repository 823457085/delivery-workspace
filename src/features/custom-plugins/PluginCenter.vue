<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useCustomPlugins } from './api';
import { integrationCatalog } from '../../../shared/integration-plugins';
import { createThemePublisher } from './theme-context';
import WorkspaceMenuSettings from './WorkspaceMenuSettings.vue';
const emit=defineEmits<{changed:[]}>();
const route=useRoute(), router=useRouter(), plugins=useCustomPlugins(), frame=ref<HTMLIFrameElement>();
const token=crypto.randomUUID();
const menuEditor=ref<InstanceType<typeof WorkspaceMenuSettings>>();
let themes:ReturnType<typeof createThemePublisher>|undefined;
function send(){
  const css=getComputedStyle(document.documentElement);
  const names:Record<string,string>={raised:'--ui-raised',divider:'--ui-divider',secondary:'--ui-secondary',success:'--ui-success','success-bg':'--ui-success-bg',warning:'--ui-warning','warning-bg':'--ui-warning-bg',danger:'--ui-danger','danger-bg':'--ui-danger-bg',radius:'--ds-radius','font-family':'--sans','font-mono':'--ui-font-mono'};
  const appearance=Object.fromEntries(Object.entries(names).map(([key,name])=>[key,css.getPropertyValue(name).trim()]).filter(([,value])=>value));
  frame.value?.contentWindow?.postMessage({type:'plugin-center-theme',token,theme:themes?.get(),appearance},location.origin);
}
async function receive(event:MessageEvent){
  if(event.origin!==location.origin||event.source!==frame.value?.contentWindow||event.data?.token!==token||event.data.type!=='plugin-center')return;
  if(event.data.method==='ready')send();
  if(event.data.method==='connection.edit'){
    const provider = integrationCatalog.find(item=>item.connection?.type==='catalog');
    if(provider)await router.push({path:'/agent',query:{view:'settings',settingsTab:'integrations',configurePlugin:provider.id}});
  }
  if(event.data.method==='changed'){await plugins.query.refetch();emit('changed');}
  if(event.data.method==='menu.edit'){
    const result=await plugins.query.refetch();
    if(!result.error)menuEditor.value?.open();
  }
  if(event.data.method==='open'){
    await plugins.query.refetch();
    const id=event.data.input?.id;
    if(plugins.plugins.value.some(p=>p.manifest.id===id&&p.enabled))await router.push({path:'/agent',query:{view:'plugins',plugin:id}});
  }
}
watch(() => route.query.settingsTab, tab => { if(tab==='plugins') frame.value?.contentWindow?.postMessage({type:'plugin-center-catalog-changed',token},location.origin); });
function menuSaved(){frame.value?.contentWindow?.postMessage({type:'plugin-center-menu-changed',token},location.origin);emit('changed');}
onMounted(()=>{themes=createThemePublisher(token,send);window.addEventListener('message',receive);});
onBeforeUnmount(()=>{themes?.close();window.removeEventListener('message',receive);});
</script>
<template><iframe ref="frame" :src="`/plugin-center/index.html#token=${token}`" title="插件中心" class="plugin-center" /><WorkspaceMenuSettings ref="menuEditor" hide-trigger @saved="menuSaved" /></template>
<style scoped>.plugin-center{width:100%;height:calc(100dvh - 170px);min-height:520px;border:0;border-radius:12px;display:block}</style>
