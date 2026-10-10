/** 当前 Codex 会话领取阶段；服务端不启动模型、不读取账号凭据。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { desktopClaimSchema, desktopSubmissionSchema, type DesignExecution, type ExecutorHealth } from '../../shared/design-execution.js';
import { stagePrompt } from './policy.js';
import { resolveDesignSupportPaths } from './support.js';

export async function desktopHealth(environment: NodeJS.ProcessEnv = process.env): Promise<ExecutorHealth> {
  const { skillRoot, kitRoot } = resolveDesignSupportPaths(environment);
  let skillsReady = true;
  try {
    for (const name of ['apex-frontend-tech-design-delivery', 'apex-jira-feature-development', 'delivery-gate-docs', 'confluence-markdown-publish', 'jira-task-compliance']) await fs.access(path.join(skillRoot, name, 'SKILL.md'));
    await fs.access(path.join(kitRoot, 'prompts/S2a-tech-design.md'));
    await fs.access(path.join(kitRoot, 'artifacts/templates/tech-design.md'));
  } catch { skillsReady = false; }
  return { mode: 'codex-desktop', ready: skillsReady, cli: '', authenticated: false, atlassianConfigured: false, skillsReady,
    checkedAt: new Date().toISOString(), message: skillsReady ? 'Codex 会话执行；本机领取与回写接口就绪。账号、工具与远端权限由执行会话核实，不启动 CLI。' : 'Skill / 规范包缺失' };
}
export function desktopPacket(run: DesignExecution) {
  const { skillRoot, kitRoot } = resolveDesignSupportPaths();
  const stage = run.steps.find(step => step.status !== 'passed')?.id;
  return { run: structuredClone(run), stage: stage ?? null,
    prompt: stage ? stagePrompt(stage, run, skillRoot, kitRoot) : '',
    claimSchema: z.toJSONSchema(desktopClaimSchema), submissionSchema: z.toJSONSchema(desktopSubmissionSchema),
    instructions: '在当前 Codex 会话执行，不启动 codex CLI、不创建或委托其他会话。先用 revision 和实际 threadId POST claim；只执行返回阶段，使用现有工具取得真实证据。完成后用 claimId/threadId/stage/result/proof POST submit。proof 仅记录本轮实际工具调用，不得根据正文或旧日志编造；服务端按会话上报凭证保存，不声称独立捕获了工具日志。通过后重新 GET desktop 并领取下一阶段；blocked 时停止。断线先 GET 核对已有结果，不盲目重做外部写入。',
  };
}
