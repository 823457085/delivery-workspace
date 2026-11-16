/** Public github.com only. Tokens never participate in a URL. */
export function githubRepository(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入 https://github.com/所有者/仓库 地址'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) throw new Error('GitHub 来源仅接受无凭据的 github.com HTTPS 仓库地址');
  const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  if (parts.length !== 2 || !parts.every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part))) throw new Error('请填写仓库根地址，子目录在目录路径中填写');
  const owner = parts[0], repo = parts[1].replace(/\.git$/, '');
  if (!repo || ['.', '..'].includes(repo)) throw new Error('GitHub 仓库名称无效');
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}
export function githubOptions(input) {
  const repository = githubRepository(input.baseUrl || input.location || '');
  const directory = (input.githubPath || '').trim();
  if (directory.length > 500 || directory && !directory.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part))) throw new Error('目录路径须为仓库内相对路径，不允许越界');
  const kind = input.githubKind || 'market', policy = input.githubPolicy || 'stable', ref = (input.githubRef || '').trim();
  if (!['market', 'plugin'].includes(kind) || !['stable', 'all', 'pinned'].includes(policy)) throw new Error('GitHub 仓库类型或版本策略无效');
  if (ref.includes('..') || ref.startsWith('/') || ref.endsWith('/') || ref.length > 200 || /[\x00-\x20\x7f?#\\]/.test(ref) || policy === 'pinned' && !ref) throw new Error('固定版本策略需要有效的 Release 标签');
  return { ...repository, directory, kind, policy, ref };
}
