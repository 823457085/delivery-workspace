/** 仅供服务器反向 SSH 隧道使用的回环入口，复用远端目录选择和主服务的写操作校验。 */
import { resolveWorkspaceServicePort } from './http-security.js';
import { createLanGateway } from './lan-gateway.js';

const upstreamPort = resolveWorkspaceServicePort();
const server = createLanGateway({ address: '127.0.0.1', netmask: '255.0.0.0' }, upstreamPort, ['127.0.0.1'], {
  readOnly: process.env.DELIVERY_GATEWAY_READ_ONLY === '1',
  writeToken: process.env.DELIVERY_GATEWAY_WRITE_TOKEN || '',
});
server.listen(5220, '127.0.0.1', () => console.log('Delivery remote bridge: 127.0.0.1:5220'));
const stop = () => { server.closeAllConnections(); server.close(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
