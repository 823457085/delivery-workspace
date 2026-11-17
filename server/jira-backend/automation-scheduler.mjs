/**
 * 设计说明：一次定时维护包含扫描、周报和 Jira 回读，单项失败不能跳过其余项目。
 * 这里只负责串行调度和防重入；业务写入仍由原服务处理，注入任务便于隔离验证失败场景。
 */
import {
  computeAutomationScheduleBackoffMs,
  getDueAutomationSlot,
  shouldDeferScheduledScan
} from "./automation-core.mjs";
import { getDueWeeklyReportSlot, sanitizeWeeklyReportState } from "./weekly-report.mjs";

export function createAutomationSchedulerTick({
  readState,
  runScan,
  runWeeklyReport,
  reconcile,
  onError,
  now = () => new Date(),
  retryBackoffMs = 0,
  maxConsecutiveFailures = Infinity
}) {
  let pending = null;
  let failureSlot = "";
  let failureCount = 0;
  let retryNotBeforeMs = 0;

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
          const currentNow = now();
          const state = await readState();
          const slot = getDueAutomationSlot(state.settings, state.lastScheduledSlot, currentNow);
          if (!slot) return;
          if (shouldDeferScheduledScan(state, slot, currentNow)) return;
          if (failureSlot === slot) {
            if (failureCount >= maxConsecutiveFailures) return;
            if (retryNotBeforeMs > currentNow.getTime()) return;
          }
          try {
            await runScan("schedule", slot);
            if (failureSlot === slot) {
              failureSlot = "";
              failureCount = 0;
              retryNotBeforeMs = 0;
            }
          } catch (error) {
            failureCount = failureSlot === slot ? failureCount + 1 : 1;
            failureSlot = slot;
            retryNotBeforeMs = retryBackoffMs > 0
              ? currentNow.getTime() + computeAutomationScheduleBackoffMs(failureCount, retryBackoffMs)
              : 0;
            throw error;
          }
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
