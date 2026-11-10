/** 模型与强度的页面投影；嵌入强度的执行器始终保留目录中的原始模型 ID。 */
import { computed, type Ref } from 'vue';
import { agentReasoningEfforts, type AgentModelOption, type AgentReasoningEffort, type AgentRuntimeHealth } from '../../../shared/agent-runtime';

type Effort = AgentReasoningEffort | '';
type Runtime = Pick<AgentRuntimeHealth, 'provider' | 'models' | 'defaultModel'>;
export interface ModelSelectionChoice {
  id: string;
  label: string;
  customId?: string;
  embedded: boolean;
  variants: { model: AgentModelOption; effort: Effort }[];
  efforts: AgentReasoningEffort[];
}

function embeddedVariant(runtime: Runtime, model: AgentModelOption) {
  if (model.customId || model.efforts?.length || !['antigravity', 'cursor'].includes(runtime.provider)) return;
  const match = /^(.*)-(low|medium|high|xhigh|max|ultra)(-fast)?$/.exec(model.id);
  if (!match) return;
  const effort = match[2] as AgentReasoningEffort, base = match[1]! + (match[3] || '');
  const labelled = /^(.*?)\s+\((low|medium|high|xhigh|max|ultra)\)$/i.exec(model.label);
  if (labelled?.[2]?.toLowerCase() === effort) return { base, label: labelled[1]!, effort };
  if (runtime.provider === 'cursor' && model.label === model.id) return { base, label: base, effort };
}

export function modelSelectionChoices(runtime?: Runtime): ModelSelectionChoice[] {
  if (!runtime) return [];
  const parsed = new Map(runtime.models.map(model => [model, embeddedVariant(runtime, model)]));
  const families = new Map<string, ModelSelectionChoice>();
  const choices: ModelSelectionChoice[] = [];
  for (const model of runtime.models) {
    const variant = parsed.get(model);
    // Cursor 的无后缀模型是独立默认档位，不猜测它对应哪一种强度。
    const family = variant || (runtime.provider === 'cursor' && !model.customId && !model.efforts?.length
      && model.label === model.id && [...parsed.values()].some(item => item?.base === model.id)
      ? { base: model.id, label: model.label, effort: '' as Effort } : undefined);
    if (!family) {
      choices.push({ id: model.id, label: model.label, customId: model.customId, embedded: false,
        variants: [{ model, effort: '' }], efforts: model.efforts || [] });
      continue;
    }
    let choice = families.get(family.base);
    if (!choice) {
      choice = { id: model.id, label: family.label, embedded: true, variants: [], efforts: [] };
      families.set(family.base, choice); choices.push(choice);
    }
    choice.variants.push({ model, effort: family.effort });
    choice.efforts = agentReasoningEfforts.filter(effort => choice!.variants.some(item => item.effort === effort));
  }
  return choices;
}

export function modelSelectionChoice(runtime: Runtime | undefined, model: string) {
  return modelSelectionChoices(runtime).find(choice => choice.variants.some(variant => variant.model.id === model));
}

export function modelSelectionEffort(runtime: Runtime | undefined, model: string, reasoningEffort: Effort): Effort {
  const choice = modelSelectionChoice(runtime, model);
  return choice?.embedded ? choice.variants.find(variant => variant.model.id === model)?.effort || '' : reasoningEffort;
}

export function selectModelChoice(runtime: Runtime | undefined, id: string, allowDefaultEffort = runtime?.provider === 'claude') {
  const choice = modelSelectionChoices(runtime).find(item => item.id === id);
  if (!choice) return { model: id, reasoningEffort: '' as Effort }; // 保留群聊既有手填模型入口。
  const variant = choice.embedded
    ? choice.variants.find(item => item.model.id === runtime?.defaultModel)
      || choice.variants.find(item => !item.effort) || choice.variants[0]!
    : choice.variants[0]!;
  return { model: variant.model.id, reasoningEffort: choice.embedded ? '' as Effort
    : variant.model.defaultEffort || (allowDefaultEffort ? '' : choice.efforts[0] || '') };
}

export function selectModelEffort(runtime: Runtime | undefined, model: string, effort: Effort) {
  const choice = modelSelectionChoice(runtime, model);
  if (choice?.embedded) {
    const variant = choice.variants.find(item => item.effort === effort);
    return variant ? { model: variant.model.id, reasoningEffort: '' as Effort } : undefined;
  }
  return !effort || choice?.efforts.includes(effort) ? { model, reasoningEffort: effort } : undefined;
}

export function useAgentModelSelection(runtime: () => Runtime | undefined, rawModel: Ref<string>, rawEffort: Ref<Effort>,
  options: { allowDefaultEffort?: boolean } = {}) {
  const choices = computed(() => modelSelectionChoices(runtime()));
  const choice = computed(() => choices.value.find(item => item.variants.some(variant => variant.model.id === rawModel.value)));
  const nativeDefault = () => options.allowDefaultEffort ?? runtime()?.provider === 'claude';
  const model = computed({ get: () => choice.value?.id ?? rawModel.value, set: (id: string) => {
    const next = selectModelChoice(runtime(), id, nativeDefault()); rawModel.value = next.model; rawEffort.value = next.reasoningEffort;
  } });
  const effort = computed({ get: () => choice.value?.embedded
    ? choice.value.variants.find(item => item.model.id === rawModel.value)?.effort || '' : rawEffort.value,
  set: (value: Effort) => {
    const next = selectModelEffort(runtime(), rawModel.value, value);
    if (next) { rawModel.value = next.model; rawEffort.value = next.reasoningEffort; }
  } });
  return { model, effort, models: choices, efforts: computed(() => choice.value?.efforts || []),
    allowDefaultEffort: computed(() => choice.value?.embedded ? choice.value.variants.some(item => !item.effort) : nativeDefault()) };
}
