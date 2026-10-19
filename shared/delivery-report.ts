/** 需求阶段与修复草稿共用顶层报告读取：只取一个明确 JSON 围栏，业务字段交由各自 schema 校验，避免两套解析规则漂移。 */
export function readDeliveryReport(result: string): unknown {
  const blocks: string[] = [];
  let fence: { marker: string; length: number; report: boolean; lines: string[] } | undefined;
  for (const line of result.split(/\r?\n/)) {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line)?.[1];
      if (closing && closing[0] === fence.marker && closing.length >= fence.length) {
        if (fence.report) blocks.push(fence.lines.join('\n'));
        fence = undefined;
      } else if (fence.report) fence.lines.push(line);
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) continue;
    // 正式报告按协议顶格；缩进围栏仅用于跳过列表或格式示例。
    fence = { marker: opening[1][0], length: opening[1].length,
      report: line[0] === '`' && opening[2].trim() === 'delivery-report', lines: [] };
  }
  if (blocks.length !== 1) throw new Error('本轮结果需包含一个明确的 delivery-report JSON，开始围栏必须顶格且不放在示例或引用中');
  try { return JSON.parse(blocks[0]); } catch { throw new Error('delivery-report 不是有效 JSON，原记录已保留'); }
}
