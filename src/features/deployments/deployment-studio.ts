export type DeployLogLevel = 'error' | 'warn' | 'success' | 'info';

export interface StructuredLogLine {
  lineNumber: number;
  text: string;
  level: DeployLogLevel;
}

export interface ParsedDeploymentLog {
  totalLines: number;
  errorCount: number;
  warnCount: number;
  lines: StructuredLogLine[];
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;

const LOG_ERROR_RE = /(\bERROR\b|\bFATAL\b|\bFAIL(?:ED|URE)?\b|\bException\b|ERR!|exit code [1-9]|构建失败|部署失败)/i;
const LOG_WARN_RE = /(\bWARN(?:ING)?\b|\bDEPRECATED\b|告警|注意)/i;
const LOG_SUCCESS_RE = /(\bFinished:\s*SUCCESS\b|\bBUILD SUCCESS\b|\bSUCCESSFULLY\b|部署成功|构建成功)/i;

export function stripAnsiCodes(input: string): string {
  return (input || '').replace(ANSI_ESCAPE_RE, '');
}

export function detectDeployLogLevel(line: string): DeployLogLevel {
  if (LOG_ERROR_RE.test(line)) return 'error';
  if (LOG_WARN_RE.test(line)) return 'warn';
  if (LOG_SUCCESS_RE.test(line)) return 'success';
  return 'info';
}

/**
 * Parses raw Jenkins / Yunxiao log output into ANSI-clean, line-numbered entries (zero v-html)
 * with instant keyword and error/warning filtering.
 */
export function parseStructuredLogLines(
  raw: string,
  options: { keyword?: string; levelFilter?: 'all' | 'issues' } = {},
): ParsedDeploymentLog {
  const cleaned = stripAnsiCodes(raw || '').replace(/\r\n/g, '\n');
  if (!cleaned.trim()) {
    return { totalLines: 0, errorCount: 0, warnCount: 0, lines: [] };
  }
  const rawLines = cleaned.split('\n');
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }
  const needle = (options.keyword || '').trim().toLowerCase();
  const issuesOnly = options.levelFilter === 'issues';

  let errorCount = 0;
  let warnCount = 0;
  const lines: StructuredLogLine[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const text = rawLines[i]!;
    const level = detectDeployLogLevel(text);
    if (level === 'error') errorCount++;
    else if (level === 'warn') warnCount++;

    if (issuesOnly && level !== 'error' && level !== 'warn') continue;
    if (needle && !text.toLowerCase().includes(needle)) continue;

    lines.push({
      lineNumber: i + 1,
      text,
      level,
    });
  }

  return {
    totalLines: rawLines.length,
    errorCount,
    warnCount,
    lines,
  };
}
