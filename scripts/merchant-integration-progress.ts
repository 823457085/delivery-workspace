/** 商家批次沿用通用台账验证，保持旧脚本入口兼容。 */
import { initializeExecutionProgress, updateExecutionProgress } from './integration-execution-progress.js';
const action = process.argv[2];
if (action === 'init') {
  const plan = await initializeExecutionProgress(process.cwd());
  console.log(JSON.stringify({ tasks: plan.tasks.map(task => task.id) }));
} else {
  const run = await updateExecutionProgress(process.cwd(), 'merchant', action as Parameters<typeof updateExecutionProgress>[2], JSON.parse(process.argv[3]));
  console.log(JSON.stringify({ status: run.status, current: run.current, updatedAt: run.updatedAt }));
}
