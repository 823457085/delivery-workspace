import type { ExecFileOptions } from 'node:child_process';

export class CursorDesktopError extends Error {}
export function openCursorEditor(args: string[], options?: {
  executeFile?: (file: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string }>;
}): Promise<void>;
