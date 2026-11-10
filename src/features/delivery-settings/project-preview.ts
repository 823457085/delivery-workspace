import type { AutomationProjectPreview, AutomationSettings } from '../../../shared/hub';

/** 使用表单草稿核对已有快照；此接口不保存设置或启动巡检。 */
export async function requestProjectPreview(settings: AutomationSettings, request: typeof fetch = fetch): Promise<AutomationProjectPreview> {
  const response = await request('/api/automation/project-preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings }),
  });
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.details || result.message || result.error || `项目匹配预览失败 (${response.status})`);
  return result as AutomationProjectPreview;
}
