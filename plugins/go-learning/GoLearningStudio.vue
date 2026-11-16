<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Compass,
  Copy,
  Cpu,
  FileCode2,
  FileText,
  FolderOpen,
  Globe,
  Layers,
  ListChecks,
  MessageSquarePlus,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  Terminal,
  Wrench,
} from '@lucide/vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type {
  GoCommandAction,
  GoCommandRunResult,
  GoHttpDebugResult,
  GoLearningOverview,
  GoSandboxFile,
} from './types';
import { pluginFetch as fetch, host } from './bridge';
import PageHeading from './PageHeading.vue';
import AgentMarkdown from './markdown/AgentMarkdown.vue';
import { FALLBACK_DAYS, loadLocalFallbackOverview, saveLocalFallbackProgress } from './fallback-data';

const workspace = host;

const overview = ref<GoLearningOverview | null>(null);
const loading = ref(false);
const centerTab = ref<'Interactive' | 'Tutorial' | 'Notes'>('Interactive');
const rightTab = ref<'Code' | 'Runner' | 'Http'>('Code');

const selectedFilePath = ref('main.go');
const editorContent = ref('');
const editorDirty = ref(false);
const savingFile = ref(false);

const selectedSnapshot = ref('day1');
const switchingSnapshot = ref(false);

const runningCommand = ref(false);
const commandResult = ref<GoCommandRunResult | null>(null);

const httpMethod = ref<'GET' | 'POST' | 'PATCH' | 'DELETE'>('GET');
const httpPath = ref('/tasks');
const httpBody = ref('{"title": "在工作台完成 Go 实训闯关"}');
const sendingHttp = ref(false);
const httpResult = ref<GoHttpDebugResult | null>(null);

const expandedAnswers = ref<Record<string, boolean>>({});
const showGuideDrawer = ref(false);
const showCheatDrawer = ref(false);
const noteDraft = ref('');
const savingNote = ref(false);

// In-Studio AI Tutor Drawer State
const showTutorDrawer = ref(false);
const tutorMode = ref<'diagnose' | 'review' | 'quiz'>('diagnose');
const diagnosing = ref(false);
const vetResult = ref<GoCommandRunResult | null>(null);
const quizAnswers = ref<Record<string, number>>({});

const snapshotOptions = [
  { value: 'day1', label: 'Day 1 快照：单文件打印与统计 (main.go)' },
  { value: 'day2', label: 'Day 2 快照：内存切片与指针 CRUD (main.go)' },
  { value: 'day3', label: 'Day 3 快照：拆分子包、错误处理与 Storage 接口' },
  { value: 'day4', label: 'Day 4 快照：JSON 编解码与 .tmp 原子文件存储' },
  { value: 'day5', label: 'Day 5 快照：net/http REST API 服务' },
  { value: 'day6', label: 'Day 6 快照：sync.Mutex 并发安全与单元测试' },
  { value: 'day7', label: 'Day 7 快照：最终完整工程（结业练习起点）' },
  { value: 'day7-graduation', label: 'Day 7 结业答案版：已实现 ?done= 状态筛选' },
];

function cleanSandboxFiles(files?: GoSandboxFile[]): GoSandboxFile[] {
  return (files || []).filter(f => f.path !== 'package.json');
}

async function fetchOverview(day?: number) {
  const keepDraft = day !== undefined && editorDirty.value;
  loading.value = true;
  try {
    const query = day ? `?day=${day}` : '';
    let res = await fetch(`/api/go-learning/overview${query}`);
    if (!res.ok && day) {
      res = await fetch('/api/go-learning/overview');
    }
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('application/json')) {
      throw new Error('use-fallback');
    }
    const data = await res.json();
    data.sandboxFiles = cleanSandboxFiles(data.sandboxFiles);
    const localSaved = loadLocalFallbackOverview(data.progress.currentDay).progress;
    data.progress.checkedItems = Array.from(
      new Set([...(data.progress.checkedItems || []), ...(localSaved.checkedItems || [])])
    );
    data.progress.completedExercises = Array.from(
      new Set([...(data.progress.completedExercises || []), ...(localSaved.completedExercises || [])])
    );
    data.progress.notes = { ...(localSaved.notes || {}), ...(data.progress.notes || {}) };
    overview.value = data;
    selectedSnapshot.value = data.progress.activeSnapshot || `day${data.progress.currentDay}`;
    noteDraft.value = data.progress.notes[String(data.progress.currentDay)] || '';
    if (!keepDraft) syncSelectedFile();
  } catch {
    const fallback = loadLocalFallbackOverview(day || overview.value?.progress.currentDay || 1);
    overview.value = fallback;
    selectedSnapshot.value = fallback.progress.activeSnapshot;
    noteDraft.value = fallback.progress.notes[String(fallback.progress.currentDay)] || '';
    if (!keepDraft) syncSelectedFile();
  } finally {
    loading.value = false;
  }
}

function syncSelectedFile() {
  const files = overview.value?.sandboxFiles || [];
  if (!files.length) {
    editorContent.value = '';
    editorDirty.value = false;
    return;
  }
  const current = files.find(f => f.path === selectedFilePath.value) || files[0]!;
  selectedFilePath.value = current.path;
  editorContent.value = current.content;
  editorDirty.value = false;
}

function selectFile(filePath: string) {
  const target = overview.value?.sandboxFiles.find(f => f.path === filePath);
  if (!target) return;
  selectedFilePath.value = target.path;
  editorContent.value = target.content;
  editorDirty.value = false;
}

async function selectDay(day: number) {
  if (!overview.value) return;
  try {
    const res = await fetch('/api/go-learning/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ currentDay: day }),
    });
    if (!res.ok) throw new Error('fallback');
  } catch {
    saveLocalFallbackProgress({ ...overview.value.progress, currentDay: day });
  }
  await fetchOverview(day);
  const targetSnapshot = `day${day}`;
  if (!editorDirty.value && selectedSnapshot.value !== targetSnapshot) {
    await applyDaySnapshot(targetSnapshot, true);
  }
}

const currentDay = computed(() => overview.value?.currentDayDetail);
const progress = computed(() => overview.value?.progress);

const totalChecklistCount = computed(() =>
  (overview.value?.days || []).reduce((sum, d) => sum + d.checklist.length, 0)
);
const checkedCount = computed(() => progress.value?.checkedItems.length || 0);

const totalExerciseCount = computed(() =>
  (overview.value?.days || []).reduce((sum, d) => sum + d.exercises.length, 0)
);
const completedExerciseCount = computed(() => progress.value?.completedExercises.length || 0);

const totalProgressPercent = computed(() => {
  const total = (totalChecklistCount.value || 28) + (totalExerciseCount.value || 21);
  if (!total) return 0;
  return Math.round(((checkedCount.value + completedExerciseCount.value) / total) * 100);
});

const goShortVersion = computed(() => {
  const environment = overview.value?.environment;
  if (!environment?.installed) return '模拟演练模式';
  const raw = environment.version;
  const cleaned = raw.replace(/^go version\s+/i, '').trim();
  return cleaned.split(/\s+/)[0] || cleaned;
});

const goArchText = computed(() => {
  const environment = overview.value?.environment;
  if (!environment?.installed) return '接口模拟器';
  return environment.version.match(/^go version\s+\S+\s+(\S+)/i)?.[1] || '';
});

const editorLineCount = computed(() => {
  if (!editorContent.value) return 1;
  return Math.max(1, editorContent.value.split('\n').length);
});

function dayProgressPercent(dayNum: number): number {
  const d = overview.value?.days.find(item => item.day === dayNum);
  if (!d || !progress.value) return 0;
  const total = d.checklist.length + d.exercises.length;
  if (!total) return 0;
  const doneCheck = d.checklist.filter(c => progress.value!.checkedItems.includes(c.id)).length;
  const doneEx = d.exercises.filter(e => progress.value!.completedExercises.includes(e.id)).length;
  return Math.round(((doneCheck + doneEx) / total) * 100);
}

async function toggleChecklist(id: string) {
  try {
    const res = await fetch('/api/go-learning/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ toggleChecklistId: id }),
    });
    if (!res.ok) throw new Error('fallback');
    const data = await res.json();
    if (overview.value) overview.value.progress = data.progress;
  } catch {
    if (!overview.value) return;
    const list = overview.value.progress.checkedItems;
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(id);
    saveLocalFallbackProgress(overview.value.progress);
  }
}

async function toggleExercise(id: string) {
  try {
    const res = await fetch('/api/go-learning/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ toggleExerciseId: id }),
    });
    if (!res.ok) throw new Error('fallback');
    const data = await res.json();
    if (overview.value) overview.value.progress = data.progress;
  } catch {
    if (!overview.value) return;
    const list = overview.value.progress.completedExercises;
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(id);
    saveLocalFallbackProgress(overview.value.progress);
  }
}

async function saveNote() {
  if (!currentDay.value) return;
  savingNote.value = true;
  try {
    const res = await fetch('/api/go-learning/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({
        note: { day: currentDay.value.day, content: noteDraft.value },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (overview.value) overview.value.progress = data.progress;
    } else if (overview.value) {
      overview.value.progress.notes[String(currentDay.value.day)] = noteDraft.value;
      saveLocalFallbackProgress(overview.value.progress);
    }
    ElMessage.success(`已保存第 ${currentDay.value.day} 天学习笔记`);
  } catch {
    if (overview.value && currentDay.value) {
      overview.value.progress.notes[String(currentDay.value.day)] = noteDraft.value;
      saveLocalFallbackProgress(overview.value.progress);
      ElMessage.success(`已保存第 ${currentDay.value.day} 天学习笔记`);
    }
  } finally {
    savingNote.value = false;
  }
}

async function applyDaySnapshot(snapshotKey = selectedSnapshot.value, skipConfirm = false) {
  if (!skipConfirm && editorDirty.value) {
    try {
      await ElMessageBox.confirm(
        '切换沙盒代码快照将覆盖当前未保存的修改，是否继续？',
        '切换沙盒代码版本',
        { confirmButtonText: '确认加载', cancelButtonText: '取消', type: 'warning' }
      );
    } catch {
      return;
    }
  }
  switchingSnapshot.value = true;
  try {
    const res = await fetch('/api/go-learning/sandbox/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ snapshot: snapshotKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '加载快照失败');
    if (overview.value) {
      overview.value.sandboxFiles = cleanSandboxFiles(data.sandboxFiles);
      overview.value.tasksJsonContent = data.tasksJsonContent;
      overview.value.progress = data.progress;
    }
    selectedSnapshot.value = snapshotKey;
    selectedFilePath.value = 'main.go';
    syncSelectedFile();
    if (!skipConfirm) {
      ElMessage.success(`沙盒已加载 ${snapshotKey} 代码模板`);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加载快照失败');
  } finally {
    switchingSnapshot.value = false;
  }
}

async function saveCurrentFile() {
  if (!selectedFilePath.value) return false;
  savingFile.value = true;
  try {
    const res = await fetch('/api/go-learning/sandbox/save-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({
        filePath: selectedFilePath.value,
        content: editorContent.value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || '保存文件失败');
    if (overview.value) {
      overview.value.sandboxFiles = cleanSandboxFiles(data.sandboxFiles);
      overview.value.tasksJsonContent = data.tasksJsonContent;
    }
    editorDirty.value = false;
    ElMessage.success(`已保存 ${selectedFilePath.value}`);
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存文件失败');
    return false;
  } finally {
    savingFile.value = false;
  }
}

async function runSandboxCommand(action: GoCommandAction, args?: string[], switchTab = true) {
  if (editorDirty.value && !await saveCurrentFile()) return;
  if (switchTab) {
    rightTab.value = 'Runner';
  }
  runningCommand.value = true;
  try {
    const res = await fetch('/api/go-learning/sandbox/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({ action, ...(args ? { args } : {}) }),
    });
    if (res.status === 404 || !res.headers.get('content-type')?.includes('application/json')) throw new Error('fallback');
    const data = await res.json();
    if (!res.ok) {
      commandResult.value = null;
      ElMessage.error(data.message || 'Go 命令执行失败');
      return;
    }
    commandResult.value = data.result;
    if (overview.value) {
      overview.value.sandboxFiles = cleanSandboxFiles(data.sandboxFiles);
      overview.value.tasksJsonContent = data.tasksJsonContent;
    }
  } catch {
    const dayMeta = FALLBACK_DAYS.find(d => d.day === currentDay.value?.day) || FALLBACK_DAYS[0]!;
    commandResult.value = {
      action,
      command: action === 'run' ? 'go run .' : `go ${action} ./...`,
      exitCode: 0,
      stdout: dayMeta.expectedRunOutput,
      stderr: '',
      durationMs: 12,
      ranAt: new Date().toISOString(),
      simulated: true,
      notice: '预期输出预览（重启工作台后端并安装 Go 后将直接执行本机二进制命令）',
    };
  } finally {
    runningCommand.value = false;
  }
}

function fillHttpPreset(preset: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string; body?: string }) {
  httpMethod.value = preset.method;
  httpPath.value = preset.path;
  if (preset.body !== undefined) httpBody.value = preset.body;
  void sendHttpDebugRequest();
}

async function sendHttpDebugRequest() {
  sendingHttp.value = true;
  rightTab.value = 'Http';
  try {
    const res = await fetch('/api/go-learning/sandbox/http-debug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
      body: JSON.stringify({
        method: httpMethod.value,
        path: httpPath.value,
        body: httpMethod.value === 'POST' ? httpBody.value : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'HTTP 调试请求失败');
    httpResult.value = data.result;
    if (overview.value) {
      overview.value.sandboxFiles = cleanSandboxFiles(data.sandboxFiles);
      overview.value.tasksJsonContent = data.tasksJsonContent;
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '发送调试请求失败');
  } finally {
    sendingHttp.value = false;
  }
}

async function openExternalApp(app: 'terminal' | 'cursor') {
  const sandboxPath = overview.value?.sandboxPath;
  if (!sandboxPath) return;
  try {
    const data = await host.openWorkspace(app, sandboxPath);
    ElMessage.success(data.message || '已打开');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '打开应用失败');
  }
}

async function copyText(text: string, label = '代码') {
  try {
    await host.copy(text);
    ElMessage.success(`已复制${label}到剪贴板`);
  } catch {
    ElMessage.warning('复制失败，请手动选择复制');
  }
}

// ---------- In-Studio AI Tutor Logic ----------
const parsedErrorHints = computed(() => {
  const errText = `${commandResult.value?.stderr || ''}\n${vetResult.value?.stderr || ''}`.trim();
  if (!errText) return [];
  const hints: { title: string; detail: string; fix: string }[] = [];
  if (/declared and not used/i.test(errText)) {
    hints.push({
      title: '定义了局部变量却没有使用 (declared and not used)',
      detail: 'Go 编译器有严格的代码洁癖，函数内部声明的局部变量如果没被读取或打印，会直接拒绝编译。',
      fix: '删除多余变量，或在 fmt.Println(...) 中使用它，或用空白标识符 _ 忽略返回值。',
    });
  }
  if (/imported and not used/i.test(errText)) {
    hints.push({
      title: '导入了包却没有使用 (imported and not used)',
      detail: 'import 进来的标准库或子包如果在代码中没有调用，Go 编译器会直接报错。',
      fix: '删掉未使用的 import 行，或点击右侧「格式化 (gofmt)」检查。',
    });
  }
  if (/undefined:/i.test(errText)) {
    hints.push({
      title: '标识符未定义 (undefined)',
      detail: '调用了拼写错误的函数/变量，或者跨包调用时首字母没有大写（Go 只有首字母大写才对外导出 Public）。',
      fix: '检查变量/函数名拼写，若来自子包（如 task.NewManager），确认首字母已大写且已 import 对应包。',
    });
  }
  if (/cannot use .* as .* value/i.test(errText)) {
    hints.push({
      title: '类型不匹配 (cannot use X as Y)',
      detail: 'Go 是强静态类型语言，不能把 int 当 string 传，也不能把值类型传给需要指针 (*Task) 的参数。',
      fix: '检查函数签名与传参类型；如果需要指针请加上取地址符 &，如果需要数值转换请显式调用 strconv。',
    });
  }
  if (/syntax error|unexpected newline/i.test(errText)) {
    hints.push({
      title: '语法错误或左花括号位置不对 (syntax error)',
      detail: 'Go 编译器会自动在行尾补分号，因此 func / if / for 的左花括号 `{` 必须和关键字在同一行，不能另起一行！',
      fix: '检查报错行附近的 `{` 是否单独换了行，或是否漏写了右括号 `)` / `}`。',
    });
  }
  if (!hints.length) {
    hints.push({
      title: '编译或运行期异常',
      detail: '编译器返回了非 0 退出码，请对照下方终端完整报错行号定位对应文件。',
      fix: '查看报错信息中的 `文件名:行号:列号`（例如 `main.go:18:2`），定位到具体代码行修正，或点击下方「发送到 Agent Studio 深度对话」。',
    });
  }
  return hints;
});

const codeReviewItems = computed(() => {
  const day = currentDay.value?.day || 1;
  const allCode = [
    editorContent.value,
    ...(overview.value?.sandboxFiles || []).filter(f => f.path !== selectedFilePath.value).map(f => f.content),
  ].join('\n');

  const items: { ok: boolean; title: string; desc: string }[] = [];

  items.push({
    ok: /package\s+main/.test(allCode) && /func\s+main\s*\(/.test(allCode),
    title: '入口包与主函数规范 (package main & func main)',
    desc: '可执行程序必须包含 package main 与无参无返回值的 func main() 入口。',
  });

  if (day <= 2) {
    items.push({
      ok: /:=/.test(allCode),
      title: '善用短变量声明 (:=) 与类型推导',
      desc: '函数内部推荐使用 := 自动推导类型，保持代码紧凑清晰。',
    });
  }

  if (day >= 2) {
    items.push({
      ok: /type\s+\w+\s+struct/.test(allCode),
      title: '结构体建模 (type Task struct)',
      desc: '使用 struct 聚合业务字段，代替松散的 map[string]any。',
    });
    items.push({
      ok: /\*\s*(TaskManager|Manager|FileStorage)/.test(allCode),
      title: '指针接收者方法 (func (m *Manager) ...)',
      desc: '修改结构体内部切片或状态的方法必须使用指针接收者 *T，避免值拷贝导致修改失效。',
    });
  }

  if (day >= 3) {
    items.push({
      ok: /if\s+err\s*!=\s*nil/.test(allCode) && /errors\.New|fmt\.Errorf/.test(allCode),
      title: '显式错误处理与哨兵错误 (if err != nil / ErrNotFound)',
      desc: 'Go 不使用 try/catch，通过显式返回 error 并在调用处第一时间判空处理。',
    });
  }

  if (day >= 4) {
    items.push({
      ok: /json:"[a-z_]+"/.test(allCode) && /\.tmp/.test(allCode),
      title: 'JSON 序列化标签与 .tmp 临时文件原子写入',
      desc: '结构体字段配置小驼峰/下划线 json tag，写文件先写 .tmp 再 Rename 防止断电损坏。',
    });
  }

  if (day >= 5) {
    items.push({
      ok: /http\.ResponseWriter/.test(allCode) && /Application\/json|application\/json/.test(allCode),
      title: 'RESTful JSON 响应头与 HTTP 状态码规范',
      desc: '显式设置 Content-Type: application/json 并区分 200 / 201 / 400 / 404 状态码。',
    });
  }

  if (day >= 6) {
    items.push({
      ok: /sync\.Mutex/.test(allCode) && /defer\s+.*\.Unlock\(\)/.test(allCode),
      title: '并发安全互斥锁 (sync.Mutex + defer Unlock)',
      desc: '多协程读写共享切片时使用 mu.Lock() 配合 defer mu.Unlock() 确保异常分支也能安全释放锁。',
    });
  }

  return items;
});

interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
}

const currentDayQuizzes = computed<QuizQuestion[]>(() => {
  const day = currentDay.value?.day || 1;
  const bank: Record<number, QuizQuestion[]> = {
    1: [
      {
        id: 'd1-q1',
        question: '1. 在 Go 语言中，声明一个 string 变量但没有赋初值，它的默认值是什么？',
        options: ['undefined', 'null / nil', '空字符串 ""（安全的零值）'],
        answerIndex: 2,
        explanation: 'Go 语言的变量天生具有安全的“零值（Zero Value）”：数字是 0，布尔是 false，字符串是空串 ""，绝不会出现 undefined！',
      },
      {
        id: 'd1-q2',
        question: '2. 为什么在 Go 代码里找不到 while 关键字？',
        options: ['Go 不支持条件循环', 'Go 把计次循环、条件循环和死循环全部统一用 for 关键字表示', '需要导入 while 标准库'],
        answerIndex: 1,
        explanation: 'Go 崇尚极简设计，砍掉了 while 和 do-while：写成 `for count < 10 {}` 就是 while 循环，写成 `for {}` 就是死循环。',
      },
      {
        id: 'd1-q3',
        question: '3. 当函数返回两个值 `pending, comment := calcProgress(3, 2)`，如果只想用 `pending` 不想用 `comment`，该怎么写才不会编译报错？',
        options: ['pending, _ := calcProgress(3, 2)', 'pending, comment := calcProgress(3, 2) 不用管它', 'pending := calcProgress(3, 2)'],
        answerIndex: 0,
        explanation: 'Go 编译器不允许存在声明却未使用的局部变量，使用空白标识符 `_` 可以合法忽略不需要的返回值。',
      },
    ],
    2: [
      {
        id: 'd2-q1',
        question: '1. 为什么给 `TaskManager` 编写 `Add(title string)` 方法时，接收者必须写成 `(m *TaskManager)` 而不是 `(m TaskManager)`？',
        options: ['为了好看', 'Go 默认是值拷贝传参，不加 `*` 修改的只是临时复印件，原结构体的 tasks 切片不会变', '不加 `*` 编译无法通过'],
        answerIndex: 1,
        explanation: 'Go 传参默认全部是“复印件（值传递）”。只有传指针 `*TaskManager`，`append` 追加的新任务才会真正写进原对象里！',
      },
      {
        id: 'd2-q2',
        question: '2. 从 `map[int]string` 中读取一个不存在的 key 时，如何判断该 key 是否真的存在？',
        options: ['判断返回值是不是 null', '使用双返回值 `val, ok := m[id]`，根据布尔值 `ok` 判断', '捕获 KeyError 异常'],
        answerIndex: 1,
        explanation: 'Map 查找不存在的键不会报错而是返回零值，因此标准做法是用 comma-ok 写法 `val, ok := m[key]`。',
      },
      {
        id: 'd2-q3',
        question: '3. 向切片追加元素时，正确的写法是什么？',
        options: ['tasks.push(item)', 'tasks = append(tasks, item)', 'append(tasks, item)'],
        answerIndex: 1,
        explanation: '`append` 可能会触发底层数组扩容并返回新切片地址，因此必须把返回值重新赋回给原切片变量 `tasks = append(tasks, item)`。',
      },
    ],
    3: [
      {
        id: 'd3-q1',
        question: '1. 在 `task` 子包中定义的函数或结构体字段，怎样才能让外面的 `main` 包访问到？',
        options: ['加上 public 关键字', '在 go.mod 中声明 export', '把函数名或字段名的首字母大写（如 `Task`、`NewManager`）'],
        answerIndex: 2,
        explanation: 'Go 没有 public/private 关键字，完全靠首字母大小写控制可见性：首字母大写 = Public，首字母小写 = 包内私有。',
      },
      {
        id: 'd3-q2',
        question: '2. 在 Go 中实现一个 `Storage` 接口（Interface），需要怎么写？',
        options: ['使用 implements Storage 关键字', '只要结构体实现了接口要求的全部同名同签名方法，就自动实现了该接口（鸭子类型）', '必须继承 BaseStorage 基类'],
        answerIndex: 1,
        explanation: 'Go 的接口是隐式实现的（Duck Typing），无需写 `implements`，只要方法签名完全匹配即可无缝替换实现。',
      },
      {
        id: 'd3-q3',
        question: '3. 如何优雅地判断返回的 `err` 是不是我们定义的哨兵错误 `task.ErrNotFound`？',
        options: ['errors.Is(err, task.ErrNotFound)', 'err.message.includes("not found")', 'typeof err === "ErrNotFound"'],
        answerIndex: 0,
        explanation: '`errors.Is(err, target)` 即使在错误被 `fmt.Errorf("%w", err)` 包装多层后也能准确识别底层哨兵错误。',
      },
    ],
    4: [
      {
        id: 'd4-q1',
        question: '1. 如果 `Task` 结构体的字段写成了小写 `title string`，调用 `json.Marshal` 导出 JSON 时会发生什么？',
        options: ['正常导出 "title"', '该字段会被 json 包直接忽略，导出的 JSON 里完全没有这个字段', '运行崩溃 panic'],
        answerIndex: 1,
        explanation: '`encoding/json` 在另一个包中，无法反射读取私有（小写）字段！所以结构体字段必须首字母大写，并用 `` `json:"title"` `` 控制输出键名。',
      },
      {
        id: 'd4-q2',
        question: '2. 为什么保存 `tasks.json` 时要先写入 `tasks.json.tmp` 再调用 `os.Rename`？',
        options: ['为了提高写入速度', '防止写文件到一半进程崩溃或断电，导致原有的 tasks.json 变成半截损坏文件', 'Go 不允许直接覆盖原文件'],
        answerIndex: 1,
        explanation: '先写临时文件再原子重命名（Atomic Rename）是后端工程保障数据落盘完整性的黄金实践。',
      },
      {
        id: 'd4-q3',
        question: '3. 当 `tasks.json` 文件还不存在（首次启动）时，`FileStorage.Load()` 应该怎么处理最合理？',
        options: ['直接报错退出程序', '用 `errors.Is(err, os.ErrNotExist)` 识别并返回空切片 `[]Task{}, nil`', '自动去网络下载'],
        answerIndex: 1,
        explanation: '首次运行没有数据文件属于正常初始状态，返回空任务列表即可让程序平滑启动。',
      },
    ],
    5: [
      {
        id: 'd5-q1',
        question: '1. 在 `net/http` 的处理函数中，为什么要同时写 `w.WriteHeader(status)` 和 `return`？',
        options: ['WriteHeader 只负责发送状态码，不会自动终止当前函数执行，不写 return 会继续往下跑写出多余响应', '语法强制要求', '为了关闭 TCP 连接'],
        answerIndex: 0,
        explanation: '这是新手写 HTTP 接口最常踩的坑：写完错误响应后一定要立刻 `return`，否则后续正常逻辑也会继续执行！',
      },
      {
        id: 'd5-q2',
        question: '2. Go 1.22+ 的标准库 `http.NewServeMux()` 相比早期版本最大的升级是什么？',
        options: ['支持直接写 `"POST /tasks"` 和 `"PATCH /tasks/{id}/done"` 并用 `r.PathValue("id")` 提取路径参数', '自动生成 Swagger 文档', '内置了 MySQL 驱动'],
        answerIndex: 0,
        explanation: 'Go 1.22+ 原生路由已经支持 HTTP 方法匹配和 `{id}` 动态路径参数，写轻量 REST API 完全无需第三方框架。',
      },
      {
        id: 'd5-q3',
        question: '3. 客户端发来空白标题 `{"title": "   "}` 时，服务端返回哪个 HTTP 状态码最符合 REST 规范？',
        options: ['200 OK', '400 Bad Request', '500 Internal Server Error'],
        answerIndex: 1,
        explanation: '客户端请求参数不合法属于 400 Bad Request；资源不存在是 404 Not Found；服务端内部故障才是 500。',
      },
    ],
    6: [
      {
        id: 'd6-q1',
        question: '1. 为什么在 HTTP 服务里操作 `Manager` 的切片需要加 `sync.Mutex` 互斥锁？',
        options: ['因为 Go 的 net/http 会为每一个进来的请求自动开启独立的 Goroutine 并发执行', '为了让代码变慢一点', '因为单线程也需要锁'],
        answerIndex: 0,
        explanation: '`net/http` 天生是高并发模型，多个请求同时读写同一个切片或 Map 会触发数据竞态（Data Race），必须加锁保护。',
      },
      {
        id: 'd6-q2',
        question: '2. 为什么推荐在 `m.mu.Lock()` 下一行紧接着写 `defer m.mu.Unlock()`？',
        options: ['性能更高', '无论函数中间从哪个 if 分支提前 return，都能保证函数退出前 100% 自动解锁，不会死锁', '编译器强制规定'],
        answerIndex: 1,
        explanation: '`defer` 会在当前函数返回前逆序执行，是防止忘记解锁导致死锁的最佳拍档。',
      },
      {
        id: 'd6-q3',
        question: '3. 在沙盒中检测代码是否存在并发读写冲突（数据竞态），应该执行哪条命令？',
        options: ['go fmt ./...', 'go test -race ./...', 'go env'],
        answerIndex: 1,
        explanation: 'Go 内置了极其强大的竞态检测器（Race Detector），只需加上 `-race` 参数即可揪出并发隐患。',
      },
    ],
    7: [
      {
        id: 'd7-q1',
        question: '1. 在 Day 7 结业任务中，如何读取 URL 查询参数 `/tasks?done=true` 中的 `done` 值？',
        options: ['r.PathValue("done")', 'r.URL.Query().Get("done")', 'r.Header.Get("done")'],
        answerIndex: 1,
        explanation: '`r.PathValue` 用于路径占位符 `{id}`，而 `?key=val` 查询字符串使用 `r.URL.Query().Get("done")` 获取。',
      },
      {
        id: 'd7-q2',
        question: '2. 将字符串 `"true"` / `"false"` 解析为布尔值并自动校验非法输入（如 `"abc"`），应该用哪个标准库函数？',
        options: ['strconv.ParseBool(doneParam)', 'strconv.Atoi(doneParam)', 'fmt.Sprint(doneParam)'],
        answerIndex: 0,
        explanation: '`strconv.ParseBool` 支持解析布尔字符串，遇到 `"abc"` 会返回非空 `err`，正好用于返回 400 Bad Request。',
      },
      {
        id: 'd7-q3',
        question: '3. 当筛选结果为空切片时，为了让前端收到 `[]` 而不是 `null`，切片应该如何初始化？',
        options: ['var filtered []task.Task', 'filtered := make([]task.Task, 0) 或 []task.Task{}', 'filtered := nil'],
        answerIndex: 1,
        explanation: '未初始化的 `nil` 切片被 `json.Marshal` 编码后会变成 `null`；使用 `make([]task.Task, 0)` 初始化的空切片则会编码为标准的 `[]`。',
      },
    ],
  };
  return bank[day] || bank[1]!;
});

async function askAgentTutor(mode: 'diagnose' | 'review' | 'quiz') {
  tutorMode.value = mode;
  showTutorDrawer.value = true;

  if (mode === 'diagnose') {
    diagnosing.value = true;
    try {
      await runSandboxCommand('run', undefined, false);
      const res = await fetch('/api/go-learning/sandbox/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Delivery-Confirmed': 'yes' },
        body: JSON.stringify({ action: 'vet' }),
      });
      if (res.ok) {
        const data = await res.json();
        vetResult.value = data.result;
      }
    } catch {
      // Ignore vet error in fallback mode
    } finally {
      diagnosing.value = false;
    }
  }
}

async function sendToAgentStudio() {
  if (!workspace || !overview.value || !currentDay.value) {
    ElMessage.warning('当前不在 Agent 联动上下文中');
    return;
  }
  const day = currentDay.value;
  const sandboxPath = overview.value.sandboxPath;
  const codeSnippet = `当前文件 \`${selectedFilePath.value}\` 内容：\n\`\`\`go\n${editorContent.value}\n\`\`\``;

  let prompt = '';
  if (tutorMode.value === 'diagnose') {
    const hasErr =
      (commandResult.value && commandResult.value.exitCode !== 0) ||
      (vetResult.value && vetResult.value.exitCode !== 0);
    if (hasErr) {
      const errOut =
        commandResult.value?.stderr ||
        commandResult.value?.stdout ||
        vetResult.value?.stderr ||
        vetResult.value?.stdout ||
        '';
      prompt = `我正在「Go 实训工坊」学习【${day.title}】，沙盒目录为 \`${sandboxPath}\`。\n执行编译检查时遇到以下报错：\n\`\`\`\n${errOut}\n\`\`\`\n\n${codeSnippet}\n\n请用通俗的大白话帮我分析报错原因，并给出修改后的代码。`;
    } else {
      prompt = `我正在「Go 实训工坊」学习【${day.title}】，沙盒目录为 \`${sandboxPath}\`。\n目前 \`go run .\` 和 \`go vet\` 均已通过（Exit 0），输出结果如下：\n\`\`\`\n${commandResult.value?.stdout || '无输出'}\n\`\`\`\n\n${codeSnippet}\n\n请帮我结合本日核心知识点（${day.keywords.join('、')}）讲解一下这段代码的执行流程与潜在易错点。`;
    }
  } else if (tutorMode.value === 'review') {
    prompt = `我正在「Go 实训工坊」学习【${day.title}】，沙盒目录为 \`${sandboxPath}\`。\n${codeSnippet}\n\n请结合 Go 语言工程最佳实践（指针接收者、显式 error 处理、并发安全等）帮我深入审查这段代码，并给出优化建议。`;
  } else {
    prompt = `我已经完成了「Go 实训工坊」【${day.title}】的 3 道快问快答（核心知识点：${day.keywords.join('、')}），沙盒目录为 \`${sandboxPath}\`。\n请继续结合本节代码出 2 道实战追问题考考我，帮我巩固理解！`;
  }

  showTutorDrawer.value = false;
  try { await workspace.compose(prompt, sandboxPath); } catch (error) { ElMessage.error(error instanceof Error ? error.message : '未能填入会话草稿'); }
}

watch(
  () => currentDay.value?.day,
  newDay => {
    if (newDay && overview.value) {
      noteDraft.value = overview.value.progress.notes[String(newDay)] || '';
    }
  }
);

onMounted(() => {
  void fetchOverview();
});
</script>

<template>
  <div class="go-studio-page">
    <PageHeading
      title="Go 实训工坊"
      description="《7 天上手 Go》交互式闯关舱：大白话速懂卡片 + 独立代码沙盒 + 一键运行测试 + AI 助教陪练"
      :loading="loading"
      @refresh="fetchOverview()"
    >
      <el-button @click="showGuideDrawer = true">
        <BookOpen :size="15" style="margin-right: 6px" />
        10 分钟大白话总导读
      </el-button>
      <el-button @click="showCheatDrawer = true">
        <Sparkles :size="15" style="margin-right: 6px" />
        一页语法 & 命令速查表
      </el-button>
      <el-button @click="openExternalApp('cursor')">
        <Code2 :size="15" style="margin-right: 6px" />
        用 Cursor 打开沙盒
      </el-button>
      <el-button @click="openExternalApp('terminal')">
        <Terminal :size="15" style="margin-right: 6px" />
        打开沙盒终端
      </el-button>
    </PageHeading>

    <!-- Custom Purpose-Built 4-Column KPI Strip (No text collision) -->
    <section v-if="overview" class="studio-kpi-strip" aria-label="实训核心指标">
      <!-- Card 1: Go Toolchain -->
      <article class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">
            <Cpu :size="14" class="kpi-icon" />
            本机 Go 工具链
          </span>
          <span class="kpi-pill" :class="overview.environment.installed ? 'is-ok' : 'is-warn'">
            <i class="status-dot"></i>
            {{ overview.environment.installed ? '已安装就绪' : '模拟模式' }}
          </span>
        </div>
        <div class="kpi-main">
          <strong class="kpi-value mono" :class="{ ok: overview.environment.installed }">
            {{ goShortVersion }}
          </strong>
          <span class="kpi-sub-badge mono">{{ goArchText }}</span>
        </div>
        <div class="kpi-foot" :title="overview.environment.goproxy">
          <span v-if="overview.environment.installed">
            路径 <code>{{ overview.environment.goBinaryPath }}</code> · GOPROXY <code>{{ overview.environment.goproxy }}</code>
          </span>
          <span v-else>未安装 Go 亦可正常浏览教程与运行模拟输出</span>
        </div>
      </article>

      <!-- Card 2: Current Stage -->
      <article class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">
            <Compass :size="14" class="kpi-icon" />
            当前闯关章节
          </span>
          <span class="kpi-pill is-accent">
            STAGE 0{{ currentDay?.day || 1 }} / 07
          </span>
        </div>
        <div class="kpi-main">
          <strong class="kpi-value">
            Day {{ currentDay?.day || 1 }} · {{ currentDay?.shortTitle || '环境与基本语法' }}
          </strong>
        </div>
        <div class="kpi-foot">
          <span>预计耗时 {{ currentDay?.estimatedHours || '2.0~2.5 小时' }} · 循序渐进实战</span>
        </div>
      </article>

      <!-- Card 3: Checklist & Exercises -->
      <article class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">
            <ListChecks :size="14" class="kpi-icon" />
            检查清单与练习
          </span>
          <span class="kpi-pill mono">
            已通关 {{ totalProgressPercent }}%
          </span>
        </div>
        <div class="kpi-main">
          <strong class="kpi-value mono">
            {{ checkedCount }} <small>/ {{ totalChecklistCount || 28 }} 清单</small>
          </strong>
          <span class="kpi-divider">·</span>
          <span class="kpi-secondary-stat mono">
            {{ completedExerciseCount }} / {{ totalExerciseCount || 21 }} 练习
          </span>
        </div>
        <div class="kpi-foot">
          <div class="kpi-progress-track">
            <div class="kpi-progress-fill" :style="{ width: `${totalProgressPercent}%` }"></div>
          </div>
        </div>
      </article>

      <!-- Card 4: Sandbox Workspace -->
      <article class="kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">
            <Layers :size="14" class="kpi-icon" />
            独立实训沙盒
          </span>
          <span class="kpi-pill mono">
            快照 {{ selectedSnapshot }}
          </span>
        </div>
        <div class="kpi-main">
          <strong class="kpi-value">
            {{ overview.sandboxFiles.length }} 个工程文件
          </strong>
          <span v-if="overview.tasksJsonContent" class="kpi-sub-badge is-ok">tasks.json 已落盘</span>
        </div>
        <div class="kpi-foot">
          <span>目录 <code>work/go-taskmgr-lab</code> · 支持真实编译与测试</span>
        </div>
      </article>
    </section>

    <!-- Compact Toolchain Bar -->
    <div v-if="overview && overview.environment.installed" class="toolchain-strip">
      <div class="toolchain-items">
        <span class="toolchain-title">本机 Go 工具链</span>
        <span class="tool-chip"><i class="dot"></i>CGO_ENABLED <code>{{ overview.environment.cgoEnabled }}</code></span>
      </div>
      <div class="toolchain-actions">
        <el-button size="small" type="primary" plain :loading="runningCommand" @click="runSandboxCommand('run')">
          <Play :size="13" style="margin-right: 4px" />实测本机编译 (go run .)
        </el-button>
      </div>
    </div>

    <div v-else-if="overview && !overview.environment.installed" class="toolchain-strip is-warning">
      <div class="toolchain-items">
        <span class="toolchain-title warn">零门槛体验模式</span>
        <span class="toolchain-desc">
          当前未检测到 <code>go</code> 命令，已自动开启预期输出预览与 HTTP 接口模拟器。安装命令：<code>brew install go</code>
        </span>
      </div>
      <div class="toolchain-actions">
        <el-button size="small" @click="copyText('brew install go', '安装命令')">
          <Copy :size="13" style="margin-right: 4px" />复制安装命令
        </el-button>
      </div>
    </div>

    <!-- Main 3-Column Bento Layout -->
    <div v-if="overview && currentDay" class="studio-grid">
      <!-- Left Column: 7-Day Roadmap -->
      <aside class="studio-sidebar">
        <div class="sidebar-header">
          <div class="sidebar-title-row">
            <Compass :size="15" class="header-icon" />
            <h3>7 天闯关路线图</h3>
          </div>
          <span class="sidebar-sub">点击切换每日课程与沙盒模板</span>
        </div>

        <div class="day-list">
          <button
            v-for="item in overview.days"
            :key="item.id"
            type="button"
            class="day-card"
            :class="{ active: currentDay.day === item.day, completed: dayProgressPercent(item.day) === 100 }"
            @click="selectDay(item.day)"
          >
            <div class="day-card-top">
              <span class="day-num">DAY 0{{ item.day }}</span>
              <span class="day-percent" :class="{ done: dayProgressPercent(item.day) === 100 }">
                {{ dayProgressPercent(item.day) }}%
              </span>
            </div>
            <strong class="day-name">{{ item.shortTitle }}</strong>
            <p class="day-deliverable">{{ item.deliverable }}</p>
            <div class="day-progress-bar">
              <div class="day-progress-fill" :style="{ width: `${dayProgressPercent(item.day)}%` }"></div>
            </div>
          </button>
        </div>

        <div class="sidebar-footer">
          <div class="sandbox-path-box">
            <div class="path-label">
              <FolderOpen :size="13" />
              <span>独立实训沙盒路径</span>
            </div>
            <code>{{ overview.sandboxPath }}</code>
          </div>
        </div>
      </aside>

      <!-- Center Column: Plain-Language Card, Checklist, Exercises & Full Tutorial -->
      <main class="studio-center">
        <header class="day-hero">
          <div class="day-hero-title-row">
            <div class="hero-title-block">
              <div class="hero-meta-badges">
                <span class="stage-pill">STAGE 0{{ currentDay.day }}</span>
                <span class="time-pill">预计耗时 {{ currentDay.estimatedHours }}</span>
              </div>
              <h2>{{ currentDay.title }}</h2>
            </div>
            <div class="day-hero-actions">
              <el-button
                size="small"
                type="primary"
                plain
                :loading="switchingSnapshot"
                @click="applyDaySnapshot(`day${currentDay.day}`)"
              >
                <FileCode2 :size="14" style="margin-right: 5px" />
                加载第 {{ currentDay.day }} 天代码到沙盒
              </el-button>
            </div>
          </div>

          <div class="hero-goal-box">
            <Target :size="15" class="goal-icon" />
            <p><strong>本日目标：</strong>{{ currentDay.goal }}</p>
          </div>

          <div class="hero-bottom-bar">
            <div class="hero-keywords">
              <span v-for="kw in currentDay.keywords" :key="kw" class="kw-pill">{{ kw }}</span>
            </div>

            <div class="center-segmented-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                :class="{ active: centerTab === 'Interactive' }"
                @click="centerTab = 'Interactive'"
              >
                <Sparkles :size="13" />
                <span>核心速懂 & 任务单</span>
              </button>
              <button
                type="button"
                role="tab"
                :class="{ active: centerTab === 'Tutorial' }"
                @click="centerTab = 'Tutorial'"
              >
                <BookOpen :size="13" />
                <span>完整精排教程</span>
              </button>
              <button
                type="button"
                role="tab"
                :class="{ active: centerTab === 'Notes' }"
                @click="centerTab = 'Notes'"
              >
                <FileText :size="13" />
                <span>学习笔记</span>
              </button>
            </div>
          </div>
        </header>

        <div class="center-scroll-body">
          <!-- Tab 1: Plain-Language Summary Card + Interactive Checklist + Exercises -->
          <template v-if="centerTab === 'Interactive'">
            <section v-if="currentDay.cardMarkdown" class="plain-card-section">
              <div class="studio-markdown">
                <AgentMarkdown :source="currentDay.cardMarkdown" />
              </div>
              <div class="plain-card-footer">
                <span>看完 3 分钟速懂卡片后，您可以：</span>
                <div class="plain-card-links">
                  <el-button size="small" link type="primary" @click="centerTab = 'Tutorial'">
                    展开完整代码拆解教程 →
                  </el-button>
                  <el-button size="small" link type="primary" @click="runSandboxCommand('run')">
                    直接在右侧编译运行 →
                  </el-button>
                </div>
              </div>
            </section>

            <!-- Interactive Checklist -->
            <section class="interactive-section">
              <div class="section-head">
                <div class="section-title-group">
                  <ListChecks :size="16" class="sec-icon" />
                  <h3>第 {{ currentDay.day }} 天完成检查清单</h3>
                  <span class="section-hint">点击即可打勾记录进度</span>
                </div>
                <span class="section-counter mono">
                  {{ currentDay.checklist.filter(c => overview?.progress.checkedItems.includes(c.id)).length }}
                  / {{ currentDay.checklist.length }}
                </span>
              </div>
              <div class="checklist-grid">
                <label
                  v-for="item in currentDay.checklist"
                  :key="item.id"
                  class="checklist-row"
                  :class="{ checked: overview.progress.checkedItems.includes(item.id) }"
                  @click.prevent="toggleChecklist(item.id)"
                >
                  <input
                    type="checkbox"
                    :checked="overview.progress.checkedItems.includes(item.id)"
                    readonly
                  />
                  <span class="check-box-ui">
                    <CheckCircle2 v-if="overview.progress.checkedItems.includes(item.id)" :size="15" />
                  </span>
                  <span class="check-text">{{ item.text }}</span>
                </label>
              </div>
            </section>

            <!-- Interactive Exercises -->
            <section class="interactive-section">
              <div class="section-head">
                <div class="section-title-group">
                  <Code2 :size="16" class="sec-icon" />
                  <h3>课后由易到难闯关练习</h3>
                  <span class="section-hint">建议先在右侧沙盒动手试，再展开答案对照</span>
                </div>
                <el-button
                  v-if="currentDay.answerCode"
                  size="small"
                  @click="expandedAnswers[currentDay.id] = !expandedAnswers[currentDay.id]"
                >
                  <component :is="expandedAnswers[currentDay.id] ? ChevronDown : ChevronRight" :size="14" style="margin-right: 4px" />
                  {{ expandedAnswers[currentDay.id] ? '收起参考答案' : '查看参考答案' }}
                </el-button>
              </div>

              <div class="exercise-list">
                <article
                  v-for="ex in currentDay.exercises"
                  :key="ex.id"
                  class="exercise-card"
                  :class="{ done: overview.progress.completedExercises.includes(ex.id) }"
                >
                  <div class="exercise-card-head">
                    <div class="exercise-title-group">
                      <span class="level-tag" :data-level="ex.level">{{ ex.level }}</span>
                      <strong>{{ ex.title }}</strong>
                    </div>
                    <el-button
                      size="small"
                      :type="overview.progress.completedExercises.includes(ex.id) ? 'success' : 'default'"
                      plain
                      @click="toggleExercise(ex.id)"
                    >
                      {{ overview.progress.completedExercises.includes(ex.id) ? '✓ 已完成' : '标记完成' }}
                    </el-button>
                  </div>
                  <p class="exercise-desc">{{ ex.description }}</p>
                </article>
              </div>

              <div v-if="expandedAnswers[currentDay.id] && currentDay.answerCode" class="answer-drawer">
                <div class="answer-drawer-bar">
                  <strong>第 {{ currentDay.day }} 天参考答案源码</strong>
                  <div class="answer-actions">
                    <el-button
                      v-if="currentDay.day === 7"
                      size="small"
                      type="primary"
                      plain
                      @click="applyDaySnapshot('day7-graduation')"
                    >
                      一键将结业答案加载到沙盒
                    </el-button>
                    <el-button size="small" @click="copyText(currentDay.answerCode, '参考答案')">
                      <Copy :size="13" style="margin-right: 4px" />复制答案代码
                    </el-button>
                  </div>
                </div>
                <div class="studio-markdown">
                  <AgentMarkdown :source="currentDay.answerCode" />
                </div>
              </div>
            </section>
          </template>

          <!-- Tab 2: Full Detailed Day Tutorial -->
          <template v-else-if="centerTab === 'Tutorial'">
            <section class="full-tutorial-section">
              <div class="tutorial-top-notice">
                <span>以下是第 {{ currentDay.day }} 天的完整图文与代码详解：</span>
                <el-button size="small" link type="primary" @click="centerTab = 'Interactive'">
                  ← 返回速懂卡片与任务单
                </el-button>
              </div>
              <div class="studio-markdown">
                <AgentMarkdown :source="currentDay.tutorialMarkdown" />
              </div>
            </section>
          </template>

          <!-- Tab 3: Personal Notes for the Day -->
          <template v-else>
            <section class="notes-section">
              <div class="section-head">
                <div class="section-title-group">
                  <FileText :size="16" class="sec-icon" />
                  <h3>第 {{ currentDay.day }} 天个人踩坑与学习心得</h3>
                </div>
                <el-button type="primary" size="small" :loading="savingNote" @click="saveNote">
                  保存笔记
                </el-button>
              </div>
              <textarea
                v-model="noteDraft"
                class="note-textarea"
                placeholder="在这里记录今天学习的重点、踩到的坑，或自己的理解总结（支持保存后跨会话保留）..."
              ></textarea>
            </section>
          </template>
        </div>
      </main>

      <!-- Right Column: Sandbox Code Editor, Command Runner, HTTP Mini-Debugger & AI Tutor -->
      <aside class="studio-right">
        <div class="sandbox-toolbar">
          <div class="snapshot-select-row">
            <select v-model="selectedSnapshot" class="snapshot-select" @change="applyDaySnapshot(selectedSnapshot)">
              <option v-for="opt in snapshotOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
            <el-button
              size="small"
              title="重置沙盒为当前所选快照"
              :loading="switchingSnapshot"
              @click="applyDaySnapshot(selectedSnapshot)"
            >
              <RefreshCw :size="13" />
            </el-button>
          </div>

          <div class="right-segmented-tabs" role="tablist">
            <button type="button" :class="{ active: rightTab === 'Code' }" @click="rightTab = 'Code'">
              <Code2 :size="13" />
              <span>沙盒代码 ({{ overview.sandboxFiles.length }})</span>
            </button>
            <button type="button" :class="{ active: rightTab === 'Runner' }" @click="rightTab = 'Runner'">
              <Play :size="13" />
              <span>运行与测试</span>
            </button>
            <button type="button" :class="{ active: rightTab === 'Http' }" @click="rightTab = 'Http'">
              <Globe :size="13" />
              <span>HTTP 调试</span>
            </button>
          </div>
        </div>

        <!-- Right Tab 1: Sandbox Code Editor -->
        <div v-if="rightTab === 'Code'" class="right-panel-body">
          <div class="ide-header-bar">
            <div class="file-tabs">
              <button
                v-for="file in overview.sandboxFiles"
                :key="file.path"
                type="button"
                class="file-tab-btn"
                :class="{ active: selectedFilePath === file.path, 'is-json': file.path.endsWith('.json') }"
                @click="selectFile(file.path)"
              >
                <FileCode2 :size="12" />
                <span>{{ file.path }}</span>
              </button>
            </div>

            <div class="editor-actions">
              <span v-if="editorDirty" class="dirty-dot">● 未保存</span>
              <el-button size="small" @click="copyText(editorContent, selectedFilePath)">
                <Copy :size="12" style="margin-right: 4px" />复制
              </el-button>
              <el-button
                size="small"
                type="primary"
                :disabled="!editorDirty"
                :loading="savingFile"
                @click="saveCurrentFile"
              >
                保存修改
              </el-button>
            </div>
          </div>

          <div class="code-editor-shell">
            <div class="line-gutter" aria-hidden="true">
              <span v-for="n in editorLineCount" :key="n">{{ n }}</span>
            </div>
            <textarea
              v-model="editorContent"
              class="code-editor-textarea"
              spellcheck="false"
              @input="editorDirty = true"
              @keydown.meta.s.prevent="saveCurrentFile"
              @keydown.ctrl.s.prevent="saveCurrentFile"
            ></textarea>
          </div>

          <div class="ide-footer-bar">
            <span class="ide-meta mono">{{ selectedFilePath }} · {{ editorLineCount }} 行 · UTF-8</span>
            <div class="quick-run-strip">
              <el-button size="small" type="primary" :loading="runningCommand" @click="runSandboxCommand('run')">
                <Play :size="12" style="margin-right: 4px" />go run .
              </el-button>
              <el-button size="small" :loading="runningCommand" @click="runSandboxCommand('test')">
                go test -v
              </el-button>
              <el-button size="small" :loading="runningCommand" @click="runSandboxCommand('vet')">
                go vet
              </el-button>
              <el-button v-if="currentDay.day >= 5" size="small" type="success" plain @click="rightTab = 'Http'">
                HTTP 调试 →
              </el-button>
            </div>
          </div>
        </div>

        <!-- Right Tab 2: Command Runner & Terminal Output -->
        <div v-else-if="rightTab === 'Runner'" class="right-panel-body">
          <div class="runner-buttons-grid">
            <el-button type="primary" size="small" :loading="runningCommand" @click="runSandboxCommand('run')">
              <Play :size="13" style="margin-right: 4px" />运行 (go run .)
            </el-button>
            <el-button size="small" :loading="runningCommand" @click="runSandboxCommand('test')">
              单元测试 (go test -v)
            </el-button>
            <el-button size="small" :loading="runningCommand" @click="runSandboxCommand('race')">
              竞态检测 (go test -race)
            </el-button>
            <el-button size="small" :loading="runningCommand" @click="runSandboxCommand('vet')">
              静态体检 (go vet)
            </el-button>
            <el-button size="small" :loading="runningCommand" @click="runSandboxCommand('fmt')">
              <Wrench :size="13" style="margin-right: 4px" />格式化 (gofmt)
            </el-button>
          </div>

          <div v-if="currentDay.day === 4" class="day4-cli-presets">
            <span>Day 4 命令行参数快捷演练：</span>
            <el-button size="small" link type="primary" @click="runSandboxCommand('run', ['add', '学习 JSON 编解码'])">
              go run . add "学习 JSON 编解码"
            </el-button>
            <el-button size="small" link type="primary" @click="runSandboxCommand('run', ['done', '1'])">
              go run . done 1
            </el-button>
            <el-button size="small" link type="primary" @click="runSandboxCommand('run', ['list'])">
              go run . list
            </el-button>
          </div>

          <div class="terminal-box">
            <template v-if="commandResult">
              <div class="terminal-header">
                <code>$ {{ commandResult.command }}</code>
                <div class="terminal-badges">
                  <span v-if="commandResult.simulated" class="sim-badge">预期输出预览</span>
                  <span v-else class="real-badge">本机真实编译运行</span>
                  <span
                    class="exit-badge"
                    :class="commandResult.exitCode === 0 ? 'ok' : 'err'"
                  >
                    Exit {{ commandResult.exitCode }} ({{ commandResult.durationMs }}ms)
                  </span>
                </div>
              </div>
              <div v-if="commandResult.notice" class="terminal-notice">
                {{ commandResult.notice }}
              </div>
              <pre v-if="commandResult.stdout" class="terminal-stdout">{{ commandResult.stdout }}</pre>
              <pre v-if="commandResult.stderr" class="terminal-stderr">{{ commandResult.stderr }}</pre>
            </template>
            <div v-else class="terminal-empty">
              点击上方按钮执行 <code>go run .</code> 或 <code>go test -v</code>，此处将实时展示本机编译运行结果。
            </div>
          </div>

          <div v-if="overview.tasksJsonContent" class="tasks-json-preview">
            <div class="tasks-json-head">
              <strong>沙盒磁盘文件 <code>tasks.json</code> 实时快照</strong>
              <span>重启服务后从此文件恢复</span>
            </div>
            <pre>{{ overview.tasksJsonContent }}</pre>
          </div>
        </div>

        <!-- Right Tab 3: Interactive HTTP Mini-Debugger (Day 5~7) -->
        <div v-else class="right-panel-body">
          <div class="http-presets">
            <span class="preset-label">一键发送测试请求（覆盖正常流与 400/404 异常校验）：</span>
            <div class="preset-chips">
              <button
                type="button"
                class="chip-btn"
                @click="fillHttpPreset({ method: 'GET', path: '/tasks' })"
              >
                1. GET /tasks
              </button>
              <button
                type="button"
                class="chip-btn"
                @click="fillHttpPreset({ method: 'POST', path: '/tasks', body: '{\x22title\x22: \x22掌握 net/http 路由与状态码\x22}' })"
              >
                2. POST 新增任务
              </button>
              <button
                type="button"
                class="chip-btn warn"
                @click="fillHttpPreset({ method: 'POST', path: '/tasks', body: '{\x22title\x22: \x22   \x22}' })"
              >
                3. POST 空白标题 (400)
              </button>
              <button
                type="button"
                class="chip-btn"
                @click="fillHttpPreset({ method: 'PATCH', path: '/tasks/1/done' })"
              >
                4. PATCH #1 完成
              </button>
              <button
                type="button"
                class="chip-btn warn"
                @click="fillHttpPreset({ method: 'PATCH', path: '/tasks/99/done' })"
              >
                5. PATCH #99 不存在 (404)
              </button>
              <button
                type="button"
                class="chip-btn"
                @click="fillHttpPreset({ method: 'DELETE', path: '/tasks/2' })"
              >
                6. DELETE #2
              </button>
              <button
                type="button"
                class="chip-btn accent"
                @click="fillHttpPreset({ method: 'GET', path: '/tasks?done=true' })"
              >
                7. 结业筛选 ?done=true
              </button>
              <button
                type="button"
                class="chip-btn accent"
                @click="fillHttpPreset({ method: 'GET', path: '/tasks?done=false' })"
              >
                8. 结业筛选 ?done=false
              </button>
              <button
                type="button"
                class="chip-btn warn"
                @click="fillHttpPreset({ method: 'GET', path: '/tasks?done=abc' })"
              >
                9. 非法筛选 ?done=abc (400)
              </button>
            </div>
          </div>

          <div class="http-composer">
            <div class="http-url-row">
              <select v-model="httpMethod" class="http-method-select">
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
              <input v-model="httpPath" type="text" class="http-path-input" placeholder="/tasks" />
              <el-button type="primary" size="small" :loading="sendingHttp" @click="sendHttpDebugRequest">
                <Send :size="13" style="margin-right: 4px" />发送
              </el-button>
            </div>
            <textarea
              v-if="httpMethod === 'POST'"
              v-model="httpBody"
              class="http-body-input"
              rows="2"
              placeholder='{"title": "任务标题"}'
            ></textarea>
          </div>

          <div v-if="httpResult" class="http-response-box">
            <div class="http-res-head">
              <span
                class="http-status-pill"
                :class="httpResult.status < 300 ? 'ok' : httpResult.status < 500 ? 'warn' : 'err'"
              >
                HTTP {{ httpResult.status }} {{ httpResult.statusText }}
              </span>
              <span class="http-mode-tag">
                {{ httpResult.mode === 'live-server' ? '真实 :8080 进程响应' : '沙盒持久化模拟器响应' }}
                ({{ httpResult.durationMs }}ms)
              </span>
            </div>
            <pre class="http-res-body">{{ httpResult.responseBody }}</pre>
          </div>

          <div v-if="overview.tasksJsonContent" class="tasks-json-preview">
            <div class="tasks-json-head">
              <strong>底层 <code>tasks.json</code> 文件同步结果</strong>
              <span>每次 POST/PATCH/DELETE 均原子写入</span>
            </div>
            <pre>{{ overview.tasksJsonContent }}</pre>
          </div>
        </div>

        <!-- Bottom AI Tutor Bar -->
        <footer class="ai-tutor-bar">
          <div class="tutor-label">
            <Bot :size="14" class="tutor-icon" />
            <span>AI 助教陪练（页内实时诊断与互动问答）</span>
          </div>
          <div class="tutor-actions">
            <el-button size="small" @click="askAgentTutor('diagnose')">
              报错诊断
            </el-button>
            <el-button size="small" @click="askAgentTutor('review')">
              代码审查
            </el-button>
            <el-button size="small" @click="askAgentTutor('quiz')">
              快问快答
            </el-button>
          </div>
        </footer>
      </aside>
    </div>

    <!-- Drawer 1: 10-Minute Plain-Language Overview Guide -->
    <el-drawer
      v-model="showGuideDrawer"
      title="《7 天上手 Go》10 分钟大白话核心概念图解导读"
      size="680px"
    >
      <div v-if="overview" class="drawer-markdown-wrap studio-markdown">
        <AgentMarkdown :source="overview.guideMarkdown" />
      </div>
    </el-drawer>

    <!-- Drawer 2: One-Page Cheat Sheet -->
    <el-drawer
      v-model="showCheatDrawer"
      title="Go 核心语法与常用命令一页速查表 (Cheat Sheet)"
      size="640px"
    >
      <div v-if="overview" class="drawer-markdown-wrap studio-markdown">
        <AgentMarkdown :source="overview.cheatSheetMarkdown" />
      </div>
    </el-drawer>

    <!-- Drawer 3: In-Studio AI Tutor (Diagnose / Code Review / Interactive Quiz) -->
    <el-drawer
      v-model="showTutorDrawer"
      :title="`AI 助教陪练 · ${currentDay?.title || 'Go 实训'}`"
      size="620px"
    >
      <div v-if="overview && currentDay" class="tutor-drawer-body">
        <div class="tutor-mode-switcher" role="tablist">
          <button
            type="button"
            :class="{ active: tutorMode === 'diagnose' }"
            @click="askAgentTutor('diagnose')"
          >
            报错诊断
          </button>
          <button
            type="button"
            :class="{ active: tutorMode === 'review' }"
            @click="tutorMode = 'review'"
          >
            代码审查
          </button>
          <button
            type="button"
            :class="{ active: tutorMode === 'quiz' }"
            @click="tutorMode = 'quiz'"
          >
            快问快答 (3 题)
          </button>
        </div>

        <!-- Mode 1: Real-time Compiler & Vet Diagnosis -->
        <template v-if="tutorMode === 'diagnose'">
          <div v-if="diagnosing" class="tutor-status-card">
            <span>正在对沙盒目录执行 <code>go run .</code> 与 <code>go vet ./...</code> 实时编译体检...</span>
          </div>
          <template v-else>
            <div
              v-if="(!commandResult || commandResult.exitCode === 0) && (!vetResult || vetResult.exitCode === 0)"
              class="tutor-status-card is-ok"
            >
              <div class="tutor-status-head">
                <CheckCircle2 :size="18" />
                <strong>当前沙盒代码编译运行与静态检查全部通过（0 报错）！</strong>
              </div>
              <p>
                执行命令 <code>{{ commandResult?.command || 'go run .' }}</code> 退出码为 <code>0</code>，<code>go vet</code> 未发现任何静态隐患。
              </p>
              <pre v-if="commandResult?.stdout" class="tutor-mini-pre">{{ commandResult.stdout }}</pre>
            </div>

            <div v-else class="tutor-status-card is-err">
              <div class="tutor-status-head">
                <strong>检测到编译或静态检查异常（Exit {{ commandResult?.exitCode || vetResult?.exitCode }}）</strong>
              </div>
              <pre class="tutor-mini-pre err">{{ commandResult?.stderr || vetResult?.stderr || commandResult?.stdout }}</pre>
              <div class="tutor-hints-list">
                <div v-for="(h, idx) in parsedErrorHints" :key="idx" class="tutor-hint-item">
                  <strong>💡 大白话原因：{{ h.title }}</strong>
                  <p>{{ h.detail }}</p>
                  <p class="fix-line"><strong>🔧 修复建议：</strong>{{ h.fix }}</p>
                </div>
              </div>
            </div>

            <div class="tutor-Sub-block">
              <h4>📌 第 {{ currentDay.day }} 天高频踩坑自查</h4>
              <ul class="tutor-pitfall-list">
                <li><strong>未使用的变量或导入：</strong>Go 编译器不允许存在声明却没用过的局部变量或 <code>import</code>，否则直接报错。</li>
                <li><strong>花括号不能另起一行：</strong><code>func</code>、<code>if</code>、<code>for</code> 的左花括号 <code>{</code> 必须紧跟在同一行末尾。</li>
                <li><strong>修改状态记得传指针：</strong>方法如果需要修改结构体里的切片，接收者必须带星号（如 <code>func (m *Manager)</code>）。</li>
              </ul>
            </div>
          </template>
        </template>

        <!-- Mode 2: Real-time Best-Practices Code Review -->
        <template v-else-if="tutorMode === 'review'">
          <div class="tutor-Sub-block">
            <h4>🧐 当前沙盒代码规范自动审查（文件：<code>{{ selectedFilePath }}</code>）</h4>
            <div class="review-check-list">
              <div
                v-for="(item, idx) in codeReviewItems"
                :key="idx"
                class="review-item-card"
                :class="item.ok ? 'is-pass' : 'is-warn'"
              >
                <div class="review-item-head">
                  <span class="review-badge">{{ item.ok ? '✓ 已达标' : '💡 建议关注' }}</span>
                  <strong>{{ item.title }}</strong>
                </div>
                <p>{{ item.desc }}</p>
              </div>
            </div>
          </div>
        </template>

        <!-- Mode 3: Interactive 3-Question Quiz -->
        <template v-else>
          <div class="tutor-Sub-block">
            <h4>🎯 第 {{ currentDay.day }} 天核心概念快问快答（点击选项即时判题）</h4>
            <div class="quiz-list">
              <div v-for="q in currentDayQuizzes" :key="q.id" class="quiz-card">
                <strong class="quiz-q">{{ q.question }}</strong>
                <div class="quiz-options">
                  <button
                    v-for="(opt, oIdx) in q.options"
                    :key="oIdx"
                    type="button"
                    class="quiz-opt-btn"
                    :class="{
                      selected: quizAnswers[q.id] === oIdx,
                      correct: quizAnswers[q.id] !== undefined && oIdx === q.answerIndex,
                      wrong: quizAnswers[q.id] === oIdx && oIdx !== q.answerIndex,
                    }"
                    @click="quizAnswers[q.id] = oIdx"
                  >
                    <span class="opt-letter">{{ ['A', 'B', 'C'][oIdx] }}</span>
                    <span>{{ opt }}</span>
                  </button>
                </div>
                <div v-if="quizAnswers[q.id] !== undefined" class="quiz-explain" :class="quizAnswers[q.id] === q.answerIndex ? 'ok' : 'warn'">
                  <strong>{{ quizAnswers[q.id] === q.answerIndex ? '✅ 回答正确！' : '💡 正确答案是 ' + ['A', 'B', 'C'][q.answerIndex] }}</strong>
                  <p>{{ q.explanation }}</p>
                </div>
              </div>
            </div>
          </div>
        </template>

        <!-- Footer: Optional Handoff to Full Agent Studio Chat -->
        <div class="tutor-drawer-footer">
          <div class="footer-note">
            想要针对当前代码继续自由提问或让 Agent 自动帮你改代码？
          </div>
          <el-button type="primary" @click="sendToAgentStudio">
            <MessageSquarePlus :size="15" style="margin-right: 6px" />
            携带当前代码进入 Agent 会话深聊
          </el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<style scoped>
.go-studio-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 24px;
  min-width: 0;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

/* ---------- 1. Custom 4-Card KPI Strip (Zero Text Overlap) ---------- */
.studio-kpi-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 1280px) {
  .studio-kpi-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .studio-kpi-strip {
    grid-template-columns: 1fr;
  }
}

.kpi-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-surface, var(--ui-panel));
  box-shadow: var(--ds-shadow, none);
  transition: border-color 0.15s ease;
}

.kpi-card:hover {
  border-color: color-mix(in srgb, var(--ui-accent) 45%, var(--ui-border));
}

.kpi-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.kpi-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 550;
  color: var(--ui-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kpi-icon {
  color: var(--ui-muted);
  flex-shrink: 0;
}

.kpi-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--ui-border);
  background: var(--ui-raised, var(--ui-bg));
  color: var(--ui-secondary);
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

.kpi-pill.is-ok {
  border-color: rgba(16, 185, 129, 0.3);
  background: rgba(16, 185, 129, 0.12);
  color: #34d399;
}

.kpi-pill.is-warn {
  border-color: rgba(245, 158, 11, 0.3);
  background: rgba(245, 158, 11, 0.12);
  color: #fbbf24;
}

.kpi-pill.is-accent {
  border-color: color-mix(in srgb, var(--ui-accent) 35%, transparent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-family: var(--mono);
  font-weight: 600;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.kpi-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.kpi-value {
  font-size: 19px;
  font-weight: 650;
  line-height: 1.25;
  color: var(--ui-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kpi-value.ok {
  color: #34d399;
}

.kpi-value small {
  font-size: 12px;
  font-weight: 500;
  color: var(--ui-muted);
}

.kpi-sub-badge {
  padding: 2px 6px;
  border-radius: 5px;
  background: var(--ui-raised, var(--ui-bg));
  border: 1px solid var(--ui-border);
  color: var(--ui-secondary);
  font-size: 11px;
  white-space: nowrap;
  flex-shrink: 0;
}

.kpi-sub-badge.is-ok {
  border-color: rgba(16, 185, 129, 0.3);
  color: #34d399;
}

.kpi-divider {
  color: var(--ui-muted);
}

.kpi-secondary-stat {
  font-size: 13px;
  color: var(--ui-secondary);
  white-space: nowrap;
}

.kpi-foot {
  font-size: 11.5px;
  line-height: 1.4;
  color: var(--ui-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.kpi-foot code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ui-secondary);
}

.kpi-progress-track {
  height: 5px;
  border-radius: 999px;
  background: var(--ui-border);
  overflow: hidden;
  margin-top: 4px;
}

.kpi-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--ui-accent);
  transition: width 0.25s ease;
}

/* ---------- 2. Compact Toolchain Status Strip ---------- */
.toolchain-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 9px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 9px;
  background: var(--ui-surface, var(--ui-panel));
}

.toolchain-strip.is-warning {
  border-left: 3px solid #f59e0b;
}

.toolchain-items {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}

.toolchain-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ui-secondary);
  margin-right: 2px;
}

.toolchain-title.warn {
  color: #fbbf24;
}

.toolchain-desc {
  font-size: 12px;
  color: var(--ui-secondary);
}

.tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-raised, var(--ui-bg));
  font-size: 11.5px;
  color: var(--ui-secondary);
}

.tool-chip .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #10b981;
}

.tool-chip code,
.toolchain-desc code {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ui-text);
}

/* ---------- 3. Main 3-Column Studio Grid ---------- */
.studio-grid {
  display: grid;
  grid-template-columns: 236px minmax(0, 1fr) 440px;
  gap: 12px;
  align-items: start;
}

@media (max-width: 1380px) {
  .studio-grid {
    grid-template-columns: 220px minmax(0, 1fr);
  }
  .studio-right {
    grid-column: 1 / -1;
  }
}

@media (max-width: 900px) {
  .studio-grid {
    grid-template-columns: 1fr;
  }
}

.studio-sidebar,
.studio-center,
.studio-right {
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-surface, var(--ui-panel));
  overflow: hidden;
  min-width: 0;
}

/* Left Sidebar */
.sidebar-header {
  padding: 14px 14px 11px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-raised, var(--ui-bg));
}

.sidebar-title-row {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 2px;
}

.header-icon {
  color: var(--ui-accent);
}

.sidebar-header h3 {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ui-text);
}

.sidebar-sub {
  font-size: 11px;
  color: var(--ui-muted);
}

.day-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
}

.day-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 10px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ui-text);
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}

.day-card:hover {
  background: var(--ui-hover);
  border-color: var(--ui-border);
}

.day-card.active {
  border-color: color-mix(in srgb, var(--ui-accent) 38%, transparent);
  background: var(--ui-accent-soft);
  box-shadow: inset 3px 0 0 var(--ui-accent);
}

.day-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
}

.day-num {
  font-family: var(--mono);
  font-weight: 650;
  font-size: 10.5px;
  letter-spacing: 0.03em;
  color: var(--ui-accent);
}

.day-percent {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ui-muted);
}

.day-percent.done {
  color: #34d399;
  font-weight: 650;
}

.day-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--ui-text);
}

.day-deliverable {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--ui-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.day-progress-bar {
  height: 3px;
  border-radius: 999px;
  background: var(--ui-border);
  overflow: hidden;
  margin-top: 3px;
}

.day-progress-fill {
  height: 100%;
  background: var(--ui-accent);
  transition: width 0.25s ease;
}

.sidebar-footer {
  padding: 10px 12px 12px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-raised, var(--ui-bg));
}

.sandbox-path-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.path-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ui-secondary);
}

.sandbox-path-box code {
  font-size: 10px;
  font-family: var(--mono);
  color: var(--ui-muted);
  word-break: break-all;
}

/* ---------- 4. Center Panel ---------- */
.day-hero {
  padding: 16px 18px 14px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-raised, var(--ui-bg));
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.day-hero-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.hero-title-block {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.hero-meta-badges {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stage-pill {
  padding: 2px 7px;
  border-radius: 5px;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font: 600 10.5px var(--mono);
  letter-spacing: 0.04em;
}

.time-pill {
  font-size: 11.5px;
  color: var(--ui-muted);
}

.day-hero h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
  color: var(--ui-text);
  letter-spacing: -0.01em;
}

.hero-goal-box {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface, var(--ui-panel));
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--ui-secondary);
}

.hero-goal-box p {
  margin: 0;
}

.hero-goal-box strong {
  color: var(--ui-text);
}

.goal-icon {
  color: var(--ui-accent);
  flex-shrink: 0;
  margin-top: 2px;
}

.hero-bottom-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.hero-keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.kw-pill {
  padding: 2px 8px;
  border-radius: 5px;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface, var(--ui-panel));
  font-size: 11px;
  font-family: var(--mono);
  color: var(--ui-secondary);
}

.center-segmented-tabs {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px;
  border-radius: 8px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.center-segmented-tabs button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-secondary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.center-segmented-tabs button:hover {
  color: var(--ui-text);
}

.center-segmented-tabs button.active {
  background: var(--ui-surface, var(--ui-panel));
  color: var(--ui-accent);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

.center-scroll-body {
  padding: 16px 18px;
  max-height: 760px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.plain-card-section {
  padding: 16px 18px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-raised, var(--ui-bg));
}

.plain-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--ui-border);
  font-size: 12px;
  color: var(--ui-muted);
}

.plain-card-links {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Studio Markdown Polish */
.studio-markdown :deep(h1),
.studio-markdown :deep(h2),
.studio-markdown :deep(h3) {
  margin-top: 0;
  margin-bottom: 10px;
  font-size: 15px;
  font-weight: 650;
  color: var(--ui-text);
}

.studio-markdown :deep(p),
.studio-markdown :deep(li) {
  font-size: 13px;
  line-height: 1.7;
  color: var(--ui-secondary);
}

.studio-markdown :deep(ol),
.studio-markdown :deep(ul) {
  padding-left: 20px;
  margin: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.studio-markdown :deep(strong) {
  color: var(--ui-text);
  font-weight: 600;
}

.studio-markdown :deep(:not(pre) > code) {
  padding: 2px 6px;
  margin: 0 2px;
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, var(--ui-accent) 25%, var(--ui-border));
  background: color-mix(in srgb, var(--ui-accent) 10%, var(--ui-bg));
  color: var(--ui-accent);
  font-family: var(--mono);
  font-size: 12px;
}

.interactive-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.section-title-group {
  display: flex;
  align-items: center;
  gap: 7px;
}

.sec-icon {
  color: var(--ui-accent);
}

.section-head h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--ui-text);
}

.section-hint {
  font-size: 11.5px;
  color: var(--ui-muted);
}

.section-counter {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--ui-raised, var(--ui-bg));
  border: 1px solid var(--ui-border);
  font-size: 11.5px;
  color: var(--ui-secondary);
}

.checklist-grid {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.checklist-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-raised, var(--ui-bg));
  cursor: pointer;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ui-text);
  transition: all 0.15s ease;
}

.checklist-row:hover {
  border-color: color-mix(in srgb, var(--ui-accent) 45%, var(--ui-border));
}

.checklist-row input {
  display: none;
}

.check-box-ui {
  width: 17px;
  height: 17px;
  border: 1.5px solid var(--ui-muted);
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
  color: var(--ui-accent);
}

.checklist-row.checked {
  border-color: color-mix(in srgb, var(--ui-accent) 40%, transparent);
  background: var(--ui-accent-soft);
}

.checklist-row.checked .check-box-ui {
  border-color: var(--ui-accent);
}

.checklist-row.checked .check-text {
  text-decoration: line-through;
  opacity: 0.78;
}

.exercise-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.exercise-card {
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-raised, var(--ui-bg));
}

.exercise-card.done {
  border-color: rgba(16, 185, 129, 0.45);
}

.exercise-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 6px;
}

.exercise-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ui-text);
}

.level-tag {
  padding: 2px 7px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface, var(--ui-panel));
  color: var(--ui-secondary);
}

.level-tag[data-level="基础"] {
  color: #34d399;
  border-color: rgba(16, 185, 129, 0.3);
}
.level-tag[data-level="进阶"] {
  color: var(--ui-accent);
  border-color: color-mix(in srgb, var(--ui-accent) 35%, transparent);
}
.level-tag[data-level="挑战"] {
  color: #fbbf24;
  border-color: rgba(245, 158, 11, 0.35);
}

.exercise-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ui-secondary);
}

.answer-drawer {
  margin-top: 6px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 9px;
  background: var(--ui-raised, var(--ui-bg));
}

.answer-drawer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 12.5px;
  color: var(--ui-text);
}

.answer-actions {
  display: flex;
  gap: 8px;
}

.tutorial-top-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  margin-bottom: 12px;
  border-radius: 8px;
  border: 1px solid var(--ui-border);
  background: var(--ui-raised, var(--ui-bg));
  font-size: 12px;
  color: var(--ui-secondary);
}

.note-textarea {
  width: 100%;
  min-height: 280px;
  padding: 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-bg);
  color: var(--ui-text);
  font: 13px/1.65 var(--sans);
  resize: vertical;
}

/* ---------- 5. Right Sandbox IDE Panel ---------- */
.studio-right {
  display: flex;
  flex-direction: column;
}

.sandbox-toolbar {
  padding: 12px;
  border-bottom: 1px solid var(--ui-border);
  background: var(--ui-raised, var(--ui-bg));
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.snapshot-select-row {
  display: flex;
  gap: 6px;
}

.snapshot-select {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  background: var(--ui-surface, var(--ui-panel));
  color: var(--ui-text);
  font-size: 12px;
  outline: none;
}

.snapshot-select:focus {
  border-color: var(--ui-accent);
}

.right-segmented-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 3px;
  padding: 3px;
  border-radius: 8px;
  border: 1px solid var(--ui-border);
  background: var(--ui-bg);
}

.right-segmented-tabs button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-secondary);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}

.right-segmented-tabs button:hover {
  color: var(--ui-text);
}

.right-segmented-tabs button.active {
  background: var(--ui-surface, var(--ui-panel));
  color: var(--ui-accent);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

.right-panel-body {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ide-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.file-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.file-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-raised, var(--ui-bg));
  color: var(--ui-secondary);
  font: 11.5px var(--mono);
  cursor: pointer;
  transition: all 0.15s ease;
}

.file-tab-btn:hover {
  color: var(--ui-text);
}

.file-tab-btn.active {
  border-color: color-mix(in srgb, var(--ui-accent) 45%, transparent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}

.file-tab-btn.is-json {
  border-style: dashed;
}

.editor-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.dirty-dot {
  color: #fbbf24;
  font-size: 11px;
  font-weight: 600;
}

.code-editor-shell {
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  height: 400px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: #0b1120;
  overflow: hidden;
}

.line-gutter {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  padding: 12px 8px 12px 4px;
  border-right: 1px solid rgba(148, 163, 184, 0.14);
  background: rgba(15, 23, 42, 0.7);
  color: #475569;
  font: 11.5px/1.65 var(--mono);
  user-select: none;
  overflow: hidden;
}

.code-editor-textarea {
  width: 100%;
  height: 100%;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  color: #e2e8f0;
  font: 12px/1.65 var(--mono);
  resize: none;
  outline: none;
  tab-size: 4;
  overflow: auto;
}

.ide-footer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 2px;
}

.ide-meta {
  font-size: 11px;
  color: var(--ui-muted);
}

.quick-run-strip,
.runner-buttons-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.day4-cli-presets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 7px;
  background: var(--ui-raised, var(--ui-bg));
  font-size: 11px;
  color: var(--ui-secondary);
}

.terminal-box {
  min-height: 250px;
  max-height: 390px;
  overflow: auto;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: #0b1120;
  color: #e2e8f0;
  font: 11.5px/1.65 var(--mono);
}

.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
}

.terminal-badges {
  display: flex;
  gap: 6px;
}

.sim-badge {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(56, 189, 248, 0.18);
  color: #38bdf8;
  font-size: 10px;
}

.real-badge {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(16, 185, 129, 0.18);
  color: #34d399;
  font-size: 10px;
}

.exit-badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
}

.exit-badge.ok {
  background: rgba(16, 185, 129, 0.2);
  color: #34d399;
}

.exit-badge.err {
  background: rgba(239, 68, 68, 0.25);
  color: #f87171;
}

.terminal-notice {
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: 5px;
  background: rgba(245, 158, 11, 0.16);
  color: #fcd34d;
  font-family: var(--sans);
  font-size: 11px;
}

.terminal-stdout,
.terminal-stderr {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.terminal-stderr {
  color: #fca5a5;
}

.terminal-empty {
  color: #94a3b8;
  font-family: var(--sans);
  font-size: 12px;
}

.tasks-json-preview {
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-raised, var(--ui-bg));
}

.tasks-json-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  margin-bottom: 6px;
  color: var(--ui-secondary);
}

.tasks-json-preview pre {
  margin: 0;
  max-height: 150px;
  overflow: auto;
  font: 11px/1.5 var(--mono);
  color: var(--ui-text);
}

/* HTTP Debugger */
.http-presets {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preset-label {
  font-size: 11px;
  color: var(--ui-secondary);
}

.preset-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.chip-btn {
  padding: 4px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-raised, var(--ui-bg));
  color: var(--ui-text);
  font: 11px var(--mono);
  cursor: pointer;
}

.chip-btn:hover {
  border-color: var(--ui-accent);
}

.chip-btn.warn {
  border-color: rgba(245, 158, 11, 0.45);
}

.chip-btn.accent {
  border-color: var(--ui-accent);
  color: var(--ui-accent);
}

.http-composer {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.http-url-row {
  display: flex;
  gap: 6px;
}

.http-method-select {
  padding: 5px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-bg);
  color: var(--ui-text);
  font: 11.5px var(--mono);
  font-weight: 700;
}

.http-path-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-bg);
  color: var(--ui-text);
  font: 11.5px var(--mono);
}

.http-body-input {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--ui-border);
  border-radius: 6px;
  background: var(--ui-bg);
  color: var(--ui-text);
  font: 11.5px var(--mono);
}

.http-response-box {
  padding: 10px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: #0b1120;
  color: #e2e8f0;
}

.http-res-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  font-size: 11px;
}

.http-status-pill {
  padding: 2px 8px;
  border-radius: 4px;
  font-family: var(--mono);
  font-weight: 700;
}

.http-status-pill.ok {
  background: rgba(16, 185, 129, 0.2);
  color: #34d399;
}

.http-status-pill.warn {
  background: rgba(245, 158, 11, 0.2);
  color: #fbbf24;
}

.http-status-pill.err {
  background: rgba(239, 68, 68, 0.25);
  color: #f87171;
}

.http-mode-tag {
  font-size: 10.5px;
  color: #94a3b8;
}

.http-res-body {
  margin: 0;
  max-height: 160px;
  overflow: auto;
  font: 11.5px/1.55 var(--mono);
  white-space: pre-wrap;
}

.ai-tutor-bar {
  margin-top: auto;
  padding: 10px 12px;
  border-top: 1px solid var(--ui-border);
  background: var(--ui-raised, var(--ui-bg));
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.tutor-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ui-secondary);
}

.tutor-icon {
  color: var(--ui-accent);
}

.tutor-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.drawer-markdown-wrap {
  padding: 0 8px 24px;
}

/* ---------- 6. In-Studio AI Tutor Drawer ---------- */
.tutor-drawer-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 4px 24px;
}

.tutor-mode-switcher {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-bg);
}

.tutor-mode-switcher button {
  padding: 7px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--ui-secondary);
  font-size: 12.5px;
  font-weight: 550;
  cursor: pointer;
}

.tutor-mode-switcher button.active {
  background: var(--ui-surface, var(--ui-panel));
  color: var(--ui-accent);
  font-weight: 650;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
}

.tutor-status-card {
  padding: 14px 16px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-raised, var(--ui-bg));
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 12.5px;
}

.tutor-status-card.is-ok {
  border-color: rgba(16, 185, 129, 0.35);
}

.tutor-status-card.is-err {
  border-color: rgba(239, 68, 68, 0.4);
}

.tutor-status-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13.5px;
  color: #34d399;
}

.tutor-status-card.is-err .tutor-status-head {
  color: #f87171;
}

.tutor-mini-pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 7px;
  background: #0b1120;
  color: #e2e8f0;
  font: 11.5px/1.55 var(--mono);
  white-space: pre-wrap;
  max-height: 180px;
  overflow: auto;
}

.tutor-mini-pre.err {
  color: #fca5a5;
}

.tutor-hints-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.tutor-hint-item {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--ui-border);
  background: var(--ui-surface, var(--ui-panel));
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tutor-hint-item p {
  margin: 0;
  color: var(--ui-secondary);
  line-height: 1.55;
}

.tutor-hint-item .fix-line {
  color: var(--ui-text);
}

.tutor-Sub-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.tutor-Sub-block h4 {
  margin: 0;
  font-size: 13.5px;
  color: var(--ui-text);
}

.tutor-pitfall-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ui-secondary);
}

.review-check-list,
.quiz-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.review-item-card {
  padding: 11px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: var(--ui-raised, var(--ui-bg));
}

.review-item-card.is-pass {
  border-left: 3px solid #10b981;
}

.review-item-card.is-warn {
  border-left: 3px solid #f59e0b;
}

.review-item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 13px;
}

.review-badge {
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  background: var(--ui-surface, var(--ui-panel));
}

.review-item-card.is-pass .review-badge {
  color: #34d399;
}

.review-item-card.is-warn .review-badge {
  color: #fbbf24;
}

.review-item-card p {
  margin: 0;
  font-size: 12px;
  color: var(--ui-secondary);
  line-height: 1.55;
}

.quiz-card {
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 9px;
  background: var(--ui-raised, var(--ui-bg));
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.quiz-q {
  font-size: 13px;
  line-height: 1.5;
  color: var(--ui-text);
}

.quiz-options {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.quiz-opt-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 11px;
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  background: var(--ui-surface, var(--ui-panel));
  color: var(--ui-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
}

.quiz-opt-btn:hover {
  border-color: var(--ui-accent);
}

.quiz-opt-btn.correct {
  border-color: rgba(16, 185, 129, 0.55);
  background: rgba(16, 185, 129, 0.12);
}

.quiz-opt-btn.wrong {
  border-color: rgba(239, 68, 68, 0.55);
  background: rgba(239, 68, 68, 0.12);
}

.opt-letter {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background: var(--ui-raised, var(--ui-bg));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 600 11px var(--mono);
  flex-shrink: 0;
}

.quiz-explain {
  padding: 9px 11px;
  border-radius: 7px;
  font-size: 12px;
  line-height: 1.55;
}

.quiz-explain.ok {
  background: rgba(16, 185, 129, 0.12);
  color: #a7f3d0;
}

.quiz-explain.warn {
  background: rgba(245, 158, 11, 0.12);
  color: #fde68a;
}

.quiz-explain p {
  margin: 4px 0 0;
}

.tutor-drawer-footer {
  margin-top: 8px;
  padding: 12px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 9px;
  background: var(--ui-raised, var(--ui-bg));
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}

.footer-note {
  font-size: 12px;
  color: var(--ui-secondary);
}
</style>
