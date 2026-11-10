/** 需求阶段与修复草稿共用顶层报告读取：只取一个明确 JSON 围栏，业务字段交由各自 schema 校验，避免两套解析规则漂移。 */
export function readDeliveryReport(result: string, allowTaskResultJson = false): unknown {
  const blocks: string[] = [];
  const jsonBlocks: string[] = [];
  let reportStarts = 0;
  let fence: { marker: string; length: number; report: boolean; json: boolean; lines: string[] } | undefined;
  for (const line of result.split(/\r?\n/)) {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)?.[1];
      if (closing && closing[0] === fence.marker && closing.length >= fence.length) {
        if (fence.report) blocks.push(fence.lines.join('\n'));
        if (fence.json) jsonBlocks.push(fence.lines.join('\n'));
        fence = undefined;
      } else if (fence.report || fence.json) fence.lines.push(line);
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) continue;
    // 正式报告按协议顶格；缩进围栏仅用于跳过列表或格式示例。
    fence = { marker: opening[1][0], length: opening[1].length,
      report: line[0] === '`' && opening[2].trim() === 'delivery-report',
      json: allowTaskResultJson && line[0] === '`' && opening[2].trim() === 'json', lines: [] };
    if (fence.report) reportStarts += 1;
  }
  if (!reportStarts && allowTaskResultJson && !fence) {
    const candidates = jsonBlocks.flatMap(block => {
      try {
        const value = JSON.parse(block);
        return value?.version === 1 && ['implementer', 'verifier', 'reviewer'].includes(value.taskResult?.role)
          && ['succeeded', 'failed', 'blocked'].includes(value.taskResult?.status) ? [value] : [];
      } catch { return []; }
    });
    if (candidates.length === 1) return candidates[0];
  }
  if (blocks.length !== 1 || reportStarts !== 1) throw new Error('本轮结果需包含一个明确的 delivery-report JSON，开始围栏必须顶格且不放在示例或引用中');
  try { return JSON.parse(blocks[0]); } catch { throw new Error('delivery-report 不是有效 JSON，原记录已保留'); }
}

/** 执行器偶尔使用 json 标签；仅兼容唯一顶层任务结果，业务字段仍由岗位 schema 校验。 */
export const readAgentDeliveryReport = (result: string): unknown => readDeliveryReport(result, true);

/** 交付文件可在复核轮再次声明；不要求本轮重新改写，也不把日志或输入附件当作产物。 */
export function deliveryOutputPaths(result: string): string[] {
  try {
    const report = readAgentDeliveryReport(result) as { taskResult?: { output?: { path?: unknown }; outputFile?: unknown } } | null;
    return [...new Set([report?.taskResult?.output?.path, report?.taskResult?.outputFile]
      .filter((value): value is string => typeof value === 'string' && !!value.trim() && value.length <= 2000))];
  } catch { return []; }
}
