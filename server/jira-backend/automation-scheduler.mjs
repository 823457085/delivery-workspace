/**
 * 设计说明：一次定时维护包含扫描、周报和 Jira 回读，单项失败不能跳过其余项目。
 * 这里只负责串行调度和防重入；业务写入仍由原服务处理，注入任务便于隔离验证失败场景。
 */
import { getDueAutomationSlot } from "./automation-core.mjs";
import { getDueWeeklyReportSlot, sanitizeWeeklyReportState } from "./weekly-report.mjs";

export function createAutomationSchedulerTick({
  readState,
  runScan,
  runWeeklyReport,
  reconcile,
  onError,
  now = () => new Date()
}) {
  let pending = null;
  const runStep = async (name, task) => {
    try {
      await task();
    } catch (error) {
      onError(name, error);
    }
  };

  return function tick() {
    if (!pending) {
      pending = Promise.resolve().then(async () => {
        await runStep("Automation scan", async () => {
          const state = await readState();
          const slot = getDueAutomationSlot(state.settings, state.lastScheduledSlot, now());
          if (slot) await runScan("schedule", slot);
        });
        await runStep("Weekly report generation", async () => {
          const state = await readState();
          const report = sanitizeWeeklyReportState(state.weeklyReport);
          const slot = getDueWeeklyReportSlot(report.settings, report.lastScheduledSlot, now());
          if (slot) await runWeeklyReport("schedule", slot);
        });
        await runStep("Jira reconciliation", reconcile);
      }).finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
