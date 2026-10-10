import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { sourceDataRoot } from "./config.mjs";
import path from "node:path";

const runtimeRoot = sourceDataRoot;
export const CATCHUP_CLI_LEDGER_FILE = path.join(runtimeRoot, "catchup-cli-dispatcher-ledger.json");
export const CATCHUP_CLI_LOCK_FILE = path.join(runtimeRoot, "catchup-cli-dispatcher.lock");

export class CatchupCliDispatcherError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CatchupCliDispatcherError";
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message) {
  throw new CatchupCliDispatcherError(code, message);
}

function emptyLedger() {
  return { version: 1, updatedAt: "", runs: {} };
}

function processIsAlive(pid, signalProcess = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    signalProcess(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validLedger(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && value.runs && typeof value.runs === "object" && !Array.isArray(value.runs);
}

export class AtomicCatchupCliLedger {
  constructor(filename = CATCHUP_CLI_LEDGER_FILE, { fsApi = fs } = {}) {
    this.filename = filename;
    this.fs = fsApi;
    this.mutation = Promise.resolve();
  }

  async read() {
    try {
      const value = JSON.parse(await this.fs.readFile(this.filename, "utf8"));
      if (!validLedger(value)) fail("CATCHUP_CLI_LEDGER_UNAVAILABLE", "追平 CLI 运行账本不可用");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return emptyLedger();
      if (error.code === "CATCHUP_CLI_LEDGER_UNAVAILABLE") throw error;
      fail("CATCHUP_CLI_LEDGER_UNAVAILABLE", "追平 CLI 运行账本不可用");
    }
  }

  mutate(updater) {
    const operation = this.mutation.then(async () => {
      const ledger = await this.read();
      await updater(ledger);
      ledger.updatedAt = new Date().toISOString();
      await this.fs.mkdir(path.dirname(this.filename), { recursive: true });
      const temporaryFile = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
      await this.fs.writeFile(temporaryFile, JSON.stringify(ledger, null, 2), {
        encoding: "utf8",
        mode: 0o600
      });
      await this.fs.rename(temporaryFile, this.filename);
      return ledger;
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }

  set(runId, run) {
    return this.mutate((ledger) => { ledger.runs[runId] = run; });
  }

  patch(runId, patch) {
    return this.mutate((ledger) => {
      if (!ledger.runs[runId]) fail("CATCHUP_CLI_RUN_NOT_FOUND", "追平 CLI 运行记录不存在");
      Object.assign(ledger.runs[runId], patch);
    });
  }

  remove(runId) {
    return this.mutate((ledger) => { delete ledger.runs[runId]; });
  }

  async assertNoOrphans() {
    if (Object.keys((await this.read()).runs).length) {
      fail("CATCHUP_CLI_ORPHANED_RUN", "存在未人工核对的追平 CLI 孤儿运行，拒绝自动重启");
    }
  }
}

export async function acquireCatchupCliLock(
  filename = CATCHUP_CLI_LOCK_FILE,
  { fsApi = fs, pid = process.pid, signalProcess = process.kill } = {}
) {
  await fsApi.mkdir(path.dirname(filename), { recursive: true });
  let handle;
  try {
    handle = await fsApi.open(filename, "wx", 0o600);
    await handle.writeFile(JSON.stringify({ pid, startedAt: new Date().toISOString() }), "utf8");
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code === "EEXIST") {
      let lockedPid = 0;
      try {
        lockedPid = Number(JSON.parse(await fsApi.readFile(filename, "utf8"))?.pid) || 0;
      } catch {
        fail("CATCHUP_CLI_ALREADY_RUNNING", "追平 CLI 调度器锁文件无法安全核验");
      }
      if (processIsAlive(lockedPid, signalProcess)) {
        fail("CATCHUP_CLI_ALREADY_RUNNING", "追平 CLI 调度器已有实例或遗留锁");
      }
      await fsApi.unlink(filename);
      try {
        handle = await fsApi.open(filename, "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid, startedAt: new Date().toISOString() }), "utf8");
      } catch (retryError) {
        await handle?.close().catch(() => {});
        if (retryError.code === "EEXIST") {
          fail("CATCHUP_CLI_ALREADY_RUNNING", "追平 CLI 调度器已有实例或遗留锁");
        }
        throw retryError;
      }
    } else {
      throw error;
    }
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await handle.close();
    await fsApi.unlink(filename).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
}
