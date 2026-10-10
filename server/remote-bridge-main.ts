/** 仅供服务器反向 SSH 隧道使用的回环入口，复用远端目录选择和主服务的写操作校验。 */
import { createLanGateway } from './lan-gateway.js';

const server = createLanGateway({ address: '127.0.0.1', netmask: '255.0.0.0' }, 5199, ['127.0.0.1']);
server.listen(5220, '127.0.0.1', () => console.log('Delivery remote bridge: 127.0.0.1:5220'));
const stop = () => { server.closeAllConnections(); server.close(); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
