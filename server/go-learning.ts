import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  GoCommandAction,
  GoCommandRunResult,
  GoDayDetail,
  GoEnvironmentStatus,
  GoHttpDebugResult,
  GoLearningOverview,
  GoLearningProgress,
  GoSandboxFile,
} from '../shared/go-learning.js';
import {
  GO_DAYS_META,
  GO_SANDBOX_SNAPSHOTS,
  readGoDayDetail,
  readGoGuideAndCheatSheet,
} from './go-learning-curriculum.js';

const execFileAsync = promisify(execFile);
const goPath = [...new Set([...(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin',
  '/usr/local/go/bin', '/usr/local/bin', path.join(os.homedir(), 'go', 'bin')].filter(directory => path.isAbsolute(directory)))];
const taskManagerOrigin = 'http://127.0.0.1:8080';

const CANDIDATE_GO_PATHS = [
  '/opt/homebrew/bin/go',
  '/usr/local/go/bin/go',
  '/usr/local/bin/go',
  path.join(os.homedir(), 'go', 'bin', 'go'),
  path.join(os.homedir(), 'sdk', 'go', 'bin', 'go'),
];

async function findGoBinary(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', ['go'], {
      env: { PATH: goPath.join(path.delimiter) },
      timeout: 3000,
    });
    const resolved = stdout.trim();
    if (resolved) return resolved;
  } catch {
    // Fallback to checking candidate locations directly
  }

  for (const candidate of CANDIDATE_GO_PATHS) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Ignore missing binary
    }
  }
  return null;
}

async function isTaskManagerListening() {
  try {
    const response = await fetch(`${taskManagerOrigin}/__go-learning/health`, {
      redirect: 'error', signal: AbortSignal.timeout(600),
    });
    await response.body?.cancel();
    return response.status === 204 && response.headers.get('x-delivery-go-learning') === 'taskmgr';
  } catch {
    return false;
  }
}

function runGoProcess(binary: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; httpPreview: boolean }) {
  return new Promise<{ exitCode: number; stdout: string; stderr: string; httpStarted: boolean }>(resolve => {
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, shell: false,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure = '', httpStarted = false;
    let preview: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch { /* The process already exited. */ }
    };
    const timeout = setTimeout(() => { failure = 'Go 命令运行超时'; stop(); }, 45_000);
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout += text;
      if (stdout.length > 1_048_576) { stdout = stdout.slice(0, 1_048_576); failure = 'Go 命令输出超过限制'; stop(); }
      if (options.httpPreview && !preview && stdout.includes('TaskMgr HTTP 服务已启动')) {
        preview = setTimeout(() => { httpStarted = true; stop(); }, 1000);
      }
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr += text;
      if (stderr.length > 1_048_576) { stderr = stderr.slice(0, 1_048_576); failure = 'Go 命令输出超过限制'; stop(); }
    });
    child.on('error', error => { failure = error.message; });
    child.on('exit', stop);
    child.on('close', code => {
      clearTimeout(timeout);
      clearTimeout(preview);
      resolve({ exitCode: failure ? 1 : httpStarted ? 0 : code ?? 1, stdout: stdout.trimEnd(),
        stderr: [stderr.trimEnd(), failure].filter(Boolean).join('\n'), httpStarted });
    });
  });
}

export async function createGoLearningService(
  stateDir: string,
  options: { rootDir: string; writeJson?: (filePath: string, data: unknown) => Promise<void> }
) {
  await fs.mkdir(stateDir, { recursive: true });
  const progressFile = path.join(stateDir, 'progress.json');
  const root = await fs.realpath(options.rootDir);
  const sandboxParent = path.join(root, 'work');
  const sandboxPath = path.join(sandboxParent, 'go-taskmgr-lab');
  const docsPath = path.join(options.rootDir, 'work', 'go-learning-docs');
  const toolchainHome = path.join(await fs.realpath(stateDir), 'toolchain');
  await fs.mkdir(toolchainHome, { recursive: true, mode: 0o700 });
  const toolchainEnv = (goBinary: string): NodeJS.ProcessEnv => ({
    PATH: [...new Set([path.dirname(goBinary), ...goPath])].join(path.delimiter),
    HOME: toolchainHome,
    USERPROFILE: toolchainHome,
    GOCACHE: path.join(toolchainHome, 'cache'),
    GOMODCACHE: path.join(toolchainHome, 'modules'),
    GOENV: 'off', GOWORK: 'off', GOTOOLCHAIN: 'local', GOPROXY: 'off',
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  });

  let progress: GoLearningProgress = {
    currentDay: 1,
    activeSnapshot: 'day1',
    checkedItems: [],
    completedExercises: [],
    notes: {},
    updatedAt: new Date().toISOString(),
  };

  try {
    const raw = JSON.parse(await fs.readFile(progressFile, 'utf8'));
    if (raw && typeof raw === 'object') {
      progress = {
        currentDay: typeof raw.currentDay === 'number' && raw.currentDay >= 1 && raw.currentDay <= 7 ? raw.currentDay : 1,
        activeSnapshot: typeof raw.activeSnapshot === 'string' && raw.activeSnapshot in GO_SANDBOX_SNAPSHOTS ? raw.activeSnapshot : 'day1',
        checkedItems: Array.isArray(raw.checkedItems) ? raw.checkedItems.filter((x: unknown): x is string => typeof x === 'string') : [],
        completedExercises: Array.isArray(raw.completedExercises) ? raw.completedExercises.filter((x: unknown): x is string => typeof x === 'string') : [],
        notes: raw.notes && typeof raw.notes === 'object' ? raw.notes : {},
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      };
    }
  } catch {
    // Initialize default progress on first run
  }

  async function sandboxDirectory(subdirectory = '') {
    const directories = [sandboxParent, sandboxPath];
    if (subdirectory) directories.push(path.join(sandboxPath, subdirectory));
    for (const directory of directories) {
      await fs.mkdir(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      if (!(await fs.lstat(directory)).isDirectory()) throw new Error('沙盒路径必须是普通目录');
    }
    return directories.at(-1)!;
  }

  async function sandboxFile(relativePath: string) {
    const folder = path.posix.dirname(relativePath);
    const directory = await sandboxDirectory(folder === '.' ? '' : folder);
    const file = path.join(directory, path.posix.basename(relativePath));
    const stat = await fs.lstat(file).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
    if (stat && !stat.isFile()) throw new Error('沙盒只允许访问普通文件');
    return file;
  }

  let progressWrite = Promise.resolve();
  function saveProgress() {
    progress.updatedAt = new Date().toISOString();
    const contents = JSON.stringify(progress, null, 2);
    progressWrite = progressWrite.catch(() => {}).then(async () => {
      const tmpFile = `${progressFile}.tmp`;
      await fs.writeFile(tmpFile, contents, 'utf8');
      await fs.rename(tmpFile, progressFile);
    });
    return progressWrite;
  }

  async function applySnapshot(snapshotKey: string) {
    const files = GO_SANDBOX_SNAPSHOTS[snapshotKey] || GO_SANDBOX_SNAPSHOTS.day1!;
    await sandboxDirectory();

    // Clean existing .go files in root, task/, server/ so switching from Day 6 back to Day 1 doesn't leave stale packages
    for (const sub of ['', 'task', 'server']) {
      try {
        const targetDir = await sandboxDirectory(sub);
        const entries = await fs.readdir(targetDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isFile() && (entry.name.endsWith('.go') || entry.name === 'go.mod')) {
            await fs.unlink(path.join(targetDir, entry.name));
          }
        }
      } catch {
        // Directory may not exist yet
      }
    }

    for (const [relPath, content] of Object.entries(files)) {
      const absPath = await sandboxFile(relPath);
      await fs.writeFile(absPath, content, 'utf8');
    }

    const pkgJsonPath = await sandboxFile('package.json');
    await fs.writeFile(
      pkgJsonPath,
      JSON.stringify(
        {
          name: 'go-taskmgr-lab',
          version: '1.0.0',
          private: true,
          description: 'Delivery Workspace - Go 实训工坊沙盒工程 (example.com/taskmgr)',
          scripts: {
            dev: 'PORT=8080 go run .',
            start: 'PORT=8080 go run .',
            build: 'go build -o taskmgr .',
            test: 'go test -v ./...',
          },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    progress.activeSnapshot = snapshotKey;
    await saveProgress();
  }

  // Ensure sandbox is initialized at least once
  try {
    await fs.access(path.join(sandboxPath, 'go.mod'));
    await fs.access(path.join(sandboxPath, 'package.json'));
  } catch {
    await applySnapshot(progress.activeSnapshot);
  }

  async function readSandboxFiles(): Promise<{ files: GoSandboxFile[]; tasksJsonContent: string | null }> {
    await sandboxDirectory();
    const result: GoSandboxFile[] = [];

    async function walk(relDir: string) {
      const absDir = relDir ? path.join(sandboxPath, relDir) : sandboxPath;
      let entries;
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
        const absPath = path.join(sandboxPath, relPath);
        if (entry.isDirectory()) {
          if (['task', 'server'].includes(entry.name)) {
            await walk(relPath);
          }
        } else if (entry.isFile() && (entry.name.endsWith('.go') || entry.name === 'go.mod' || entry.name === 'tasks.json')) {
          try {
            const [stat, content] = await Promise.all([fs.stat(absPath), fs.readFile(absPath, 'utf8')]);
            result.push({
              path: relPath,
              content,
              size: stat.size,
              updatedAt: stat.mtime.toISOString(),
            });
          } catch {
            // Ignore unreadable file
          }
        }
      }
    }

    await walk('');
    result.sort((a, b) => {
      const order = (p: string) => (p === 'main.go' ? 0 : p === 'go.mod' ? 1 : p.startsWith('task/') ? 2 : p.startsWith('server/') ? 3 : 4);
      return order(a.path) - order(b.path) || a.path.localeCompare(b.path);
    });

    const tasksJson = result.find(f => f.path === 'tasks.json')?.content ?? null;
    return { files: result, tasksJsonContent: tasksJson };
  }

  async function detectEnvironment(): Promise<GoEnvironmentStatus> {
    const [goBinary, port8080Listening] = await Promise.all([
      findGoBinary(),
      isTaskManagerListening(),
    ]);

    if (!goBinary) {
      return {
        installed: false,
        version: '未检测到本机 Go 工具链',
        goBinaryPath: '',
        goproxy: '未检测',
        cgoEnabled: '未检测',
        installHint: 'macOS 推荐在终端执行 `brew install go`，或前往 https://go.dev/dl/ 下载安装包。未安装前本工坊已为您开启「预期输出模拟与沙盒演练模式」！',
        port8080Listening,
      };
    }

    const env = toolchainEnv(goBinary);

    try {
      const [verRes, envRes] = await Promise.all([
        execFileAsync(goBinary, ['version'], { env, timeout: 4000 }),
        execFileAsync(goBinary, ['env', 'GOPROXY', 'CGO_ENABLED'], { env, timeout: 4000 }),
      ]);
      const envLines = envRes.stdout.trim().split('\n');
      return {
        installed: true,
        version: verRes.stdout.trim(),
        goBinaryPath: goBinary,
        goproxy: envLines[0]?.trim() || 'default',
        cgoEnabled: envLines[1]?.trim() || '1',
        installHint: '本机 Go 工具链已就绪，点击右侧运行按钮将直接调用真实编译器与测试器。',
        port8080Listening,
      };
    } catch (error) {
      return {
        installed: false,
        version: error instanceof Error ? error.message : 'Go 环境检测异常',
        goBinaryPath: goBinary,
        goproxy: '',
        cgoEnabled: '',
        installHint: '请检查本机 Go 安装权限。',
        port8080Listening,
      };
    }
  }

  async function overview(dayOverride?: number): Promise<GoLearningOverview> {
    const currentDay = dayOverride && dayOverride >= 1 && dayOverride <= 7 ? dayOverride : progress.currentDay;

    const [environment, currentDayDetail, sandbox, guideAndCheat] = await Promise.all([
      detectEnvironment(),
      readGoDayDetail(docsPath, currentDay),
      readSandboxFiles(),
      readGoGuideAndCheatSheet(docsPath),
    ]);

    const days = GO_DAYS_META.map(({ docFile: _doc, expectedRunOutput: _out, ...summary }) => summary);

    return {
      environment,
      sandboxPath,
      docsPath,
      progress: structuredClone({ ...progress, currentDay }),
      days,
      currentDayDetail,
      sandboxFiles: sandbox.files,
      tasksJsonContent: sandbox.tasksJsonContent,
      guideMarkdown: guideAndCheat.guideMarkdown,
      cheatSheetMarkdown: guideAndCheat.cheatSheetMarkdown,
    };
  }

  async function getDay(dayNumber: number): Promise<{
    dayDetail: GoDayDetail;
    progress: GoLearningProgress;
  }> {
    const clamped = Math.max(1, Math.min(7, dayNumber));
    const dayDetail = await readGoDayDetail(docsPath, clamped);
    return { dayDetail, progress: structuredClone({ ...progress, currentDay: clamped }) };
  }

  async function updateProgress(input: {
    currentDay?: number;
    toggleChecklistId?: string;
    toggleExerciseId?: string;
    note?: { day: number; content: string };
  }): Promise<GoLearningProgress> {
    if (input.currentDay !== undefined) {
      progress.currentDay = Math.max(1, Math.min(7, input.currentDay));
    }
    if (input.toggleChecklistId) {
      const id = input.toggleChecklistId;
      const idx = progress.checkedItems.indexOf(id);
      if (idx >= 0) progress.checkedItems.splice(idx, 1);
      else progress.checkedItems.push(id);
    }
    if (input.toggleExerciseId) {
      const id = input.toggleExerciseId;
      const idx = progress.completedExercises.indexOf(id);
      if (idx >= 0) progress.completedExercises.splice(idx, 1);
      else progress.completedExercises.push(id);
    }
    if (input.note) {
      progress.notes[String(input.note.day)] = input.note.content;
    }
    await saveProgress();
    return structuredClone(progress);
  }

  async function saveSandboxFile(relFilePath: string, content: string) {
    const normalized = path.posix.normalize(relFilePath.replace(/\\/g, '/')).replace(/^\/+/, '');
    if (normalized.startsWith('..') || normalized.includes('/../')) {
      throw new Error('不允许访问沙盒目录之外的文件');
    }
    if (!/^(?:go\.mod|tasks\.json|(?:(?:task|server)\/)?[A-Za-z0-9_-]+\.go)$/.test(normalized)) {
      throw new Error('只可保存课程沙盒中的 Go 文件、go.mod 或 tasks.json');
    }
    const absPath = await sandboxFile(normalized);
    await fs.writeFile(absPath, content, 'utf8');
    return readSandboxFiles();
  }

  async function runCommand(action: GoCommandAction, extraArgs: string[] = []): Promise<GoCommandRunResult> {
    const startTime = Date.now();
    const goBinary = await findGoBinary();
    const dayMeta = GO_DAYS_META.find(d => d.day === progress.currentDay) || GO_DAYS_META[0]!;

    const commandMap: Record<GoCommandAction, { cmd: string; args: string[]; display: string }> = {
      version: { cmd: 'go', args: ['version'], display: 'go version' },
      run: { cmd: 'go', args: ['run', '.', ...extraArgs], display: ['go run .', ...extraArgs].join(' ') },
      test: { cmd: 'go', args: ['test', '-v', '-cover', './...'], display: 'go test -v -cover ./...' },
      race: { cmd: 'go', args: ['test', '-race', './...'], display: 'go test -race ./...' },
      vet: { cmd: 'go', args: ['vet', './...'], display: 'go vet ./...' },
      fmt: { cmd: 'gofmt', args: ['-s', '-w', '.'], display: 'gofmt -s -w .' },
    };

    const spec = commandMap[action];

    if (!goBinary) {
      // Honest simulation mode when local Go toolchain is not yet installed
      let simulatedStdout = '';
      if (action === 'version') {
        simulatedStdout = 'go version go1.27.3 darwin/arm64 (预期输出示例)';
      } else if (action === 'run') {
        simulatedStdout = dayMeta.expectedRunOutput;
        // If running Day 4+ in simulation mode and tasks.json doesn't exist yet, create a sample tasks.json so learner can inspect it
        if (progress.currentDay >= 4) {
          const tasksFile = await sandboxFile('tasks.json');
          try {
            await fs.access(tasksFile);
          } catch {
            const sample = [
              { id: 1, title: '学习 encoding/json 编解码', done: true },
              { id: 2, title: '掌握文件安全写入与原子替换', done: false },
            ];
            await fs.writeFile(tasksFile, `${JSON.stringify(sample, null, 2)}\n`, 'utf8');
          }
        }
      } else if (action === 'test') {
        simulatedStdout = GO_DAYS_META[5]!.expectedRunOutput;
      } else if (action === 'race') {
        simulatedStdout = 'ok  \texample.com/taskmgr/task\t0.142s\nok  \texample.com/taskmgr/server\t0.118s\n[并发竞态检测通过：未发现未加锁的共享内存竞争]';
      } else if (action === 'vet') {
        simulatedStdout = '[go vet ./... 检查通过：退出码 0，未发现静态代码隐患]';
      } else if (action === 'fmt') {
        simulatedStdout = '[gofmt -s -w . 执行完成：所有 .go 文件已按官方标准格式化]';
      }

      return {
        action,
        command: spec.display,
        exitCode: 0,
        stdout: simulatedStdout,
        stderr: '',
        durationMs: Date.now() - startTime,
        ranAt: new Date().toISOString(),
        simulated: true,
        notice: '本机暂未安装 Go 工具链（未实际执行二进制命令），以上为当前章节代码的标准预期输出预览。安装 Go 后点击按钮将直接执行真实编译！',
      };
    }

    const binDir = path.dirname(goBinary);
    const executable = spec.cmd === 'gofmt' ? path.join(binDir, 'gofmt') : goBinary;
    const cwd = await sandboxDirectory();
    const entries = await fs.readdir(cwd, { withFileTypes: true, recursive: true });
    if (entries.some(entry => entry.isSymbolicLink())) throw new Error('运行前请移除沙盒中的符号链接');
    const result = await runGoProcess(executable, spec.args, { cwd, env: toolchainEnv(goBinary),
      httpPreview: action === 'run' && ['day5', 'day6', 'day7', 'day7-graduation'].includes(progress.activeSnapshot) });
    const { httpStarted, ...output } = result;
    return {
      action, command: spec.display, ...output,
      stdout: output.stdout || (output.exitCode === 0 && (action === 'vet' || action === 'fmt') ? `[${spec.display} 执行成功，无报错输出]` : ''),
      durationMs: Date.now() - startTime, ranAt: new Date().toISOString(), simulated: false,
      ...(httpStarted ? { notice: '单次启动演示已结束。可用 HTTP 调试面板模拟请求，也可在终端启动课程服务后调试实际接口。' } : {}),
    };
  }

  async function debugHttpEndpoint(input: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    body?: string;
  }): Promise<GoHttpDebugResult> {
    const startTime = Date.now();
    const requestUrl = new URL(input.path, taskManagerOrigin);
    if (requestUrl.origin !== taskManagerOrigin || !/^\/tasks(?:\/|$)/.test(requestUrl.pathname)) {
      throw new Error('HTTP 调试仅支持 TaskMgr 的 /tasks 接口');
    }
    const isListening = await isTaskManagerListening();

    if (isListening) {
      try {
        const res = await fetch(requestUrl, {
          method: input.method,
          redirect: 'manual',
          signal: AbortSignal.timeout(3000),
          headers: input.body ? { 'Content-Type': 'application/json' } : undefined,
          body: input.method === 'POST' ? input.body : undefined,
        });
        const text = await res.text();
        const { tasksJsonContent } = await readSandboxFiles();
        return {
          method: input.method,
          path: input.path,
          status: res.status,
          statusText: res.statusText || (res.status === 200 ? 'OK' : res.status === 201 ? 'Created' : 'Error'),
          responseBody: text,
          mode: 'live-server',
          durationMs: Date.now() - startTime,
          tasksJsonContent,
        };
      } catch {
        throw new Error('TaskMgr 服务未返回完整响应，请核对运行状态');
      }
    }

    // Sandbox simulator: executes exact same CRUD + tasks.json persistence logic so learner can debug HTTP requests anytime
    const tasksFile = await sandboxFile('tasks.json');
    let tasks: { id: number; title: string; done: boolean }[] = [];
    try {
      const raw = await fs.readFile(tasksFile, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) tasks = parsed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          method: input.method,
          path: input.path,
          status: 500,
          statusText: 'Internal Server Error',
          responseBody: JSON.stringify({ error: 'tasks.json 文件内容已损坏，无法解析 JSON' }, null, 2),
          mode: 'sandbox-simulator',
          durationMs: Date.now() - startTime,
          tasksJsonContent: null,
        };
      }
    }

    const saveTasksFile = async (nextTasks: { id: number; title: string; done: boolean }[]) => {
      const content = `${JSON.stringify(nextTasks, null, 2)}\n`;
      await fs.writeFile(tasksFile, content, 'utf8');
      return content;
    };

    const parsedUrl = requestUrl;
    const pathname = parsedUrl.pathname;

    // 1. GET /tasks (with optional ?done=true|false)
    if (input.method === 'GET' && pathname === '/tasks') {
      const doneParam = parsedUrl.searchParams.get('done');
      let resultTasks = tasks;
      if (doneParam !== null && doneParam !== '') {
        if (doneParam !== 'true' && doneParam !== 'false') {
          const { tasksJsonContent } = await readSandboxFiles();
          return {
            method: 'GET',
            path: input.path,
            status: 400,
            statusText: 'Bad Request',
            responseBody: JSON.stringify({ error: 'done 参数仅支持 true 或 false' }, null, 2),
            mode: 'sandbox-simulator',
            durationMs: Date.now() - startTime,
            tasksJsonContent,
          };
        }
        const wantDone = doneParam === 'true';
        resultTasks = tasks.filter(t => t.done === wantDone);
      }
      const { tasksJsonContent } = await readSandboxFiles();
      return {
        method: 'GET',
        path: input.path,
        status: 200,
        statusText: 'OK',
        responseBody: JSON.stringify(resultTasks, null, 2),
        mode: 'sandbox-simulator',
        durationMs: Date.now() - startTime,
        tasksJsonContent,
      };
    }

    // 2. POST /tasks
    if (input.method === 'POST' && pathname === '/tasks') {
      let payload: { title?: unknown };
      try {
        payload = JSON.parse(input.body || '{}');
      } catch {
        const { tasksJsonContent } = await readSandboxFiles();
        return {
          method: 'POST',
          path: input.path,
          status: 400,
          statusText: 'Bad Request',
          responseBody: JSON.stringify({ error: '请求体必须是合法的 JSON 格式' }, null, 2),
          mode: 'sandbox-simulator',
          durationMs: Date.now() - startTime,
          tasksJsonContent,
        };
      }
      const cleanTitle = typeof payload.title === 'string' ? payload.title.trim() : '';
      if (!cleanTitle) {
        const { tasksJsonContent } = await readSandboxFiles();
        return {
          method: 'POST',
          path: input.path,
          status: 400,
          statusText: 'Bad Request',
          responseBody: JSON.stringify({ error: '任务标题不能为空' }, null, 2),
          mode: 'sandbox-simulator',
          durationMs: Date.now() - startTime,
          tasksJsonContent,
        };
      }
      const nextId = tasks.reduce((max, item) => Math.max(max, item.id), 0) + 1;
      const created = { id: nextId, title: cleanTitle, done: false };
      tasks.push(created);
      const savedContent = await saveTasksFile(tasks);
      return {
        method: 'POST',
        path: input.path,
        status: 201,
        statusText: 'Created',
        responseBody: JSON.stringify(created, null, 2),
        mode: 'sandbox-simulator',
        durationMs: Date.now() - startTime,
        tasksJsonContent: savedContent,
      };
    }

    // 3. PATCH /tasks/{id}/done
    const patchMatch = /^\/tasks\/([^/]+)\/done$/.exec(pathname);
    if (input.method === 'PATCH' && patchMatch) {
      const id = Number(patchMatch[1]);
      if (!Number.isInteger(id) || id <= 0) {
        const { tasksJsonContent } = await readSandboxFiles();
        return {
          method: 'PATCH',
          path: input.path,
          status: 400,
          statusText: 'Bad Request',
          responseBody: JSON.stringify({ error: '任务 ID 必须是大于 0 的整数' }, null, 2),
          mode: 'sandbox-simulator',
          durationMs: Date.now() - startTime,
          tasksJsonContent,
        };
      }
      const target = tasks.find(t => t.id === id);
      if (!target) {
        const { tasksJsonContent } = await readSandboxFiles();
        return {
          method: 'PATCH',
          path: input.path,
          status: 404,
          statusText: 'Not Found',
          responseBody: JSON.stringify({ error: '指定的任务不存在' }, null, 2),
          mode: 'sandbox-simulator',
          durationMs: Date.now() - startTime,
          tasksJsonContent,
        };
      }
      target.done = true;
      const savedContent = await saveTasksFile(tasks);
      return {
        method: 'PATCH',
        path: input.path,
        status: 200,
        statusText: 'OK',
        responseBody: JSON.stringify(target, null, 2),
        mode: 'sandbox-simulator',
        durationMs: Date.now() - startTime,
        tasksJsonContent: savedContent,
      };
    }

    // 4. DELETE /tasks/{id}
    const deleteMatch = /^\/tasks\/([^/]+)$/.exec(pathname);
    if (input.method === 'DELETE' && deleteMatch) {
      const id = Number(deleteMatch[1]);
      if (!Number.isInteger(id) || id <= 0) {
        const { tasksJsonContent } = await readSandboxFiles();
        return {
          method: 'DELETE',
          path: input.path,
          status: 400,
          statusText: 'Bad Request',
          responseBody: JSON.stringify({ error: '任务 ID 必须是大于 0 的整数' }, null, 2),
          mode: 'sandbox-simulator',
          durationMs: Date.now() - startTime,
          tasksJsonContent,
        };
      }
      const idx = tasks.findIndex(t => t.id === id);
      if (idx < 0) {
        const { tasksJsonContent } = await readSandboxFiles();
        return {
          method: 'DELETE',
          path: input.path,
          status: 404,
          statusText: 'Not Found',
          responseBody: JSON.stringify({ error: '指定的任务不存在' }, null, 2),
          mode: 'sandbox-simulator',
          durationMs: Date.now() - startTime,
          tasksJsonContent,
        };
      }
      tasks.splice(idx, 1);
      const savedContent = await saveTasksFile(tasks);
      return {
        method: 'DELETE',
        path: input.path,
        status: 200,
        statusText: 'OK',
        responseBody: JSON.stringify({ message: '任务已删除' }, null, 2),
        mode: 'sandbox-simulator',
        durationMs: Date.now() - startTime,
        tasksJsonContent: savedContent,
      };
    }

    const { tasksJsonContent } = await readSandboxFiles();
    return {
      method: input.method,
      path: input.path,
      status: 404,
      statusText: 'Not Found',
      responseBody: JSON.stringify({ error: '未匹配的路由路径' }, null, 2),
      mode: 'sandbox-simulator',
      durationMs: Date.now() - startTime,
      tasksJsonContent,
    };
  }

  return {
    overview,
    getDay,
    updateProgress,
    applySnapshot,
    readSandboxFiles,
    saveSandboxFile,
    runCommand,
    debugHttpEndpoint,
  };
}
