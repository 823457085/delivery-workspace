/** Verify resumed turns against immutable prior evidence, never against the presence of a reply alone.
 * Native JSON can omit error steps; the session SQLite trajectory supplies those missing steps.
 * Both sources stay read-only, and only exact old errors plus a fully completed current turn allow recovery.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Step = Record<string, unknown>;
type NativeStep = { idx: number; step_type: number; status: number; error_details: Uint8Array | null; step_payload: Uint8Array | null };
type NativeBaseline = { file: string; sessionId: string; trajectoryId: string; hash: string };
export type AntigravityTurnBaseline = {
  file: string; bytes: number; hash: string; stepCount: number; rowCount: number;
  error: string; errors?: string[]; native?: NativeBaseline;
};
export type AntigravityStreamStep = { type: string; state: string; failed: boolean };
const maxTranscriptBytes = 32 * 1024 * 1024;
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function transcript(file: string) {
  if (!(await fs.lstat(file)).isFile()) return;
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxTranscriptBytes) return;
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < data.length) {
      const read = await handle.read(data, size, data.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size) return;
    const bytes = data.subarray(0, size);
    if (!bytes.length || bytes.at(-1) !== 10) return;
    const steps: Step[] = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    // Native exports omit some historical rows, including ERROR_MESSAGE. Preserve their real indices.
    let previous = -1;
    for (const step of steps) {
      if (!step || Array.isArray(step) || !Number.isSafeInteger(step.step_index) || Number(step.step_index) <= previous) return;
      previous = Number(step.step_index);
    }
    return { bytes, steps };
  } finally { await handle.close(); }
}

// Read only the protobuf fields used by the official error message. Skip all other fields,
// especially diagnostic HTTP headers; never decode or publish the complete native payload.
function messageField(bytes: Uint8Array, field: number): Uint8Array | undefined {
  let offset = 0;
  const integer = () => {
    let value = 0, factor = 1;
    for (let count = 0; count < 10 && offset < bytes.length; count++) {
      const byte = bytes[offset++]!; value += (byte & 127) * factor;
      if (!Number.isSafeInteger(value)) throw new Error('Invalid protobuf integer');
      if (!(byte & 128)) return value;
      factor *= 128;
    }
    throw new Error('Incomplete protobuf integer');
  };
  while (offset < bytes.length) {
    const tag = integer(), wire = tag & 7, number = Math.floor(tag / 8);
    if (number < 1) throw new Error('Invalid protobuf field');
    if (wire === 0) { integer(); continue; }
    if (wire === 1 || wire === 5) { offset += wire === 1 ? 8 : 4; }
    else if (wire === 2) {
      const length = integer(), start = offset; offset += length;
      if (offset > bytes.length) throw new Error('Incomplete protobuf field');
      if (number === field) return bytes.subarray(start, offset);
    } else throw new Error('Unsupported protobuf wire type');
    if (offset > bytes.length) throw new Error('Incomplete protobuf field');
  }
}

function nativeErrors(payload: Uint8Array | null) {
  if (!payload) return [];
  const error = messageField(payload, 24);
  const details = error && messageField(error, 3);
  if (!details) return [];
  return [1, 2].map(field => {
    const bytes = messageField(details, field);
    return bytes && bytes.length <= 64_000 ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : '';
  }).filter((text): text is string => !!text?.trim());
}

function nativeHash(rows: NativeStep[]) {
  const digest = createHash('sha256');
  for (const row of rows) {
    digest.update(JSON.stringify([row.idx, row.step_type, row.status, row.error_details?.length || 0, row.step_payload?.length || 0]));
    if (row.error_details) digest.update(row.error_details);
    if (row.step_payload) digest.update(row.step_payload);
  }
  return digest.digest('hex');
}

async function nativeSnapshot(file: string, sessionId: string) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxTranscriptBytes) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('BEGIN');
    const meta = db.prepare('SELECT trajectory_id, cascade_id FROM trajectory_meta LIMIT 2').all();
    if (meta.length !== 1 || meta[0]?.cascade_id !== sessionId || typeof meta[0]?.trajectory_id !== 'string') return;
    const rows = db.prepare('SELECT idx, step_type, status, error_details, step_payload FROM steps ORDER BY idx LIMIT 100001').all() as unknown as NativeStep[];
    if (!rows.length || rows.length > 100_000 || rows.some((row, index) => row.idx !== index
      || !Number.isSafeInteger(row.step_type) || !Number.isSafeInteger(row.status)
      || row.error_details !== null && !(row.error_details instanceof Uint8Array)
      || row.step_payload !== null && !(row.step_payload instanceof Uint8Array))) return;
    const after = await fs.lstat(file);
    if (after.dev !== stat.dev || after.ino !== stat.ino || !after.isFile()) return;
    return { rows, trajectoryId: meta[0].trajectory_id };
  } finally { db.close(); }
}

/** Snapshot only existing native evidence; no CLI invocation, transcript edits, or model requests. */
export async function antigravityTurnBaseline(root: string, sessionId: string): Promise<AntigravityTurnBaseline | undefined> {
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(sessionId)) return;
  const file = path.join(root, sessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
  try {
    const before = await transcript(file);
    if (!before?.steps.length) return;
    const nativeFile = path.join(path.dirname(root), 'conversations', `${sessionId}.db`);
    let native: NativeBaseline | undefined, stepCount = Number(before.steps.at(-1)!.step_index) + 1;
    let errors: string[] = [];
    try {
      const snapshot = await nativeSnapshot(nativeFile, sessionId);
      // A present but unverifiable native database cannot authorize a transcript-only recovery.
      if (!snapshot || Number(before.steps.at(-1)!.step_index) >= snapshot.rows.length) return;
      const previousError = snapshot.rows.slice().reverse().find(step => step.step_type === 17);
      errors = previousError ? nativeErrors(previousError.step_payload) : [];
      stepCount = snapshot.rows.length;
      native = { file: nativeFile, sessionId, trajectoryId: snapshot.trajectoryId, hash: nativeHash(snapshot.rows) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    if (!native) {
      const error = before.steps.slice().reverse().find(step => step.type === 'ERROR_MESSAGE')?.error;
      if (typeof error === 'string' && error.trim()) errors = [error];
    }
    if (!errors.length) return;
    return { file, bytes: before.bytes.length, hash: hash(before.bytes), stepCount, rowCount: before.steps.length,
      error: errors[0]!, errors: [...new Set(errors)], ...(native ? { native } : {}) };
  } catch { return; }
}

/** Only a matching prior error can be ignored, after both native sources prove this turn completed. */
export async function confirmsAntigravityHistoricalError(baseline: AntigravityTurnBaseline, input: {
  error: unknown; response: string; prompt: string; steps: Map<number, AntigravityStreamStep>;
  lastResponse: { index: number; text: string; done: boolean } | undefined;
  responses: Map<number, { text: string; done: boolean }>;
}) {
  if (typeof input.error !== 'string' || !(baseline.errors || [baseline.error]).includes(input.error) || !input.response.trim()) return false;
  const first = input.steps.get(baseline.stepCount), last = input.lastResponse;
  let end = -1;
  for (const index of input.steps.keys()) end = Math.max(end, index);
  if (first?.type !== 'user_input' || !last?.done || !last.text.trim() || input.steps.size < 2
    || end !== baseline.stepCount + input.steps.size - 1) return false;
  for (let index = baseline.stepCount; index <= end; index++) {
    const step = input.steps.get(index);
    if (!step || step.state !== 'DONE' || step.failed || step.type === 'error_message'
      || (index > baseline.stepCount && step.type === 'user_input')) return false;
    if (index > last.index && step.type !== 'system_message') return false;
  }
  if (input.steps.get(last.index)?.type !== 'agent_response') return false;
  try {
    const after = await transcript(baseline.file);
    if (!after || hash(after.bytes.subarray(0, baseline.bytes)) !== baseline.hash) return false;
    const current = after.steps.slice(baseline.rowCount);
    if (current.length !== input.steps.size || current.some((step, index) => step.step_index !== baseline.stepCount + index
      || step.status !== 'DONE' || step.type === 'ERROR_MESSAGE' || !!step.error)) return false;
    if (current[0]?.type !== 'USER_INPUT' || current.slice(1).some(step => step.type === 'USER_INPUT')) return false;
    if (typeof current[0].content !== 'string'
      || !current[0].content.startsWith(`<USER_REQUEST>\n${input.prompt}\n</USER_REQUEST>`)) return false;
    const tail = current.filter(step => Number(step.step_index) > last.index);
    if (tail.some(step => step.type !== 'SYSTEM_MESSAGE')) return false;
    if (baseline.native) {
      const snapshot = await nativeSnapshot(baseline.native.file, baseline.native.sessionId);
      if (!snapshot || snapshot.trajectoryId !== baseline.native.trajectoryId || snapshot.rows.length !== end + 1
        || nativeHash(snapshot.rows.slice(0, baseline.stepCount)) !== baseline.native.hash) return false;
      const nativeCurrent = snapshot.rows.slice(baseline.stepCount);
      if (nativeCurrent.some(step => step.status !== 3 || step.step_type === 17 || !!step.error_details?.length)
        || nativeCurrent[0]?.step_type !== 14 || nativeCurrent.slice(1).some(step => step.step_type === 14)) return false;
      if (snapshot.rows[last.index]?.step_type !== 15 || nativeCurrent.some(step => step.idx > last.index && step.step_type !== 101)) return false;
    }
    const final = current.find(step => step.step_index === last.index);
    if (final?.type !== 'PLANNER_RESPONSE' || typeof final.content !== 'string' || !final.content.trim()) return false;
    const expected = input.response.trim();
    if (last.text.trim() === expected && final.content.trim() === expected) return true;
    const streamed = [...input.responses.entries()].sort(([left], [right]) => left - right);
    const native = current.filter(step => step.type === 'PLANNER_RESPONSE' && typeof step.content === 'string' && step.content.trim());
    const publicStream = streamed.filter(([, response]) => response.text.trim());
    if (publicStream.length !== native.length || publicStream.some(([index, response], position) => !response.done
      || native[position]?.step_index !== index || response.text.trim() !== String(native[position]?.content).trim())) return false;
    return publicStream.map(([, response]) => response.text).join('').trim() === expected
      && native.map(step => step.content).join('\n').trim() === expected;
  } catch { return false; }
}
