/** 与原交付设置的输入语义对齐；只校验本页公开编辑的字段，不复制服务端设置清洗或默认值。 */
import type { AutomationSettings } from '../../../shared/hub';

export function validDeliverySettings(value?: AutomationSettings) {
  return !!value && value.dailyTimes.length > 0 && value.dailyTimes.every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    && Number.isInteger(value.maxDispatchPerRun) && value.maxDispatchPerRun >= 0
    && !!value.targetBranch.trim() && !!value.startStatus.trim() && !!value.completedStatus.trim();
}
