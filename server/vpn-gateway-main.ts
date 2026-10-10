// 独立进程，不重启正在承载 Agent 任务的工作台。
import { startVpnGateway } from './vpn-gateway.js';

startVpnGateway().catch((error) => { console.error((error as Error).message); process.exitCode = 1; });
