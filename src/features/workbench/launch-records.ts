import type { RequirementDevelopmentRecord } from '../../../shared/requirement-development';
import type { JiraFixRecord } from '../../../shared/jira-fix';

interface LaunchRecords { 'requirement-development': RequirementDevelopmentRecord; 'jira-fix': JiraFixRecord }

/** 只读现有启动记录，复用启动页缓存；来源异常必须保留为未知，不能伪装成空数组。 */
export async function readLaunchRecords<T extends keyof LaunchRecords>(source: T, signal?: AbortSignal): Promise<LaunchRecords[T][]> {
  const response = await fetch(`/api/agent-runtimes/${source}`, { signal });
  if (response.headers.get('X-Delivery-Source') === 'Delivery-Offline') throw new Error('交付后端不可用，无法确认启动记录');
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `启动记录读取失败 (${response.status})`);
  if (!Array.isArray(data.records)) throw new Error('启动记录响应缺少 records，无法确认当前记录');
  return data.records;
}
