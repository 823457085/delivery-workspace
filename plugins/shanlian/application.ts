import { z } from 'zod';
import type { PluginApplicationHost } from '../../shared/plugin-application-host.js';
import { controlledService, jsonTransport, serviceEndpoint, type Operation } from '../_shared/service-client.js';
const empty = z.object({}).strict();
const node = z.object({ id: z.string().min(1).max(1000) }).strict();
export const operations: Record<string, Operation> = {
 'status': {label:'读取连接状态',method:'GET',path:'/api/status',schema:empty},
 'nodes': {label:'读取节点',method:'GET',path:'/api/nodes',schema:empty},
 'config': {label:'读取配置',method:'GET',path:'/api/config',schema:empty},
 'network': {label:'读取代理接口',method:'GET',path:'/api/network',schema:empty},
 'network.save': {label:'修改代理监听及允许网段，会影响现有连接',method:'PUT',path:'/api/network',schema:z.object({address:z.string().min(1).max(100),httpPort:z.number().int().min(1024).max(65535),socksPort:z.number().int().min(1024).max(65535),allowedSubnet:z.string().min(1).max(1000)}).strict()},
 'account.login': {label:'使用填写的闪连账号登录服务商',method:'POST',path:'/api/account/login',schema:z.object({username:z.string().min(1).max(500),password:z.string().min(1).max(4000),proxy:z.string().max(2000).default('')}).strict()},
 'account.schedule': {label:'读取自动刷新计划',method:'GET',path:'/api/account/refresh/schedule',schema:empty},
 'account.schedule-save': {label:'修改账号自动刷新计划',method:'PUT',path:'/api/account/refresh/schedule',schema:z.object({enabled:z.boolean(),intervalMinutes:z.number().int().min(5).max(10080)}).strict()},
 'account.refresh': {label:'刷新闪连账号及节点',method:'POST',path:'/api/account/refresh',schema:empty},
 'nodes.select': {label:'切换代理节点，影响后续连接',method:'POST',path:'/api/nodes/select',schema:node},
 'nodes.delay': {label:'检测节点延迟',method:'POST',path:'/api/nodes/delay',schema:node,readOnly:true},
 'connection.check': {label:'检测代理网络',method:'POST',path:'/api/connection/check',schema:empty,readOnly:true},
 'connection': {label:'改变代理连接状态',method:'POST',path:'/api/connection',schema:z.object({action:z.enum(['connect','disconnect','reconnect'])}).strict()},
 'subscription': {label:'读取 Clash 订阅',method:'GET',path:'/api/clash/subscription',schema:empty},
 'subscription.save': {label:'保存 Clash 订阅，启用后持有链接者可下载代理配置',method:'PUT',path:'/api/clash/subscription',schema:z.object({enabled:z.boolean(),server:z.string().max(500),port:z.number().int().min(1).max(65535),tls:z.boolean(),rules:z.object({lanDirect:z.boolean(),chinaDirect:z.boolean(),fallback:z.string().max(200),custom:z.string().max(200000)}).strict().optional(),script:z.string().max(256000).optional()}).strict()},
 'subscription.rotate': {label:'重置订阅链接，旧链接立即失效',method:'POST',path:'/api/clash/subscription/rotate',schema:empty},
 'subscription.delete': {label:'关闭订阅下载，已下载的配置不会撤销',method:'DELETE',path:'/api/clash/subscription',schema:empty},
};
export function createPlugin(host: PluginApplicationHost) {
 const configuration = host.configuration;
 let cookie = '', csrf = '';
 let transport: ReturnType<typeof jsonTransport> | undefined;
 const endpoint = configuration.endpoint ? serviceEndpoint(configuration.endpoint) : '';
 const configured = !!(endpoint && configuration.username && configuration.password);
 function client() { if (!configured) throw new Error('请在插件配置中填写 Shanlian 地址、管理账号和密码'); return transport ||= jsonTransport(endpoint,[configuration.password]); }
 async function login() {
   if (cookie) return;
   const result = await client().request('/api/session/login','POST',{username:configuration.username,password:configuration.password});
   const saved = result.cookies.find(value => /^shanlian_session=[a-f0-9]+;/.test(value))?.split(';')[0];
   if (!saved || result.data?.authenticated !== true || typeof result.data.csrf !== 'string') throw new Error('登录响应无效，请核对 Shanlian 版本');
   cookie = saved; csrf = result.data.csrf;
 }
 const controlled = controlledService(operations, async (op,input) => {
   await login();
   try { return (await client().request(typeof op.path === 'string' ? op.path : op.path(input),op.method,op.method === 'GET' ? undefined : input, {Cookie:cookie,'X-CSRF-Token':csrf})).data; }
   catch(error: any) { if (error.status === 401) {cookie='';csrf='';} throw error; }
 }, endpoint);
 return {
   async request(method: string,input: unknown) {
     if (method === 'status') return {configured,endpoint};
     if (method === 'session') { if (!configured) return {authenticated:false,endpoint}; await login(); return {authenticated:true,endpoint}; }
     if (method === 'disconnect') { cookie='';csrf='';return {ok:true}; }
     return controlled.request(method,input);
   },
   close() { cookie='';csrf='';transport?.close();controlled.close(); },
 };
}
