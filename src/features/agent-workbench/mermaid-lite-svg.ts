/**
 * 设计说明：借鉴 GitHub 标杆项目 Open WebUI / Cherry Studio / LobeChat 的 Mermaid 图表直出预览。
 * 在不引入数 MB 第三方 mermaid 运行时的前提下，用零依赖纯 TypeScript 实现高频 AI 图表：
 * 1. `flowchart` / `graph`（TD / TB / BT / LR / RL，支持矩形、圆角、胶囊、菱形判断、圆柱数据库、虚线/实线带标签连线及链式连线）；
 * 2. `sequenceDiagram`（支持 participant / actor 别名、autonumber、实线/虚线调用、自调用回路与 Note 注释条）；
 * 3. 所有文本严格 XML 转义，并通过 `data:image/svg+xml;charset=utf-8,...` 交由 `<img>` 渲染，完全不使用 `v-html`，天然杜绝脚本执行。
 */

export type MermaidDiagramKind = 'flowchart' | 'sequence';
export type FlowDirection = 'TD' | 'TB' | 'BT' | 'LR' | 'RL';
export type FlowNodeShape = 'rect' | 'round' | 'stadium' | 'diamond' | 'cylinder' | 'circle';

interface FlowNode {
  id: string;
  label: string;
  shape: FlowNodeShape;
  explicitLabel: boolean;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
  style: 'solid' | 'dashed' | 'thick';
  directed: boolean;
}

interface SeqParticipant {
  id: string;
  label: string;
  isActor: boolean;
}

type SeqItem =
  | {
      type: 'message';
      from: string;
      to: string;
      label: string;
      dashed: boolean;
    }
  | {
      type: 'note';
      actors: string[];
      label: string;
    };

export interface MermaidRenderResult {
  kind: MermaidDiagramKind;
  svg: string;
  width: number;
  height: number;
  nodeCount: number;
  edgeCount: number;
}

const MAX_MERMAID_CHARS = 16_000;
const MAX_MERMAID_NODES = 80;
const MAX_MERMAID_EDGES = 160;

export function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function svgToDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function cleanLabelText(raw: string): string {
  let text = raw.trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\\n/g, '\n')
    .replace(/&quot;/g, '"')
    .trim();
}

function visualWidthUnits(line: string): number {
  let units = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0) || 0;
    units += code > 0x2e7f ? 1.85 : 1;
  }
  return units;
}

function wrapLabelLines(label: string, maxUnitsPerLine = 22): string[] {
  const rawLines = (label || '').split('\n');
  const out: string[] = [];
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (visualWidthUnits(trimmed) <= maxUnitsPerLine) {
      out.push(trimmed);
      continue;
    }
    let current = '';
    let currentUnits = 0;
    for (const ch of trimmed) {
      const w = (ch.codePointAt(0) || 0) > 0x2e7f ? 1.85 : 1;
      if (current && currentUnits + w > maxUnitsPerLine) {
        out.push(current.trim());
        current = ch;
        currentUnits = w;
      } else {
        current += ch;
        currentUnits += w;
      }
    }
    if (current.trim()) out.push(current.trim());
  }
  return out.length ? out.slice(0, 4) : [' '];
}

function measureTextLines(lines: readonly string[], fontPx = 12.5): { width: number; height: number } {
  const maxUnits = lines.reduce((max, line) => Math.max(max, visualWidthUnits(line)), 1);
  const width = Math.ceil(maxUnits * (fontPx * 0.62));
  const height = Math.ceil(lines.length * (fontPx * 1.42));
  return { width, height };
}

function stripMermaidComments(source: string): string[] {
  const normalized = source
    .replace(/\r\n/g, '\n')
    .replace(/%%\{[\s\S]*?\}%%/g, '');
  const lines: string[] = [];
  for (const rawLine of normalized.split('\n')) {
    const withoutComment = rawLine.replace(/%%.*$/, '').trim();
    if (!withoutComment) continue;
    lines.push(withoutComment);
  }
  return lines;
}

function parseFlowNodeSpec(rawToken: string): FlowNode | undefined {
  const token = rawToken.trim().replace(/:::[A-Za-z0-9_-]+$/, '').trim();
  if (!token) return undefined;

  const patterns: Array<{ regex: RegExp; shape: FlowNodeShape }> = [
    { regex: /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*\(\[([\s\S]+)\]\)$/, shape: 'stadium' },
    { regex: /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*\[\(([\s\S]+)\)\]$/, shape: 'cylinder' },
    { regex: /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*\(\(([\s\S]+)\)\)$/, shape: 'circle' },
    { regex: /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*\[\[([\s\S]+)\]\]$/, shape: 'rect' },
    { regex: /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*\{([\s\S]+)\}$/, shape: 'diamond' },
    { regex: /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*\(([\s\S]+)\)$/, shape: 'round' },
    { regex: /^([A-Za-z0-9_\u4e00-\u9fa5.-]+)\s*\[([\s\S]+)\]$/, shape: 'rect' },
  ];

  for (const { regex, shape } of patterns) {
    const match = token.match(regex);
    if (match) {
      const id = match[1]!.trim();
      const label = cleanLabelText(match[2] || id) || id;
      return { id, label, shape, explicitLabel: true };
    }
  }

  if (/^[A-Za-z0-9_\u4e00-\u9fa5.-]+$/.test(token)) {
    return { id: token, label: token, shape: 'rect', explicitLabel: false };
  }
  return undefined;
}

interface ParsedArrowSegment {
  index: number;
  length: number;
  label: string;
  style: 'solid' | 'dashed' | 'thick';
  directed: boolean;
}

function findNextArrow(statement: string, startFrom = 0): ParsedArrowSegment | undefined {
  // 跳过节点方括号/花括号/圆括号及双引号内部的内容，只在外层寻找连线符号
  let depthSquare = 0;
  let depthRound = 0;
  let depthCurly = 0;
  let inQuote: '"' | "'" | null = null;

  const arrowPatterns: Array<{
    regex: RegExp;
    style: 'solid' | 'dashed' | 'thick';
    directed: boolean;
    labelGroup?: number;
  }> = [
    { regex: /^-\.\s*([^.\r\n]+?)\s*\.->/, style: 'dashed', directed: true, labelGroup: 1 },
    { regex: /^-\.+->\s*\|([^|]*)\|/, style: 'dashed', directed: true, labelGroup: 1 },
    { regex: /^-\.+->/, style: 'dashed', directed: true },
    { regex: /^==\s*([^=\r\n]+?)\s*==>/, style: 'thick', directed: true, labelGroup: 1 },
    { regex: /^==+>\s*\|([^|]*)\|/, style: 'thick', directed: true, labelGroup: 1 },
    { regex: /^==+>/, style: 'thick', directed: true },
    { regex: /^--\s*([^-\r\n>][^-\r\n]*?)\s*--+>/, style: 'solid', directed: true, labelGroup: 1 },
    { regex: /^--+>\s*\|([^|]*)\|/, style: 'solid', directed: true, labelGroup: 1 },
    { regex: /^--+>/, style: 'solid', directed: true },
    { regex: /^---+\s*\|([^|]*)\|/, style: 'solid', directed: false, labelGroup: 1 },
    { regex: /^---+/, style: 'solid', directed: false },
  ];

  for (let i = startFrom; i < statement.length; i++) {
    const ch = statement[i]!;
    if (inQuote) {
      if (ch === inQuote && statement[i - 1] !== '\\') inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '[') { depthSquare++; continue; }
    if (ch === ']') { depthSquare = Math.max(0, depthSquare - 1); continue; }
    if (ch === '(') { depthRound++; continue; }
    if (ch === ')') { depthRound = Math.max(0, depthRound - 1); continue; }
    if (ch === '{') { depthCurly++; continue; }
    if (ch === '}') { depthCurly = Math.max(0, depthCurly - 1); continue; }

    if (depthSquare > 0 || depthRound > 0 || depthCurly > 0) continue;

    if (ch !== '-' && ch !== '=') continue;
    const slice = statement.slice(i);
    for (const spec of arrowPatterns) {
      const m = slice.match(spec.regex);
      if (m) {
        return {
          index: i,
          length: m[0].length,
          label: spec.labelGroup ? cleanLabelText(m[spec.labelGroup] || '') : '',
          style: spec.style,
          directed: spec.directed,
        };
      }
    }
  }
  return undefined;
}

function splitStatementsBySemicolon(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === inQuote && line[i - 1] !== '\\') inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ';') {
      const piece = line.slice(start, i).trim();
      if (piece) parts.push(piece);
      start = i + 1;
    }
  }
  const rest = line.slice(start).trim();
  if (rest) parts.push(rest);
  return parts;
}

function parseFlowchart(lines: readonly string[]): {
  direction: FlowDirection;
  nodes: FlowNode[];
  edges: FlowEdge[];
} | undefined {
  const header = lines[0] || '';
  const headerMatch = header.match(/^(?:flowchart|graph)(?:\s+(TD|TB|BT|LR|RL))?\s*;?$/i);
  if (!headerMatch) return undefined;
  const rawDir = (headerMatch[1] || 'TD').toUpperCase() as FlowDirection;

  const nodeMap = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];

  function upsertNode(parsed: FlowNode) {
    const prev = nodeMap.get(parsed.id);
    if (!prev) {
      if (nodeMap.size < MAX_MERMAID_NODES) {
        nodeMap.set(parsed.id, parsed);
      }
      return;
    }
    if (parsed.explicitLabel) {
      nodeMap.set(parsed.id, parsed);
    }
  }

  for (let lineIdx = 1; lineIdx < lines.length; lineIdx++) {
    for (const stmt of splitStatementsBySemicolon(lines[lineIdx]!)) {
      if (
        /^(?:subgraph\b|end$|direction\s+|style\s+|classDef\s+|class\s+|linkStyle\s+|click\s+)/i.test(stmt)
      ) {
        continue;
      }

      const firstArrow = findNextArrow(stmt, 0);
      if (!firstArrow) {
        const single = parseFlowNodeSpec(stmt);
        if (single && single.explicitLabel) upsertNode(single);
        continue;
      }

      // 解析链式连线：A --> B --> C
      const groupTokens: string[] = [];
      const arrows: ParsedArrowSegment[] = [];
      let cursor = 0;
      let nextArrow: ParsedArrowSegment | undefined = firstArrow;
      while (nextArrow) {
        groupTokens.push(stmt.slice(cursor, nextArrow.index).trim());
        arrows.push(nextArrow);
        cursor = nextArrow.index + nextArrow.length;
        nextArrow = findNextArrow(stmt, cursor);
      }
      groupTokens.push(stmt.slice(cursor).trim());

      const parsedGroups = groupTokens.map(groupStr =>
        groupStr
          .split(/\s*&\s*/)
          .map(part => parseFlowNodeSpec(part))
          .filter((item): item is FlowNode => Boolean(item)),
      );

      for (const group of parsedGroups) {
        for (const node of group) upsertNode(node);
      }

      for (let i = 0; i < arrows.length; i++) {
        const leftGroup = parsedGroups[i] || [];
        const rightGroup = parsedGroups[i + 1] || [];
        const arrow = arrows[i]!;
        for (const left of leftGroup) {
          for (const right of rightGroup) {
            if (!nodeMap.has(left.id) || !nodeMap.has(right.id)) continue;
            if (edges.length < MAX_MERMAID_EDGES) {
              edges.push({
                from: left.id,
                to: right.id,
                label: arrow.label,
                style: arrow.style,
                directed: arrow.directed,
              });
            }
          }
        }
      }
    }
  }

  const nodes = [...nodeMap.values()];
  if (nodes.length === 0 || (edges.length === 0 && nodes.length < 2)) {
    return undefined;
  }
  return { direction: rawDir, nodes, edges };
}

function renderFlowchartSvg(
  direction: FlowDirection,
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
): MermaidRenderResult {
  const isHorizontal = direction === 'LR' || direction === 'RL';
  const isReversed = direction === 'BT' || direction === 'RL';

  // 1. 计算每个节点尺寸与折行文本
  const nodeMeta = new Map<string, {
    node: FlowNode;
    lines: string[];
    width: number;
    height: number;
  }>();

  for (const node of nodes) {
    const lines = wrapLabelLines(node.label, node.shape === 'diamond' ? 16 : 20);
    const measured = measureTextLines(lines, 12.5);
    let width = Math.max(96, measured.width + 28);
    let height = Math.max(40, measured.height + 20);
    if (node.shape === 'diamond') {
      width = Math.max(118, Math.ceil(measured.width * 1.45) + 34);
      height = Math.max(60, Math.ceil(measured.height * 1.45) + 26);
    } else if (node.shape === 'cylinder') {
      width = Math.max(104, measured.width + 30);
      height = Math.max(50, measured.height + 28);
    } else if (node.shape === 'circle') {
      const diameter = Math.max(54, Math.max(measured.width, measured.height) + 26);
      width = diameter;
      height = diameter;
    }
    nodeMeta.set(node.id, { node, lines, width, height });
  }

  // 2. 去环并计算分层（Rank）
  const orderIndex = new Map(nodes.map((n, idx) => [n.id, idx]));
  const inDegree = new Map<string, number>(nodes.map(n => [n.id, 0]));
  const forwardAdj = new Map<string, string[]>(nodes.map(n => [n.id, []]));
  const predAdj = new Map<string, string[]>(nodes.map(n => [n.id, []]));

  // 使用 DFS 检测回边，避免循环图卡死
  const reachable = (start: string, target: string): boolean => {
    if (start === target) return true;
    const visited = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nxt of forwardAdj.get(cur) || []) {
        if (nxt === target) return true;
        if (!visited.has(nxt)) {
          visited.add(nxt);
          queue.push(nxt);
        }
      }
    }
    return false;
  };

  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (reachable(edge.to, edge.from)) {
      // 回边，不参与拓扑层级推进
      continue;
    }
    forwardAdj.get(edge.from)?.push(edge.to);
    predAdj.get(edge.to)?.push(edge.from);
    inDegree.set(edge.to, (inDegree.get(edge.to) || 0) + 1);
  }

  const rank = new Map<string, number>(nodes.map(n => [n.id, 0]));
  const ready = nodes
    .filter(n => (inDegree.get(n.id) || 0) === 0)
    .map(n => n.id);
  const visitedTopo = new Set<string>();

  while (ready.length) {
    const cur = ready.shift()!;
    visitedTopo.add(cur);
    const curRank = rank.get(cur) || 0;
    for (const nxt of forwardAdj.get(cur) || []) {
      if ((rank.get(nxt) || 0) < curRank + 1) {
        rank.set(nxt, curRank + 1);
      }
      const nextDeg = (inDegree.get(nxt) || 1) - 1;
      inDegree.set(nxt, nextDeg);
      if (nextDeg === 0) ready.push(nxt);
    }
  }

  for (const n of nodes) {
    if (!visitedTopo.has(n.id)) rank.set(n.id, 0);
  }

  const maxRank = Math.max(0, ...rank.values());
  const layers: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const n of nodes) {
    const r = rank.get(n.id) || 0;
    const targetLayer = isReversed ? maxRank - r : r;
    layers[targetLayer]!.push(n.id);
  }

  // 重心启发式减少连线交叉
  for (let l = 1; l < layers.length; l++) {
    const prevOrder = new Map(layers[l - 1]!.map((id, idx) => [id, idx]));
    layers[l]!.sort((a, b) => {
      const aNeighbors = (isReversed ? forwardAdj.get(a) : predAdj.get(a)) || [];
      const bNeighbors = (isReversed ? forwardAdj.get(b) : predAdj.get(b)) || [];
      const aKnown = aNeighbors.filter(id => prevOrder.has(id));
      const bKnown = bNeighbors.filter(id => prevOrder.has(id));
      const aCenter = aKnown.length
        ? aKnown.reduce((sum, id) => sum + (prevOrder.get(id) || 0), 0) / aKnown.length
        : (orderIndex.get(a) || 0);
      const bCenter = bKnown.length
        ? bKnown.reduce((sum, id) => sum + (prevOrder.get(id) || 0), 0) / bKnown.length
        : (orderIndex.get(b) || 0);
      return aCenter - bCenter || (orderIndex.get(a) || 0) - (orderIndex.get(b) || 0);
    });
  }

  // 3. 计算坐标
  const PAD = 24;
  const RANK_GAP = isHorizontal ? 76 : 64;
  const SIBLING_GAP = isHorizontal ? 28 : 34;

  const layerPrimarySpan: number[] = [];
  const layerCrossSpan: number[] = [];

  for (const layer of layers) {
    let primaryMax = 40;
    let crossSum = 0;
    for (const id of layer) {
      const m = nodeMeta.get(id)!;
      const primary = isHorizontal ? m.width : m.height;
      const cross = isHorizontal ? m.height : m.width;
      primaryMax = Math.max(primaryMax, primary);
      crossSum += cross;
    }
    crossSum += Math.max(0, layer.length - 1) * SIBLING_GAP;
    layerPrimarySpan.push(primaryMax);
    layerCrossSpan.push(crossSum);
  }

  const maxCross = Math.max(160, ...layerCrossSpan);
  const totalPrimary = layerPrimarySpan.reduce((s, v) => s + v, 0) + Math.max(0, layers.length - 1) * RANK_GAP;

  const width = (isHorizontal ? totalPrimary : maxCross) + PAD * 2;
  const height = (isHorizontal ? maxCross : totalPrimary) + PAD * 2;

  const coords = new Map<string, { cx: number; cy: number; x: number; y: number; w: number; h: number }>();
  let primaryCursor = PAD;

  for (let l = 0; l < layers.length; l++) {
    const layer = layers[l]!;
    const pSpan = layerPrimarySpan[l]!;
    const cSpan = layerCrossSpan[l]!;
    let crossCursor = PAD + (maxCross - cSpan) / 2;

    for (const id of layer) {
      const m = nodeMeta.get(id)!;
      const w = m.width;
      const h = m.height;
      const x = isHorizontal ? primaryCursor + (pSpan - w) / 2 : crossCursor;
      const y = isHorizontal ? crossCursor : primaryCursor + (pSpan - h) / 2;
      coords.set(id, { cx: x + w / 2, cy: y + h / 2, x, y, w, h });
      crossCursor += (isHorizontal ? h : w) + SIBLING_GAP;
    }
    primaryCursor += pSpan + RANK_GAP;
  }

  // 4. 生成连线与标签 SVG
  const edgeSvgParts: string[] = [];
  const edgeLabelParts: string[] = [];

  for (const edge of edges) {
    const src = coords.get(edge.from);
    const dst = coords.get(edge.to);
    if (!src || !dst) continue;

    const dashAttr = edge.style === 'dashed' ? ' stroke-dasharray="5 4"' : '';
    const strokeWidth = edge.style === 'thick' ? 2.4 : 1.65;
    const markerEnd = edge.directed ? ' marker-end="url(#mm-arrow)"' : '';

    let pathD = '';
    let labelX = (src.cx + dst.cx) / 2;
    let labelY = (src.cy + dst.cy) / 2;

    if (edge.from === edge.to) {
      const rx = src.x + src.w;
      const ry = src.cy;
      pathD = `M ${rx} ${ry - 8} C ${rx + 36} ${ry - 28}, ${rx + 36} ${ry + 28}, ${rx} ${ry + 8}`;
      labelX = rx + 34;
      labelY = ry;
    } else if (isHorizontal) {
      const forward = dst.cx >= src.cx;
      if (forward) {
        const sx = src.x + src.w;
        const sy = src.cy;
        const tx = dst.x;
        const ty = dst.cy;
        const midX = (sx + tx) / 2;
        pathD = `M ${sx} ${sy} C ${midX} ${sy}, ${midX} ${ty}, ${tx} ${ty}`;
        labelX = midX;
        labelY = (sy + ty) / 2;
      } else {
        // 回边走上方弧线避免穿过节点
        const sx = src.cx;
        const sy = src.y;
        const tx = dst.cx;
        const ty = dst.y;
        const arcY = Math.max(8, Math.min(sy, ty) - 34);
        pathD = `M ${sx} ${sy} C ${sx} ${arcY}, ${tx} ${arcY}, ${tx} ${ty}`;
        labelX = (sx + tx) / 2;
        labelY = arcY + 8;
      }
    } else {
      const forward = dst.cy >= src.cy;
      if (forward) {
        const sx = src.cx;
        const sy = src.y + src.h;
        const tx = dst.cx;
        const ty = dst.y;
        const midY = (sy + ty) / 2;
        pathD = `M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty}`;
        labelX = (sx + tx) / 2;
        labelY = midY;
      } else {
        // 纵向回边走右侧弧线
        const sx = src.x + src.w;
        const sy = src.cy;
        const tx = dst.x + dst.w;
        const ty = dst.cy;
        const arcX = Math.min(width - 8, Math.max(sx, tx) + 36);
        pathD = `M ${sx} ${sy} C ${arcX} ${sy}, ${arcX} ${ty}, ${tx} ${ty}`;
        labelX = arcX - 4;
        labelY = (sy + ty) / 2;
      }
    }

    edgeSvgParts.push(
      `<path d="${pathD}" fill="none" stroke="#64748b" stroke-width="${strokeWidth}"${dashAttr}${markerEnd} />`,
    );

    if (edge.label) {
      const labelLines = wrapLabelLines(edge.label, 16);
      const box = measureTextLines(labelLines, 11);
      const bw = box.width + 12;
      const bh = box.height + 6;
      edgeLabelParts.push(
        `<g transform="translate(${(labelX - bw / 2).toFixed(1)},${(labelY - bh / 2).toFixed(1)})">`
        + `<rect width="${bw}" height="${bh}" rx="6" fill="#ffffff" stroke="#cbd5e1" stroke-width="1" />`
        + renderSvgLines(labelLines, bw / 2, bh / 2, 11, '#334155', 500)
        + `</g>`,
      );
    }
  }

  // 5. 生成节点 SVG
  const nodeSvgParts: string[] = [];
  for (const node of nodes) {
    const m = nodeMeta.get(node.id)!;
    const c = coords.get(node.id)!;
    let shapeSvg = '';
    if (node.shape === 'diamond') {
      const pts = [
        `${c.cx},${c.y}`,
        `${c.x + c.w},${c.cy}`,
        `${c.cx},${c.y + c.h}`,
        `${c.x},${c.cy}`,
      ].join(' ');
      shapeSvg = `<polygon points="${pts}" fill="#eff6ff" stroke="#3b82f6" stroke-width="1.5" />`;
    } else if (node.shape === 'stadium') {
      const rx = Math.round(c.h / 2);
      shapeSvg = `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${rx}" fill="#f0fdf4" stroke="#22c55e" stroke-width="1.5" />`;
    } else if (node.shape === 'round') {
      shapeSvg = `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="11" fill="#f8fafc" stroke="#64748b" stroke-width="1.45" />`;
    } else if (node.shape === 'circle') {
      const r = Math.round(Math.min(c.w, c.h) / 2);
      shapeSvg = `<circle cx="${c.cx}" cy="${c.cy}" r="${r}" fill="#eff6ff" stroke="#3b82f6" stroke-width="1.5" />`;
    } else if (node.shape === 'cylinder') {
      const ry = 7;
      const topY = c.y + ry;
      const botY = c.y + c.h - ry;
      const rx = c.w / 2;
      shapeSvg =
        `<path d="M ${c.x} ${topY} L ${c.x} ${botY} A ${rx} ${ry} 0 0 0 ${c.x + c.w} ${botY} L ${c.x + c.w} ${topY} Z" fill="#fefce8" stroke="#eab308" stroke-width="1.45" />`
        + `<ellipse cx="${c.cx}" cy="${topY}" rx="${rx}" ry="${ry}" fill="#fef9c3" stroke="#eab308" stroke-width="1.45" />`;
    } else {
      shapeSvg = `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="7" fill="#ffffff" stroke="#94a3b8" stroke-width="1.45" />`;
    }

    const textY = node.shape === 'cylinder' ? c.cy + 3 : c.cy;
    nodeSvgParts.push(
      `<g>${shapeSvg}${renderSvgLines(m.lines, c.cx, textY, 12.5, '#0f172a', 500)}</g>`,
    );
  }

  const finalWidth = Math.ceil(width);
  const finalHeight = Math.ceil(height);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${finalWidth}" height="${finalHeight}" viewBox="0 0 ${finalWidth} ${finalHeight}">`,
    `<defs>`,
    `<marker id="mm-arrow" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">`,
    `<path d="M 0 1.2 L 9 5 L 0 8.8 z" fill="#64748b" />`,
    `</marker>`,
    `</defs>`,
    `<rect width="${finalWidth}" height="${finalHeight}" rx="10" fill="#f8fafc" />`,
    ...edgeSvgParts,
    ...nodeSvgParts,
    ...edgeLabelParts,
    `</svg>`,
  ].join('');

  return {
    kind: 'flowchart',
    svg,
    width: finalWidth,
    height: finalHeight,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

function renderSvgLines(
  lines: readonly string[],
  cx: number,
  cy: number,
  fontSize: number,
  fill: string,
  fontWeight = 500,
): string {
  const lineHeight = fontSize * 1.38;
  const startY = cy - ((lines.length - 1) * lineHeight) / 2 + fontSize * 0.35;
  const tspans = lines
    .map((line, idx) => `<tspan x="${cx.toFixed(1)}" y="${(startY + idx * lineHeight).toFixed(1)}">${escapeXml(line)}</tspan>`)
    .join('');
  return `<text text-anchor="middle" fill="${fill}" font-family="-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif" font-size="${fontSize}" font-weight="${fontWeight}">${tspans}</text>`;
}

function parseSequenceDiagram(lines: readonly string[]): {
  participants: SeqParticipant[];
  items: SeqItem[];
  autonumber: boolean;
} | undefined {
  if (!/^sequenceDiagram\s*;?$/i.test(lines[0] || '')) return undefined;

  const participantMap = new Map<string, SeqParticipant>();
  const items: SeqItem[] = [];
  let autonumber = false;

  function ensureParticipant(id: string, label?: string, isActor = false) {
    const cleanId = id.trim();
    if (!cleanId) return;
    const existing = participantMap.get(cleanId);
    if (!existing) {
      if (participantMap.size < MAX_MERMAID_NODES) {
        participantMap.set(cleanId, {
          id: cleanId,
          label: cleanLabelText(label || cleanId) || cleanId,
          isActor,
        });
      }
    } else if (label) {
      participantMap.set(cleanId, {
        ...existing,
        label: cleanLabelText(label) || existing.label,
        isActor: existing.isActor || isActor,
      });
    }
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^autonumber\b/i.test(line)) {
      autonumber = true;
      continue;
    }
    if (/^(?:alt|else|opt|loop|par|and|critical|break|rect|end|activate|deactivate|title)\b/i.test(line)) {
      continue;
    }

    const partMatch = line.match(/^(participant|actor)\s+([^\s:]+?)(?:\s+as\s+(.+))?$/i);
    if (partMatch) {
      ensureParticipant(
        partMatch[2]!,
        partMatch[3],
        partMatch[1]!.toLowerCase() === 'actor',
      );
      continue;
    }

    const noteMatch = line.match(/^Note\s+(?:over|left of|right of)\s+([^:]+):\s*(.+)$/i);
    if (noteMatch) {
      const actors = noteMatch[1]!.split(',').map(s => s.trim()).filter(Boolean);
      for (const actor of actors) ensureParticipant(actor);
      if (actors.length && items.length < MAX_MERMAID_EDGES) {
        items.push({
          type: 'note',
          actors,
          label: cleanLabelText(noteMatch[2] || ''),
        });
      }
      continue;
    }

    const msgMatch = line.match(/^([^\s:-]+?)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))[+-]?\s*([^\s:]+?)\s*:\s*(.*)$/);
    if (msgMatch) {
      const from = msgMatch[1]!.trim();
      const arrow = msgMatch[2]!;
      const to = msgMatch[3]!.replace(/^[+-]+/, '').trim();
      const label = cleanLabelText(msgMatch[4] || '');
      ensureParticipant(from);
      ensureParticipant(to);
      if (participantMap.has(from) && participantMap.has(to) && items.length < MAX_MERMAID_EDGES) {
        items.push({
          type: 'message',
          from,
          to,
          label,
          dashed: arrow.startsWith('--'),
        });
      }
    }
  }

  const participants = [...participantMap.values()];
  const messageCount = items.filter(it => it.type === 'message').length;
  if (participants.length === 0 || messageCount === 0) return undefined;
  return { participants, items, autonumber };
}

function renderSequenceSvg(
  participants: readonly SeqParticipant[],
  items: readonly SeqItem[],
  autonumber: boolean,
): MermaidRenderResult {
  const PAD_X = 28;
  const PAD_Y = 22;
  const HEAD_H = 38;
  const STEP_H = 48;

  // 根据参与者名称与消息长度自适应列间距
  const boxes = participants.map(p => {
    const lines = wrapLabelLines(p.label, 16);
    const m = measureTextLines(lines, 12.5);
    return { p, lines, w: Math.max(96, m.width + 26) };
  });

  const colGap = 156;
  const centers: number[] = [];
  let cursorX = PAD_X;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    const cx = i === 0 ? cursorX + b.w / 2 : Math.max(cursorX + b.w / 2, centers[i - 1]! + colGap);
    centers.push(cx);
    cursorX = cx + b.w / 2 + 28;
  }

  const centerById = new Map<string, number>(
    participants.map((p, idx) => [p.id, centers[idx]!]),
  );

  // 确保跨列长消息有足够宽度，自调用留出右侧空间
  let extraRight = 0;
  for (const it of items) {
    if (it.type === 'message' && it.from === it.to) {
      const cx = centerById.get(it.from) || 0;
      const labelW = measureTextLines([it.label], 11.5).width + 64;
      extraRight = Math.max(extraRight, cx + labelW - cursorX);
    }
  }

  const width = Math.ceil(Math.max(240, cursorX + extraRight + PAD_X - 12));
  const topBoxY = PAD_Y;
  const lifelineStart = topBoxY + HEAD_H;
  const lifelineEnd = lifelineStart + items.length * STEP_H + 24;
  const bottomBoxY = lifelineEnd;
  const height = Math.ceil(bottomBoxY + HEAD_H + PAD_Y);

  const lifelineParts = participants.map((p, idx) => {
    const cx = centers[idx]!;
    return `<line x1="${cx}" y1="${lifelineStart}" x2="${cx}" y2="${lifelineEnd}" stroke="#cbd5e1" stroke-width="1.4" stroke-dasharray="5 4" />`;
  });

  const actorBoxParts: string[] = [];
  for (const boxY of [topBoxY, bottomBoxY]) {
    boxes.forEach((b, idx) => {
      const cx = centers[idx]!;
      const x = cx - b.w / 2;
      const fill = b.p.isActor ? '#eff6ff' : '#ffffff';
      const stroke = b.p.isActor ? '#3b82f6' : '#94a3b8';
      actorBoxParts.push(
        `<g>`
        + `<rect x="${x}" y="${boxY}" width="${b.w}" height="${HEAD_H}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.45" />`
        + renderSvgLines(b.lines, cx, boxY + HEAD_H / 2, 12.5, '#0f172a', 600)
        + `</g>`,
      );
    });
  }

  const itemParts: string[] = [];
  let stepNo = 0;
  items.forEach((it, idx) => {
    const y = lifelineStart + 28 + idx * STEP_H;
    if (it.type === 'note') {
      const xs = it.actors.map(a => centerById.get(a)).filter((v): v is number => v !== undefined);
      if (!xs.length) return;
      const minX = Math.min(...xs);
      const maxX = Math.max(...xs);
      const lines = wrapLabelLines(it.label, 28);
      const m = measureTextLines(lines, 11.5);
      const nw = Math.max(maxX - minX + 76, m.width + 24);
      const nh = Math.max(28, m.height + 10);
      const nx = (minX + maxX) / 2 - nw / 2;
      itemParts.push(
        `<g>`
        + `<rect x="${nx.toFixed(1)}" y="${(y - nh / 2).toFixed(1)}" width="${nw}" height="${nh}" rx="6" fill="#fefce8" stroke="#eab308" stroke-width="1.2" />`
        + renderSvgLines(lines, nx + nw / 2, y, 11.5, '#713f12', 500)
        + `</g>`,
      );
      return;
    }

    stepNo++;
    const sx = centerById.get(it.from) ?? PAD_X;
    const tx = centerById.get(it.to) ?? PAD_X;
    const dashAttr = it.dashed ? ' stroke-dasharray="5 4"' : '';
    const displayLabel = autonumber ? `${stepNo}. ${it.label}` : it.label;

    if (it.from === it.to) {
      const loopW = 36;
      const loopH = 18;
      itemParts.push(
        `<path d="M ${sx} ${y - 6} L ${sx + loopW} ${y - 6} L ${sx + loopW} ${y + loopH - 6} L ${sx + 4} ${y + loopH - 6}" fill="none" stroke="#475569" stroke-width="1.6"${dashAttr} marker-end="url(#mm-seq-arrow)" />`,
      );
      if (displayLabel) {
        itemParts.push(
          `<text x="${sx + loopW + 8}" y="${y + 6}" fill="#1e293b" font-family="-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif" font-size="11.5" font-weight="500">${escapeXml(displayLabel)}</text>`,
        );
      }
    } else {
      const dir = tx > sx ? 1 : -1;
      const endX = tx - dir * 3;
      itemParts.push(
        `<line x1="${sx}" y1="${y}" x2="${endX}" y2="${y}" stroke="#475569" stroke-width="1.65"${dashAttr} marker-end="url(#mm-seq-arrow)" />`,
      );
      if (displayLabel) {
        const midX = (sx + tx) / 2;
        itemParts.push(
          `<text x="${midX.toFixed(1)}" y="${(y - 7).toFixed(1)}" text-anchor="middle" fill="#1e293b" font-family="-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif" font-size="11.5" font-weight="500">${escapeXml(displayLabel)}</text>`,
        );
      }
    }
  });

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs>`,
    `<marker id="mm-seq-arrow" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">`,
    `<path d="M 0 1.2 L 9 5 L 0 8.8 z" fill="#475569" />`,
    `</marker>`,
    `</defs>`,
    `<rect width="${width}" height="${height}" rx="10" fill="#f8fafc" />`,
    ...lifelineParts,
    ...itemParts,
    ...actorBoxParts,
    `</svg>`,
  ].join('');

  return {
    kind: 'sequence',
    svg,
    width,
    height,
    nodeCount: participants.length,
    edgeCount: items.filter(it => it.type === 'message').length,
  };
}

export function renderMermaidLiteSvg(source: string): MermaidRenderResult | undefined {
  if (!source || source.length > MAX_MERMAID_CHARS) return undefined;
  const lines = stripMermaidComments(source);
  if (lines.length < 2) return undefined;

  const flow = parseFlowchart(lines);
  if (flow) {
    return renderFlowchartSvg(flow.direction, flow.nodes, flow.edges);
  }

  const seq = parseSequenceDiagram(lines);
  if (seq) {
    return renderSequenceSvg(seq.participants, seq.items, seq.autonumber);
  }

  return undefined;
}

export function canRenderMermaidLite(language: string | undefined, source: string): boolean {
  const lang = (language || '').trim().toLowerCase();
  if (lang !== 'mermaid') return false;
  return renderMermaidLiteSvg(source) !== undefined;
}
