// 独立启动入口兼容 PM2 的加载方式，测试只导入无启动副作用的网关模块。
import { startLanGateway } from './lan-gateway.js';

startLanGateway().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
