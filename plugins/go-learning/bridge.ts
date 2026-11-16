import { host } from '../../shared/plugin-application-sdk';
export { host };
/** Keep the studio's response handling while routing every operation through the granted host bridge. */
export async function pluginFetch(resource: string, init?: RequestInit): Promise<Response> {
  const url = new URL(resource, 'http://plugin.local');
  try {
    if (!url.pathname.startsWith('/api/go-learning/')) throw new Error('插件请求路径无效');
    const input = init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams);
    const result = await host.request(url.pathname.slice('/api/go-learning/'.length), input);
    return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (error) { return new Response(JSON.stringify({ message: error instanceof Error ? error.message : '插件操作失败' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
}
