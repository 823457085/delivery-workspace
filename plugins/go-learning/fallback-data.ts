import type { GoDayDetail, GoDaySummary, GoLearningOverview, GoLearningProgress } from './types';

const STORAGE_KEY = 'delivery-go-learning-progress-v1';

export const FALLBACK_SNAPSHOTS: Record<string, Record<string, string>> = {
  day1: {
    'go.mod': 'module example.com/taskmgr\n\ngo 1.22\n',
    'main.go': `package main

import "fmt"

const AppName = "TaskMgr 命令行任务管理"

func formatTask(id int, title string, done bool) string {
\tstatus := "[ ] 待办"
\tif done {
\t\tstatus = "[x] 已完成"
\t}
\treturn fmt.Sprintf("#%d %s - %s", id, status, title)
}

func calcProgress(total int, doneCount int) (int, string) {
\tpending := total - doneCount
\tswitch {
\tcase total == 0:
\t\treturn 0, "暂无任务，快去添加第一条任务吧！"
\tcase pending == 0:
\t\treturn 0, "太棒了，所有任务均已完成！"
\tdefault:
\t\treturn pending, "进展顺利，继续保持！"
\t}
}

func main() {
\tfmt.Println("====================================")
\tfmt.Println("欢迎使用", AppName)
\tfmt.Println("====================================")
\tfmt.Println(formatTask(1, "安装 Go 开发环境并运行第一个程序", true))
\tfmt.Println(formatTask(2, "学习 Go 变量、循环与多返回值函数", true))
\tfmt.Println(formatTask(3, "完成第 1 天课后练习", false))
\tpending, comment := calcProgress(3, 2)
\tfmt.Println("------------------------------------")
\tfmt.Printf("统计：共 3 项，已完成 2 项，待办 %d 项\\n提示：%s\\n", pending, comment)
}
`,
  },
};

export const FALLBACK_DAYS: (GoDaySummary & { cardMarkdown: string; tutorialMarkdown: string; answerCode: string; expectedRunOutput: string })[] = [
  {
    day: 1,
    id: 'day1',
    title: '第 1 天：环境与基本语法',
    shortTitle: '环境与基本语法',
    goal: '搭建 Go 开发环境，掌握模块、包、变量、条件、循环与多返回值函数，跑通第一个程序',
    estimatedHours: '2.0～2.5 小时',
    keywords: ['go mod', 'package main', 'var 与 :=', 'for 循环', '多返回值函数'],
    deliverable: '创建 example.com/taskmgr 模块，编写单文件 main.go 打印任务列表与进度统计',
    expectedRunOutput: '====================================\n欢迎使用 TaskMgr 命令行任务管理\n====================================\n#1 [x] 已完成 - 安装 Go 开发环境并运行第一个程序\n#2 [x] 已完成 - 学习 Go 变量、循环与多返回值函数\n#3 [ ] 待办 - 完成第 1 天课后练习\n------------------------------------\n统计：共 3 项，已完成 2 项，待办 1 项\n提示： 进展顺利，继续保持！',
    cardMarkdown: `### 💡 本日大白话速懂卡片（3 分钟建立直觉）

1. **代码怎么组织？** 文件夹叫 **包（Package）**，整个项目叫 **模块（Module，靠 \`go.mod\` 识别）**。只有 \`package main\` 且包含 \`func main()\` 的文件才能直接跑起来。
2. **变量怎么声明？** 函数外用 \`var name string\`，函数内直接写 \`name := "买牛奶"\`（自动推导类型）。未赋初值的变量会自动获得安全的**零值**（\`0\` / \`""\` / \`false\`）。
3. **为什么没有 \`while\`？** Go 所有循环统一用 \`for\`：\`for i := 0; i < 3; i++\`、\`for count < 3\`、\`for {}\`。
4. **函数多返回值**：支持 \`pending, comment := calcProgress(3, 2)\`，一次返回计算结果与状态说明。`,
    tutorialMarkdown: '按本日速懂卡片和检查清单完成练习。',
    answerCode: '```go\nfunc priorityLabel(level int) string {\n\tswitch level {\n\tcase 1:\n\t\treturn "【高优】"\n\tcase 2:\n\t\treturn "【普通】"\n\tdefault:\n\t\treturn "【低优】"\n\t}\n}\n```',
    checklist: [
      { id: 'd1-c1', text: '终端执行 go version 能看到 Go 版本号（建议 Go 1.22～1.27+）' },
      { id: 'd1-c2', text: '沙盒目录下存在 go.mod 和 main.go 两个文件' },
      { id: 'd1-c3', text: '执行 go run . 能正确打印 3 条任务及统计信息，无任何报错' },
      { id: 'd1-c4', text: '理解 var 与 := 的区别，理解为什么函数能返回 (int, string) 两个值' },
    ],
    exercises: [
      { id: 'd1-e1', level: '基础', title: '实现优先级标签函数 priorityLabel', description: '编写 priorityLabel(level int) string，当 level 为 1 返回 "【高优】"，2 返回 "【普通】"，其他返回 "【低优】"。' },
      { id: 'd1-e2', level: '进阶', title: '统计 1~100 偶数和与奇数个数', description: '使用 for 循环封装 sumEvenAndCountOdd(max int) (int, int)，同时返回偶数和与奇数个数。' },
      { id: 'd1-e3', level: '挑战', title: '实现任务标题校验函数 validateTitle', description: '编写 validateTitle(title string) (bool, string)，校验空字符串与超长（>60 字节）情况。' },
    ],
  },
  {
    day: 2,
    id: 'day2',
    title: '第 2 天：组织和处理数据',
    shortTitle: '切片、Map 与指针',
    goal: '理解切片扩容机制、map 安全读写、结构体与指针传递，在内存中实现任务增删改查',
    estimatedHours: '2.5～3.0 小时',
    keywords: ['切片 Slice', 'append 扩容', 'map 与 make', '结构体 struct', '指针 * 与 &'],
    deliverable: '定义 Task 与 TaskManager 结构体，在内存中实现任务的新增、查询、完成与删除',
    expectedRunOutput: '--- 1. 新增 3 条任务后 ---\n#1 [ ] 待办 学习 Go 切片与底层数组机制\n#2 [ ] 待办 理解结构体与指针传递\n--- 2. 将任务 #1 标记为完成后 ---\n#1 [x] 已完成 学习 Go 切片与底层数组机制',
    cardMarkdown: `### 💡 本日大白话速懂卡片

- **切片（Slice）vs 数组**：切片是贴在数组车厢上的“可变取景框”，追加元素必须写 **\`s = append(s, x)\`**。
- **字典（\`map\`）**：声明后必须先 **\`make(map[int]string)\`** 才能写入，否则触发 \`panic\`。
- **结构体与指针（\`*\` / \`&\`）**：Go 默认传参是**“给复印件（值传递）”**，要修改原结构体必须传指针 **\`*Task\`**！`,
    tutorialMarkdown: '按本日速懂卡片和检查清单完成练习。',
    answerCode: '```go\nfunc resetTask(t *Task) {\n\tif t == nil {\n\t\treturn\n\t}\n\tt.Done = false\n\tt.Title = "[重置] " + t.Title\n}\n```',
    checklist: [
      { id: 'd2-c1', text: '能用自己的话解释为什么 append 必须写成 s = append(s, x)' },
      { id: 'd2-c2', text: '理解为什么 var m map[string]int 不先 make 就写入会触发 panic' },
      { id: 'd2-c3', text: '理解为什么修改结构体字段或遍历切片修改元素时需要使用指针或下标 slice[i]' },
      { id: 'd2-c4', text: '运行第 2 天代码能看到内存增、查、完成、删四个阶段的正确输出' },
    ],
    exercises: [
      { id: 'd2-e1', level: '基础', title: '使用指针重置任务状态 resetTask', description: '编写 resetTask(t *Task)，将任务的 Done 设为 false，并在标题前加上 "[重置] "。' },
      { id: 'd2-e2', level: '进阶', title: '使用 map 统计完成与待办数量', description: '编写 countByStatus(tasks []Task) map[string]int，返回 "done" 和 "pending" 的任务数。' },
      { id: 'd2-e3', level: '挑战', title: '实现按 ID 查找任务指针 findTaskByID', description: '编写 findTaskByID(mgr *TaskManager, id int) (*Task, bool)，返回原切片中元素的真实地址。' },
    ],
  },
  {
    day: 3,
    id: 'day3',
    title: '第 3 天：组织行为与处理错误',
    shortTitle: '方法、错误与接口',
    goal: '学会拆分包、定义方法接收者、显式处理 error、使用 defer 并通过 Storage 接口解耦存储',
    estimatedHours: '2.5～3.0 小时',
    keywords: ['指针接收者', 'error 与 %w', 'errors.Is', 'defer', 'Storage 接口'],
    deliverable: '拆分为 task 子包（task/task.go）与 main.go，定义哨兵错误与 Storage 接口',
    expectedRunOutput: '新增成功: #1 拆分子包 task\n[预期拦截] 标题校验未通过：任务标题不能为空\n[预期拦截] 找不到指定任务：任务不存在',
    cardMarkdown: `### 💡 本日大白话速懂卡片

- **首字母大小写决定可见性**：**大写 = Public 公开**，**小写 = Private 私有**。
- **显式 \`error\` 处理**：Go 不用 \`try/catch\`，而是把 \`error\` 作为最后一个返回值当场检查 \`if err != nil\`。
- **接口（Interface）**：不看出身只看能力（鸭子类型），只要实现了 \`Load()\` 和 \`Save()\` 就是 \`Storage\`。`,
    tutorialMarkdown: '按本日速懂卡片和检查清单完成练习。',
    answerCode: '```go\nfunc (t Task) Format() string {\n\tbox := "[ ]"\n\tif t.Done {\n\t\tbox = "[x]"\n\t}\n\treturn fmt.Sprintf("#%d %s %s", t.ID, box, t.Title)\n}\n```',
    checklist: [
      { id: 'd3-c1', text: '项目已拆分为 main.go 和 task/task.go，且包名与导出大小写正确' },
      { id: 'd3-c2', text: '理解 fmt.Errorf("...: %w", err) 包装错误与 errors.Is 判断哨兵错误的配合' },
      { id: 'd3-c3', text: '理解 defer 的后进先出与函数返回前执行机制' },
      { id: 'd3-c4', text: '理解 Storage 接口为什么能让 Manager 不依赖任何具体文件或数据库实现' },
    ],
    exercises: [
      { id: 'd3-e1', level: '基础', title: '为 Task 实现 Format() 格式化方法', description: '在 Task 上定义 (t Task) Format() string 方法，返回 "#1 [x] 标题" 格式。' },
      { id: 'd3-e2', level: '进阶', title: '新增 Rename 修改标题方法与错误校验', description: '为 Manager 增加 Rename(id int, newTitle string) error，校验空标题与 ID 不存在。' },
      { id: 'd3-e3', level: '挑战', title: '实现 MemoryStorage 内存存储满足 Storage 接口', description: '编写 MemoryStorage 结构体实现 Load() 和 Save()，验证隐式接口实现。' },
    ],
  },
  {
    day: 4,
    id: 'day4',
    title: '第 4 天：JSON 与文件',
    shortTitle: 'JSON 与安全写文件',
    goal: '掌握 JSON Struct Tag、文件读取异常处理，以及临时文件 + Rename 原子持久化',
    estimatedHours: '2.5～3.0 小时',
    keywords: ['Struct Tag', 'encoding/json', 'os.ErrNotExist', '临时文件 .tmp', 'os.Rename'],
    deliverable: '新增 task/file_storage.go 实现 FileStorage，支持 tasks.json 自动加载与安全落盘',
    expectedRunOutput: '当前共有 2 条任务（已持久化至 tasks.json）：\n#1 [x] 学习 encoding/json 编解码\n#2 [ ] 掌握文件安全写入与原子替换',
    cardMarkdown: `### 💡 本日大白话速懂卡片

- **Struct Tag**：\`json:"title"\` 是给公开字段贴的 JSON 翻译名片。
- **区分文件不存在与文件损坏**：首次运行 \`os.ErrNotExist\` 返回空切片；内容乱码必须报错阻止覆盖。
- **原子写文件**：先写 \`tasks.json.tmp\` -> \`Sync()\` -> \`Close()\` -> \`os.Rename\` 覆盖，断电也不坏账！`,
    tutorialMarkdown: '按本日速懂卡片和检查清单完成练习。',
    answerCode: '```go\ntype Task struct {\n\tID        int    `json:"id"`\n\tTitle     string `json:"title"`\n\tDone      bool   `json:"done"`\n\tCreatedAt string `json:"created_at,omitempty"`\n}\n```',
    checklist: [
      { id: 'd4-c1', text: '理解为什么结构体字段必须首字母大写才能被 encoding/json 序列化' },
      { id: 'd4-c2', text: '区分首次启动文件不存在（返回空切片）与 JSON 内容损坏（返回错误拒绝覆盖）' },
      { id: 'd4-c3', text: '理解为什么写文件要先写 .tmp、执行 Sync() 与 Close() 检查错误后再 Rename' },
      { id: 'd4-c4', text: '执行命令新增任务后，沙盒目录下生成格式良好的 tasks.json 且重启数据不丢' },
    ],
    exercises: [
      { id: 'd4-e1', level: '基础', title: '为 Task 增加 CreatedAt 字段与 omitempty 标签', description: '练习 json:"created_at,omitempty" 标签在字段为空与非空时的 JSON 输出差异。' },
      { id: 'd4-e2', level: '进阶', title: '编写损坏 JSON 恢复或备份函数', description: '当检测到 JSON 解析失败时，打印清晰错误提示而不是静默清空文件。' },
      { id: 'd4-e3', level: '挑战', title: '实现 ExportDoneTasks 导出已完成任务到独立文件', description: '筛选所有 Done == true 的任务并格式化写入 done_tasks.json。' },
    ],
  },
  {
    day: 5,
    id: 'day5',
    title: '第 5 天：HTTP 服务',
    shortTitle: 'HTTP JSON API 服务',
    goal: '使用标准库 net/http（Go 1.22+ 增强路由）实现 REST 风格任务管理 API 与状态码规范',
    estimatedHours: '2.5～3.0 小时',
    keywords: ['net/http', 'ServeMux 路由', 'r.PathValue', 'JSON 请求解析', 'HTTP 状态码'],
    deliverable: '新增 server/server.go，实现 GET/POST/PATCH/DELETE 四个 HTTP JSON 接口',
    expectedRunOutput: 'TaskMgr HTTP 服务已启动，监听地址 http://localhost:8080 (数据文件: tasks.json)',
    cardMarkdown: `### 💡 本日大白话速懂卡片

- **\`r *http.Request\` 是客人点单的菜单**：用 \`r.PathValue("id")\` 拿路径参数，用 \`json.NewDecoder(r.Body)\` 读 JSON。
- **\`w http.ResponseWriter\` 是端出去的托盘**：先设 Header，再调 \`w.WriteHeader(状态码)\`，最后写响应 JSON。`,
    tutorialMarkdown: '按本日速懂卡片和检查清单完成练习。',
    answerCode: '```go\ns.mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {\n\twriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})\n})\n```',
    checklist: [
      { id: 'd5-c1', text: '理解 http.ResponseWriter（写响应托盘）与 *http.Request（读请求菜单）的职责' },
      { id: 'd5-c2', text: '掌握 Go 1.22+ 的 "PATCH /tasks/{id}/done" 路由写法与 r.PathValue("id") 读取' },
      { id: 'd5-c3', text: '理解为什么必须先设置 Header、再调 w.WriteHeader(status)、最后写响应体' },
      { id: 'd5-c4', text: '通过 HTTP 调试器验证新增(201)、查询(200)、空标题报错(400)与不存在报错(404)' },
    ],
    exercises: [
      { id: 'd5-e1', level: '基础', title: '新增 GET /health 健康检查接口', description: '在 registerRoutes 中注册 GET /health，返回 200 OK 与 {"status":"ok"}。' },
      { id: 'd5-e2', level: '进阶', title: '新增 GET /tasks/{id} 查询单条任务详情接口', description: '解析路径参数 id，存在时返回 200 OK，不存在时返回 404 Not Found。' },
      { id: 'd5-e3', level: '挑战', title: '限制请求体大小防止恶意大 JSON 攻击', description: '使用 http.MaxBytesReader 限制 POST /tasks 请求体不超过 4KB。' },
    ],
  },
  {
    day: 6,
    id: 'day6',
    title: '第 6 天：测试与并发基础',
    shortTitle: '单元测试与并发安全',
    goal: '掌握 testing 与 httptest，理解 Goroutine、Channel 与 sync.Mutex，修复 HTTP 并发数据竞争',
    estimatedHours: '2.5～3.0 小时',
    keywords: ['sync.Mutex', 'Goroutine', 'Channel', 'testing', 'httptest', 'go test -race'],
    deliverable: '为 Manager 增加互斥锁与保存失败回滚，编写 task_test.go 与 server_test.go',
    expectedRunOutput: '=== RUN   TestManagerCRUDAndValidation\n--- PASS: TestManagerCRUDAndValidation (0.00s)\n=== RUN   TestTaskServerEndToEnd\n--- PASS: TestTaskServerEndToEnd (0.00s)\nPASS',
    cardMarkdown: `### 💡 本日大白话速懂卡片

- **HTTP 天然并发**：\`net/http\` 每收到一个请求都会开启独立的 **Goroutine（兼职快递员）**。
- **\`sync.Mutex\`（单人洗手间门锁）**：保护共享内存 \`m.tasks\` 和文件写入，进门 \`Lock()\`，出门 \`defer Unlock()\`。
- **\`List()\` 必须返回拷贝副本**：防止锁释放后外部序列化与内部修改撞车。`,
    tutorialMarkdown: '按本日速懂卡片和检查清单完成练习。',
    answerCode: '```go\nm.mu.Lock()\ndefer m.mu.Unlock()\nresult := make([]Task, len(m.tasks))\ncopy(result, m.tasks)\nreturn result\n```',
    checklist: [
      { id: 'd6-c1', text: '能清楚说明为什么 HTTP 服务的每个请求在独立 Goroutine 中运行会导致数据竞争' },
      { id: 'd6-c2', text: '理解为什么 List() 必须在持有锁时 copy 一份切片副本返回，而不能直接返回 m.tasks' },
      { id: 'd6-c3', text: '理解当文件 Save 失败时，为什么要保持或回滚内存状态以保证内存与磁盘一致' },
      { id: 'd6-c4', text: '运行 go test -v -cover ./... 全部 PASS，并理解 go test -race 的作用与 CGO 限制' },
    ],
    exercises: [
      { id: 'd6-e1', level: '基础', title: '为空标题与非法 ID 编写表格驱动测试（Table-Driven Test）', description: '使用 []struct{ name string; input string; wantErr error } 组织多组测试输入。' },
      { id: 'd6-e2', level: '进阶', title: '使用 Channel 实现并发任务结果汇总小示例', description: '开启 3 个 Goroutine 模拟耗时计算，通过带缓冲 Channel 收集结果。' },
      { id: 'd6-e3', level: '挑战', title: '编写 Mock FailingStorage 测试保存失败时的内存回滚', description: '实现一个故意在 Save 时返回错误的 Storage，验证 Complete 失败后 Done 状态已回滚。' },
    ],
  },
  {
    day: 7,
    id: 'day7',
    title: '第 7 天：整合与独立练习',
    shortTitle: '工程整合与结业实战',
    goal: '汇总完整项目，掌握 gofmt/go vet/go test 工程化验证与排错，独立实现按状态筛选功能',
    estimatedHours: '2.0～3.0 小时',
    keywords: ['gofmt', 'go vet', '故障排查', 'URL Query 筛选', '结业验收'],
    deliverable: '通过 6 项结业验收，独立为 GET /tasks?done=true|false 增加按状态筛选功能并补齐测试',
    expectedRunOutput: '[工程化体检通过]\n1. gofmt -s -w . -> 格式规范\n2. go vet ./... -> 静态检查通过\n3. go test -v ./... -> 全部 PASS',
    cardMarkdown: `### 💡 本日大白话速懂卡片

- **三层清晰架构**：\`task/\` 管业务与文件落盘，\`server/\` 管 HTTP 路由与状态码，\`main.go\` 负责插电组装。
- **结业独立挑战**：为 \`GET /tasks\` 增加 \`?done=true|false\` 查询参数筛选，并为非法参数返回 \`400 Bad Request\`。`,
    tutorialMarkdown: '按本日速懂卡片和检查清单完成练习。',
    answerCode: '```go\nfunc (m *Manager) ListByStatus(done bool) []Task {\n\tm.mu.Lock()\n\tdefer m.mu.Unlock()\n\tresult := make([]Task, 0)\n\tfor _, t := range m.tasks {\n\t\tif t.Done == done {\n\t\t\tresult = append(result, t)\n\t\t}\n\t}\n\treturn result\n}\n```',
    checklist: [
      { id: 'd7-c1', text: '完成结业验收 1~3：启动服务完成增删改查、重启后恢复数据、无效输入返回 400/404' },
      { id: 'd7-c2', text: '完成结业验收 4~5：运行核心测试并能解释测试覆盖的行为，能说明并发锁保护原因' },
      { id: 'd7-c3', text: '独立在 task.go 中实现 ListByStatus(done bool) 并在 server.go 中支持 ?done=true|false' },
      { id: 'd7-c4', text: '在 server_test.go 中为按状态筛选功能补充单元测试并运行通过' },
    ],
    exercises: [
      { id: 'd7-e1', level: '基础', title: '结业步骤 1：在 Manager 中新增 ListByStatus(done bool) 方法', description: '加锁遍历 m.tasks，筛选 t.Done == done 的任务放入新切片返回。' },
      { id: 'd7-e2', level: '进阶', title: '结业步骤 2：在 handleListTasks 中解析 ?done= 查询参数', description: '使用 r.URL.Query().Get("done") 支持 true、false，非法值返回 400 Bad Request。' },
      { id: 'd7-e3', level: '挑战', title: '结业步骤 3：编写 TestTaskServerFilterByDone 单元测试', description: '使用 httptest 验证 /tasks?done=true、/tasks?done=false 与 /tasks?done=invalid。' },
    ],
  },
];

export function loadLocalFallbackOverview(day = 1): GoLearningOverview {
  let progress: GoLearningProgress = {
    currentDay: day,
    activeSnapshot: `day${day}`,
    checkedItems: [],
    completedExercises: [],
    notes: {},
    updatedAt: new Date().toISOString(),
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      progress = { ...progress, ...saved, currentDay: day || saved.currentDay || 1 };
    }
  } catch {
    // Ignore storage read error
  }

  const targetDay = FALLBACK_DAYS.find(d => d.day === progress.currentDay) || FALLBACK_DAYS[0]!;
  const currentDayDetail: GoDayDetail = { ...targetDay };
  const files = Object.entries(FALLBACK_SNAPSHOTS.day1!).map(([path, content]) => ({
    path,
    content,
    size: content.length,
    updatedAt: new Date().toISOString(),
  }));

  return {
    environment: {
      installed: false,
      version: '前端离线演练模式（重启工作台后端后自动连接本地沙盒）',
      goBinaryPath: '',
      goproxy: '未检测',
      cgoEnabled: '1',
      installHint: '重启工作台服务后即可解锁完整本地沙盒文件读写。',
      port8080Listening: false,
    },
    sandboxPath: '',
    docsPath: '',
    progress,
    days: FALLBACK_DAYS.map(({ cardMarkdown: _c, tutorialMarkdown: _t, answerCode: _a, expectedRunOutput: _e, ...s }) => s),
    currentDayDetail,
    sandboxFiles: files,
    tasksJsonContent: null,
    guideMarkdown: '# 《7 天上手 Go》通俗图解导读\n\n沿左侧路线依次学习七个章节，再按每章清单练习和自测。',
    cheatSheetMarkdown: '# Go 核心语法与命令速查表\n\n- `go mod init <module>`：初始化模块\n- `go run .`：直接编译并运行\n- `go test -v -cover ./...`：运行全部单元测试并统计覆盖率\n- `go test -race ./...`：开启并发数据竞争检测\n- `gofmt -s -w .`：按官方标准格式化代码',
  };
}

export function saveLocalFallbackProgress(progress: GoLearningProgress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Ignore storage write error
  }
}
