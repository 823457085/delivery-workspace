/**
 * 自动化状态安全持久化存储（修复 P1-7、P1-20 与第七节 #10）：
 * 1. 仅在文件首次不存在（`ENOENT`）时回落空白默认状态；
 * 2. 若状态文件损坏或 I/O 异常，优先尝试从 `.bak` 备份恢复并将损坏原文件隔离为 `.corrupt-<ts>.json`；
 *    若无有效备份则在写路径抛出明确错误，严禁静默覆盖历史 `jobs` / `plan` / `runs`；
 * 3. 写入统一采用 `0600` 权限、先留存 `.bak` 副本、`fileHandle.sync()` 刷盘后原子 `rename`。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export function createAutomationStateStore(
  stateFilePath,
  { makeDefaultState, normalizeLoadedState },
) {
  const backupFilePath = `${stateFilePath}.bak`;

  async function writeFileAtomic0600(targetPath, text) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fs.open(tmpPath, 'w', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(tmpPath, 0o600).catch(() => {});
    await fs.rename(tmpPath, targetPath);
  }

  async function readState({ forWrite = false } = {}) {
    let primaryError = null;
    try {
      const raw = await fs.readFile(stateFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('自动化状态文件顶层不是 JSON 对象');
      }
      return normalizeLoadedState(parsed);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        // 主文件不存在时尝试 .bak，若仍不存在说明是全新初始化
        try {
          const bakRaw = await fs.readFile(backupFilePath, 'utf8');
          const bakParsed = JSON.parse(bakRaw);
          if (bakParsed && typeof bakParsed === 'object' && !Array.isArray(bakParsed)) {
            return normalizeLoadedState(bakParsed);
          }
        } catch (bakErr) {
          if (bakErr && bakErr.code === 'ENOENT') {
            return makeDefaultState();
          }
        }
        return makeDefaultState();
      }
      primaryError = error;
    }

    // 主文件存在但读取或 JSON 解析失败：尝试从 .bak 恢复，并隔离保留原损坏文件
    try {
      const bakRaw = await fs.readFile(backupFilePath, 'utf8');
      const bakParsed = JSON.parse(bakRaw);
      if (bakParsed && typeof bakParsed === 'object' && !Array.isArray(bakParsed)) {
        const corruptPath = `${stateFilePath}.corrupt-${Date.now()}.json`;
        await fs.copyFile(stateFilePath, corruptPath).catch(() => {});
        await fs.chmod(corruptPath, 0o600).catch(() => {});
        return normalizeLoadedState(bakParsed);
      }
    } catch {
      /* .bak 不可用时进入下方保护分支 */
    }

    const reason = primaryError instanceof Error ? primaryError.message : String(primaryError);
    if (forWrite) {
      throw new Error(`自动化状态文件读取失败（${reason}），已拒绝覆盖原文件以保护历史任务数据`);
    }
    return {
      ...makeDefaultState(),
      stateReadError: `自动化状态文件读取失败（${reason}），当前为内存降级只读视图，未覆盖原磁盘文件`,
    };
  }

  async function writeState(state) {
    const cleanState = { ...state };
    delete cleanState.stateReadError;
    const serialized = JSON.stringify(cleanState, null, 2);

    // 若磁盘上已有可正常解析的主文件，先同步一份 0600 .bak 备份
    try {
      const existingRaw = await fs.readFile(stateFilePath, 'utf8');
      JSON.parse(existingRaw);
      await writeFileAtomic0600(backupFilePath, existingRaw);
    } catch {
      /* 原文件不存在或已损坏时不覆盖有效 .bak */
    }

    await writeFileAtomic0600(stateFilePath, serialized);
  }

  return {
    stateFilePath,
    backupFilePath,
    readState,
    writeState,
  };
}
