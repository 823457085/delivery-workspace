import { z } from 'zod';
import type { PluginApplicationHost } from '../../shared/plugin-application-host.js';
import { controlledService, jsonTransport, serviceEndpoint, type Operation } from '../_shared/service-client.js';
const empty = z.object({}).strict(), id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/), key = z.object({id}).strict();
const object = z.record(z.string(),z.unknown());
const document = z.object({id, document:object}).strict();
const route = (prefix: string, suffix = '') => (input: any) => `/api/${prefix}/${encodeURIComponent(input.id)}${suffix}`;
const credentials = z.object({username:z.string().max(500),password:z.string().max(4096).optional(),login_mode:z.enum(['password','cookie']),cookies:z.string().max(100_000).optional()}).strict();
export const operations: Record<string,Operation> = {
 'accounts':{label:'读取账号',method:'GET',path:'/api/accounts',schema:empty},
 'account':{label:'读取账号详情',method:'GET',path:route('accounts'),schema:key},
 'account.create':{label:'新增签到账号',method:'POST',path:'/api/accounts',schema:object},
 'account.update':{label:'修改账号计划及启停状态',method:'PATCH',path:route('accounts'),schema:document,body:v=>v.document},
 'account.delete':{label:'删除账号及关联记录，无法撤销',method:'DELETE',path:route('accounts'),schema:key},
 'account.credentials':{label:'更新账号登录凭据',method:'PUT',path:route('accounts','/credentials'),schema:z.object({id,document:credentials}).strict(),body:v=>v.document},
 'account.cookies':{label:'读取账号 Cookie（敏感内容）',method:'GET',path:route('accounts','/cookies'),schema:key},
 'account.cookies-save':{label:'导入账号 Cookie',method:'PUT',path:route('accounts','/cookies'),schema:z.object({id,cookies:z.string().min(1).max(100_000)}).strict(),body:v=>({cookies:v.cookies})},
 'account.login':{label:'执行账号登录',method:'POST',path:route('accounts','/login'),schema:key,body:()=>({})},
 'account.verify':{label:'验证账号登录状态',method:'POST',path:route('accounts','/verify'),schema:key,body:()=>({})},
 'account.checkin':{label:'执行账号签到',method:'POST',path:route('accounts','/checkin'),schema:key,body:()=>({})},
 'account.captcha':{label:'读取验证码',method:'GET',path:route('accounts','/captcha'),schema:key},
 'account.captcha-get':{label:'获取新的验证码',method:'POST',path:route('accounts','/captcha'),schema:key,body:()=>({})},
 'account.captcha-submit':{label:'提交验证码',method:'POST',path:route('accounts','/captcha/submit'),schema:document,body:v=>v.document},
 'accounts.import':{label:'批量导入账号',method:'POST',path:'/api/accounts/import',schema:z.array(object).min(1).max(200)},
 'accounts.checkin':{label:'批量执行选定账号签到',method:'POST',path:'/api/accounts/checkin',schema:z.object({ids:z.array(id).min(1).max(200)}).strict()},
 'sites':{label:'读取站点',method:'GET',path:'/api/sites',schema:empty},
 'site':{label:'读取站点配置',method:'GET',path:route('sites'),schema:key},
 'site.create':{label:'新增站点',method:'POST',path:'/api/sites',schema:object},
 'site.update':{label:'更新站点',method:'PUT',path:route('sites'),schema:document,body:v=>v.document},
 'site.delete':{label:'删除站点，无法撤销',method:'DELETE',path:route('sites'),schema:key},
 'plugins':{label:'读取站点适配器',method:'GET',path:'/api/plugins',schema:empty},
 'plugin.template':{label:'读取站点模板',method:'GET',path:route('plugins','/template'),schema:key},
 'plugins.reload':{label:'重新加载 Sign Hub 站点适配器',method:'POST',path:'/api/plugins/reload',schema:empty},
 'runs':{label:'读取执行记录',method:'GET',path:v=>'/api/runs?'+new URLSearchParams({limit:String(v.limit),...(v.account_id?{account_id:v.account_id}:{})}),schema:z.object({limit:z.number().int().min(1).max(500).default(100),account_id:id.optional()}).strict()},
 'notifications':{label:'读取通知记录',method:'GET',path:'/api/notifications',schema:empty},
 'system':{label:'读取系统信息',method:'GET',path:'/api/system/info',schema:empty},
 'server':{label:'读取服务设置',method:'GET',path:'/api/settings/server',schema:empty},
 'server.save':{label:'修改服务监听设置，按服务端提示重启后生效',method:'PUT',path:'/api/settings/server',schema:z.object({host:z.string().min(1).max(500),port:z.number().int().min(1).max(65535)}).strict()},
 'backups':{label:'读取备份记录',method:'GET',path:'/api/backups',schema:empty},
 'backup.config':{label:'读取备份配置',method:'GET',path:'/api/backups/config',schema:empty},
 'backup.save':{label:'修改 WebDAV 备份配置',method:'PUT',path:'/api/backups/config',schema:object},
 'backup.remote':{label:'读取远端备份',method:'GET',path:'/api/backups/remote',schema:empty},
 'backup.create':{label:'创建并上传备份',method:'POST',path:'/api/backups',schema:empty},
 'backup.test':{label:'测试 WebDAV（会上传、回读并删除测试文件）',method:'POST',path:'/api/backups/test',schema:empty},
 'backup.restore':{label:'恢复备份，将修改当前服务数据，请核对备份文件',method:'POST',path:'/api/backups/restore',schema:object},
};
export function createPlugin(host: PluginApplicationHost) {
 const {endpoint:address,token} = host.configuration;
 const endpoint = address ? serviceEndpoint(address) : '';
 const configured = !!(endpoint && token);
 let client: ReturnType<typeof jsonTransport> | undefined;
 const controlled = controlledService(operations,async (op,input) => {
   if (!configured) throw new Error('请在插件配置中填写 Sign Hub 地址和管理员令牌');
   client ||= jsonTransport(endpoint,[token]);
   const result = await client.request(typeof op.path==='string'?op.path:op.path(input),op.method,op.method==='GET'?undefined:op.body?op.body(input):input,{Authorization:`Bearer ${token}`});
   return result.data;
 },endpoint);
 return {request(method:string,input:unknown) { if(method==='status') return Promise.resolve({configured,endpoint});return controlled.request(method,input); },close(){client?.close();controlled.close();}};
}
