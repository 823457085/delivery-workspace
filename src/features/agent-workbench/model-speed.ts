import type { AgentRuntimeHealth, AgentServiceTier } from '../../../shared/agent-runtime';

/** 从模型目录读取速度档位；可传入当前输入区的覆盖值，描述沿用目录原文。 */
export function modelSpeed(runtime: AgentRuntimeHealth | undefined, modelId: string, serviceTier?: AgentServiceTier) {
  if (runtime?.provider !== 'codex') return;
  const model = runtime.models.find(item => item.id === (modelId || runtime.configuredModel));
  const tier = serviceTier ?? runtime.configuredServiceTier;
  const canonical = (id: string | null | undefined) => id === 'fast' ? 'priority' : id;
  return model?.serviceTiers?.find(item => canonical(item.id) === canonical(tier));
}

/** 隐藏了 Fast 开关的模型必须按普通速度发送，不能沿用之前模型的选择。 */
export function codexServiceTier(runtime: AgentRuntimeHealth | undefined, modelId: string, selected?: AgentServiceTier): AgentServiceTier {
  return modelSpeed(runtime, modelId, 'priority')
    && (selected === 'priority' || (selected === undefined && ['fast', 'priority'].includes(runtime?.configuredServiceTier || '')))
    ? 'priority' : 'default';
}
