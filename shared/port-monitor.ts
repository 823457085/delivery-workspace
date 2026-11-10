export type PortScope = 'loopback' | 'lan' | 'all' | 'unknown';

export type PortProject = { name: string; workspacePath: string; branch: string };
export type PortListener = {
  port: number; address: string; scope: PortScope; pid: number; process: string; user: string;
  command: string; cwd: string;
  project?: PortProject;
  service: string;
  mode: string;
  manager: string;
  launchCommand: string;
};
export type PortStoppedService = {
  id: string;
  port: number;
  process: string;
  user: string;
  command: string;
  cwd: string;
  project?: PortProject;
  service: string;
  mode: string;
  manager: string;
  launchCommand: string;
  state: 'stopped' | 'errored';
  pmId?: number;
  stoppedAt?: string;
};
export type PortActionType = 'start' | 'restart' | 'stop' | 'delete' | 'create';
export type PortActionRequest = {
  action: PortActionType;
  port?: number;
  pid?: number;
  manager?: string;
  stoppedId?: string;
  cwd?: string;
  command?: string;
  launchCommand?: string;
  service?: string;
  mode?: string;
  project?: PortProject;
  usePm2?: boolean;
  pm2Name?: string;
  ports?: string;
};
export type PortActionResult = {
  ok: boolean;
  message: string;
  selfRestarting?: boolean;
  snapshot?: PortSnapshot;
};
export type PortStatus = { port: number; status: 'listening' | 'available'; listeners: PortListener[] };
export type PortSnapshot = {
  scannedAt: string;
  ports: PortStatus[];
  stopped?: PortStoppedService[];
  selfPort?: number;
  summary: {
    listeningPorts: number;
    listenerCount: number;
    processCount: number;
    projectCount: number;
    stoppedCount?: number;
    pm2Count?: number;
  };
};

export function parsePortList(value: string | null | undefined): number[] {
  const text = value?.trim() || '';
  if (!text) return [];
  const ports = new Set<number>();
  for (const token of text.split(/[\s,，]+/).filter(Boolean)) {
    const match = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`端口格式不正确：${token}。请使用 5173、5173,5199 或 5173-5199。`);
    const start = Number(match[1]), end = Number(match[2] || match[1]);
    if (start < 1 || end > 65_535 || start > end) throw new Error(`端口范围不正确：${token}`);
    if (end - start >= 512) throw new Error('一次最多检查 512 个端口');
    for (let port = start; port <= end; port++) ports.add(port);
    if (ports.size > 512) throw new Error('一次最多检查 512 个端口');
  }
  return [...ports].sort((left, right) => left - right);
}
