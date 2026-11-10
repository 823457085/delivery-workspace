import { z } from 'zod';

/** 岗位结构化结果校验失败保留字段与原始规则，其他执行错误仍原样返回。 */
export function agentResultErrorMessage(error: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error);
  const details = (issues: z.ZodError['issues'], parent: PropertyKey[] = []): string[] => issues.flatMap(issue => {
    const path = [...parent, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.some(branch => branch.length)) return details(issue.errors.flat(), path);
    const field = path.map((part, index) => typeof part === 'number' ? `[${part}]` : `${index ? '.' : ''}${String(part)}`).join('');
    return [`${field || '结果'}：${issue.message}`];
  });
  return `岗位返回的结果格式不符合约定：\n${details(error.issues).join('\n')}`;
}
