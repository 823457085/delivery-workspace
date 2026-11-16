import { host } from '../../shared/plugin-application-sdk';
import { confirmAction } from '../_shared/confirmation';
const routes: Record<string,string> = {
 'GET /account/refresh/schedule':'account.schedule','PUT /account/refresh/schedule':'account.schedule-save',
 'GET /status':'status','GET /nodes':'nodes','GET /config':'config','GET /network':'network','PUT /network':'network.save',
 'POST /account/login':'account.login','POST /account/refresh':'account.refresh','POST /nodes/select':'nodes.select','POST /nodes/delay':'nodes.delay',
 'POST /connection/check':'connection.check','POST /connection':'connection','GET /clash/subscription':'subscription','PUT /clash/subscription':'subscription.save','POST /clash/subscription/rotate':'subscription.rotate','DELETE /clash/subscription':'subscription.delete',
};
export async function serviceApi(path: string, options: {method?: string;body?: string} = {}) {
 if (path === '/session') return host.request('session');
 if (path === '/session/logout') return host.request('disconnect');
 const method = options.method || 'GET', operation = routes[`${method} ${path}`];
 if (!operation) throw new Error('不支持的插件接口');
 const input = options.body ? JSON.parse(options.body) : {};
 if (method === 'GET' || ['nodes.delay','connection.check'].includes(operation)) return host.request('read',{operation,input});
 const preview = await host.request('preview',{operation,input});
 const details = operation === 'connection' ? `操作：${input.action}` : operation === 'network.save' ? `监听：${input.address}:${input.httpPort} / ${input.socksPort}；允许网段：${input.allowedSubnet}` : operation === 'nodes.select' ? `节点：${input.id}` : operation === 'subscription.save' ? `启用：${input.enabled}；转接：${input.server}:${input.port}` : '';
 if (!await confirmAction(`${preview.label}\n服务：${preview.endpoint}\n${details}`)) throw new Error('已取消操作');
 return host.request('execute',{token:preview.token});
}
