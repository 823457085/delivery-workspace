import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
//#region plugins/go-learning/curriculum.ts
var GO_SANDBOX_SNAPSHOTS = {
	"day1": {
		"go.mod": "module example.com/taskmgr\n\ngo 1.22\n",
		"main.go": "package main\n\nimport \"fmt\"\n\n// AppName 定义程序名称常量\nconst AppName = \"TaskMgr 命令行任务管理\"\n\n// formatTask 将单个任务的字段格式化为易读的单行字符串\nfunc formatTask(id int, title string, done bool) string {\n	status := \"[ ] 待办\"\n	if done {\n		status = \"[x] 已完成\"\n	}\n	return fmt.Sprintf(\"#%d %s - %s\", id, status, title)\n}\n\n// calcProgress 计算未完成数量并返回进度评价（演示多返回值函数）\nfunc calcProgress(total int, doneCount int) (int, string) {\n	pending := total - doneCount\n	switch {\n	case total == 0:\n		return 0, \"暂无任务，快去添加第一条任务吧！\"\n	case pending == 0:\n		return 0, \"太棒了，所有任务均已完成！\"\n	case doneCount == 0:\n		return pending, \"万事开头难，先完成手头第一件事吧！\"\n	default:\n		return pending, \"进展顺利，继续保持！\"\n	}\n}\n\nfunc main() {\n	fmt.Println(\"====================================\")\n	fmt.Println(\"欢迎使用\", AppName)\n	fmt.Println(\"====================================\")\n\n	totalTasks := 3\n	doneCount := 0\n\n	// 使用 for 循环模拟遍历 3 条任务（第 2 天我们将改用切片和结构体存储）\n	for id := 1; id <= totalTasks; id++ {\n		var title string\n		var done bool\n\n		switch id {\n		case 1:\n			title = \"安装 Go 开发环境并运行第一个程序\"\n			done = true\n		case 2:\n			title = \"学习 Go 变量、循环与多返回值函数\"\n			done = true\n		case 3:\n			title = \"完成第 1 天课后练习\"\n			done = false\n		}\n\n		if done {\n			doneCount++\n		}\n\n		line := formatTask(id, title, done)\n		fmt.Println(line)\n	}\n\n	pending, comment := calcProgress(totalTasks, doneCount)\n	fmt.Println(\"------------------------------------\")\n	fmt.Printf(\"统计：共 %d 项，已完成 %d 项，待办 %d 项\\n\", totalTasks, doneCount, pending)\n	fmt.Println(\"提示：\", comment)\n}\n"
	},
	"day2": {
		"go.mod": "module example.com/taskmgr\n\ngo 1.22\n",
		"main.go": "package main\n\nimport \"fmt\"\n\n// Task 表示单条任务的数据结构\ntype Task struct {\n	ID    int\n	Title string\n	Done  bool\n}\n\n// TaskManager 在内存中管理任务切片与下一个自增 ID\ntype TaskManager struct {\n	tasks  []Task\n	nextID int\n}\n\n// newTaskManager 创建并初始化一个 TaskManager 指针\nfunc newTaskManager() *TaskManager {\n	return &TaskManager{\n		tasks:  make([]Task, 0),\n		nextID: 1,\n	}\n}\n\n// addTask 新增一条任务（注意 m 必须是指针 *TaskManager，否则对 tasks 和 nextID 的修改不会生效）\nfunc addTask(m *TaskManager, title string) Task {\n	t := Task{\n		ID:    m.nextID,\n		Title: title,\n		Done:  false,\n	}\n	m.tasks = append(m.tasks, t)\n	m.nextID++\n	return t\n}\n\n// listTasks 返回当前所有任务\nfunc listTasks(m *TaskManager) []Task {\n	return m.tasks\n}\n\n// completeTask 根据 ID 查找任务并标记为已完成，成功返回 true，未找到返回 false\nfunc completeTask(m *TaskManager, id int) bool {\n	// 注意：for _, t := range m.tasks 中的 t 是元素的拷贝！\n	// 要修改原切片中的元素，必须通过下标 m.tasks[i] 修改\n	for i := range m.tasks {\n		if m.tasks[i].ID == id {\n			m.tasks[i].Done = true\n			return true\n		}\n	}\n	return false\n}\n\n// deleteTask 根据 ID 删除任务，成功返回 true，未找到返回 false\nfunc deleteTask(m *TaskManager, id int) bool {\n	for i, t := range m.tasks {\n		if t.ID == id {\n			// 将第 i 个元素前后的切片拼接起来，实现删除\n			m.tasks = append(m.tasks[:i], m.tasks[i+1:]...)\n			return true\n		}\n	}\n	return false\n}\n\n// printTasks 辅助打印当前任务列表\nfunc printTasks(stepName string, tasks []Task) {\n	fmt.Printf(\"\\n--- %s（共 %d 条）---\\n\", stepName, len(tasks))\n	if len(tasks) == 0 {\n		fmt.Println(\"（空）\")\n		return\n	}\n	for _, t := range tasks {\n		status := \"[ ] 待办\"\n		if t.Done {\n			status = \"[x] 已完成\"\n		}\n		fmt.Printf(\"#%d %s %s\\n\", t.ID, status, t.Title)\n	}\n}\n\nfunc main() {\n	manager := newTaskManager()\n\n	// 1. 新增 3 条任务\n	addTask(manager, \"学习 Go 切片与底层数组机制\")\n	addTask(manager, \"理解结构体与指针传递\")\n	addTask(manager, \"清理临时测试任务\")\n	printTasks(\"1. 新增 3 条任务后\", listTasks(manager))\n\n	// 2. 将第 1 条任务标记为完成\n	ok := completeTask(manager, 1)\n	fmt.Printf(\"\\n操作：标记任务 #1 完成 -> 结果: %v\\n\", ok)\n	printTasks(\"2. 完成任务 #1 后\", listTasks(manager))\n\n	// 3. 删除第 3 条任务，并尝试删除不存在的第 99 条任务\n	delOk1 := deleteTask(manager, 3)\n	delOk2 := deleteTask(manager, 99)\n	fmt.Printf(\"\\n操作：删除任务 #3 -> 结果: %v | 删除任务 #99 -> 结果: %v\\n\", delOk1, delOk2)\n	printTasks(\"3. 删除任务 #3 后\", listTasks(manager))\n}\n"
	},
	"day3": {
		"go.mod": "module example.com/taskmgr\n\ngo 1.22\n",
		"main.go": "package main\n\nimport (\n	\"errors\"\n	\"fmt\"\n\n	\"example.com/taskmgr/task\"\n)\n\nfunc main() {\n	// 使用 defer 注册函数退出前的收尾提示\n	defer fmt.Println(\"\\n[defer] main 函数执行完毕，程序安全退出。\")\n\n	// 第 3 天暂传 nil，使用纯内存模式\n	mgr, err := task.NewManager(nil)\n	if err != nil {\n		fmt.Println(\"初始化失败:\", err)\n		return\n	}\n\n	// 1. 正常添加两条任务\n	t1, err := mgr.Add(\"重构代码到独立的 task 子包\")\n	if err != nil {\n		fmt.Println(\"添加失败:\", err)\n		return\n	}\n	t2, _ := mgr.Add(\"学习 error 显式处理与 errors.Is\")\n	fmt.Printf(\"成功添加任务: #%d [%s], #%d [%s]\\n\", t1.ID, t1.Title, t2.ID, t2.Title)\n\n	// 2. 故意传入空白标题，验证错误拦截\n	_, err = mgr.Add(\"   \")\n	if errors.Is(err, task.ErrInvalidTitle) {\n		fmt.Println(\"预期内拦截到无效输入:\", err)\n	}\n\n	// 3. 正常完成任务 #1，并故意尝试完成不存在的任务 #99\n	doneTask, err := mgr.Complete(1)\n	if err == nil {\n		fmt.Printf(\"任务 #%d 已标记完成 (Done=%v)\\n\", doneTask.ID, doneTask.Done)\n	}\n\n	_, err = mgr.Complete(99)\n	if errors.Is(err, task.ErrNotFound) {\n		fmt.Println(\"预期内拦截到未找到错误:\", err)\n	}\n\n	// 4. 打印最终任务列表\n	fmt.Println(\"\\n当前任务列表：\")\n	for _, t := range mgr.List() {\n		fmt.Printf(\"- #%d [Done=%v] %s\\n\", t.ID, t.Done, t.Title)\n	}\n}\n",
		"task/task.go": "package task\n\nimport (\n	\"errors\"\n	\"fmt\"\n	\"strings\"\n)\n\n// 定义导出的哨兵错误，供调用方使用 errors.Is 进行判断\nvar (\n	ErrNotFound     = errors.New(\"任务不存在\")\n	ErrInvalidTitle = errors.New(\"任务标题不能为空\")\n)\n\n// Task 表示单条任务（字段首字母大写，确保包外可访问）\ntype Task struct {\n	ID    int\n	Title string\n	Done  bool\n}\n\n// Storage 定义任务持久化的最小契约接口\n// 第 3 天可传入 nil 表示仅使用内存；第 4 天我们将提供 JSON 文件实现\ntype Storage interface {\n	Load() ([]Task, error)\n	Save(tasks []Task) error\n}\n\n// Manager 负责管理任务的增删改查（内部字段小写私有，防止外部直接篡改）\ntype Manager struct {\n	tasks   []Task\n	nextID  int\n	storage Storage\n}\n\n// NewManager 创建并初始化任务管理器\n// 如果传入了非 nil 的 storage，则自动从中加载已有任务并计算下一个自增 ID\nfunc NewManager(storage Storage) (*Manager, error) {\n	loaded := make([]Task, 0)\n	if storage != nil {\n		var err error\n		loaded, err = storage.Load()\n		if err != nil {\n			return nil, fmt.Errorf(\"初始化加载任务失败: %w\", err)\n		}\n	}\n\n	nextID := 1\n	for _, t := range loaded {\n		if t.ID >= nextID {\n			nextID = t.ID + 1\n		}\n	}\n\n	return &Manager{\n		tasks:   loaded,\n		nextID:  nextID,\n		storage: storage,\n	}, nil\n}\n\n// save 是包内私有辅助方法：当配置了 storage 时触发持久化保存\nfunc (m *Manager) save() error {\n	if m.storage == nil {\n		return nil\n	}\n	if err := m.storage.Save(m.tasks); err != nil {\n		return fmt.Errorf(\"保存任务数据失败: %w\", err)\n	}\n	return nil\n}\n\n// Add 校验标题并新增一条任务\nfunc (m *Manager) Add(title string) (Task, error) {\n	cleanTitle := strings.TrimSpace(title)\n	if cleanTitle == \"\" {\n		return Task{}, ErrInvalidTitle\n	}\n\n	newTask := Task{\n		ID:    m.nextID,\n		Title: cleanTitle,\n		Done:  false,\n	}\n	m.tasks = append(m.tasks, newTask)\n	m.nextID++\n\n	if err := m.save(); err != nil {\n		return Task{}, err\n	}\n	return newTask, nil\n}\n\n// List 返回当前所有任务的副本切片，防止外部修改内部切片\nfunc (m *Manager) List() []Task {\n	result := make([]Task, len(m.tasks))\n	copy(result, m.tasks)\n	return result\n}\n\n// Complete 根据 ID 将任务标记为已完成\nfunc (m *Manager) Complete(id int) (Task, error) {\n	for i := range m.tasks {\n		if m.tasks[i].ID == id {\n			m.tasks[i].Done = true\n			if err := m.save(); err != nil {\n				return Task{}, err\n			}\n			return m.tasks[i], nil\n		}\n	}\n	return Task{}, fmt.Errorf(\"完成任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n\n// Delete 根据 ID 删除任务\nfunc (m *Manager) Delete(id int) error {\n	for i, t := range m.tasks {\n		if t.ID == id {\n			m.tasks = append(m.tasks[:i], m.tasks[i+1:]...)\n			return m.save()\n		}\n	}\n	return fmt.Errorf(\"删除任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n"
	},
	"day4": {
		"go.mod": "module example.com/taskmgr\n\ngo 1.22\n",
		"main.go": "package main\n\nimport (\n	\"fmt\"\n	\"os\"\n	\"strconv\"\n	\"strings\"\n\n	\"example.com/taskmgr/task\"\n)\n\nconst defaultDataFile = \"tasks.json\"\n\nfunc printUsage() {\n	fmt.Println(\"用法:\")\n	fmt.Println(\"  go run . add <任务标题>    新增任务\")\n	fmt.Println(\"  go run . list              查看所有任务\")\n	fmt.Println(\"  go run . done <任务ID>     将任务标记为已完成\")\n	fmt.Println(\"  go run . delete <任务ID>   删除指定任务\")\n}\n\nfunc main() {\n	storage := task.NewFileStorage(defaultDataFile)\n	mgr, err := task.NewManager(storage)\n	if err != nil {\n		fmt.Fprintf(os.Stderr, \"启动失败: %v\\n\", err)\n		os.Exit(1)\n	}\n\n	if len(os.Args) < 2 {\n		printUsage()\n		return\n	}\n\n	cmd := os.Args[1]\n	switch cmd {\n	case \"add\":\n		title := strings.Join(os.Args[2:], \" \")\n		t, err := mgr.Add(title)\n		if err != nil {\n			fmt.Fprintf(os.Stderr, \"新增失败: %v\\n\", err)\n			os.Exit(1)\n		}\n		fmt.Printf(\"已新增任务 #%d: %s\\n\", t.ID, t.Title)\n\n	case \"list\":\n		tasks := mgr.List()\n		if len(tasks) == 0 {\n			fmt.Println(\"当前没有任何任务。\")\n			return\n		}\n		for _, t := range tasks {\n			status := \"[ ]\"\n			if t.Done {\n				status = \"[x]\"\n			}\n			fmt.Printf(\"#%d %s %s\\n\", t.ID, status, t.Title)\n		}\n\n	case \"done\":\n		if len(os.Args) < 3 {\n			fmt.Fprintln(os.Stderr, \"请提供要完成的任务 ID，例如: go run . done 1\")\n			os.Exit(1)\n		}\n		id, err := strconv.Atoi(os.Args[2])\n		if err != nil {\n			fmt.Fprintf(os.Stderr, \"无效的任务 ID %q: 必须是整数\\n\", os.Args[2])\n			os.Exit(1)\n		}\n		t, err := mgr.Complete(id)\n		if err != nil {\n			fmt.Fprintf(os.Stderr, \"操作失败: %v\\n\", err)\n			os.Exit(1)\n		}\n		fmt.Printf(\"已完成任务 #%d: %s\\n\", t.ID, t.Title)\n\n	case \"delete\":\n		if len(os.Args) < 3 {\n			fmt.Fprintln(os.Stderr, \"请提供要删除的任务 ID，例如: go run . delete 1\")\n			os.Exit(1)\n		}\n		id, err := strconv.Atoi(os.Args[2])\n		if err != nil {\n			fmt.Fprintf(os.Stderr, \"无效的任务 ID %q: 必须是整数\\n\", os.Args[2])\n			os.Exit(1)\n		}\n		if err := mgr.Delete(id); err != nil {\n			fmt.Fprintf(os.Stderr, \"操作失败: %v\\n\", err)\n			os.Exit(1)\n		}\n		fmt.Printf(\"已删除任务 #%d\\n\", id)\n\n	default:\n		fmt.Fprintf(os.Stderr, \"未知命令: %s\\n\", cmd)\n		printUsage()\n		os.Exit(1)\n	}\n}\n",
		"task/task.go": "package task\n\nimport (\n	\"errors\"\n	\"fmt\"\n	\"strings\"\n)\n\nvar (\n	ErrNotFound     = errors.New(\"任务不存在\")\n	ErrInvalidTitle = errors.New(\"任务标题不能为空\")\n)\n\n// Task 表示单条任务，带有 JSON 序列化标签\ntype Task struct {\n	ID    int    `json:\"id\"`\n	Title string `json:\"title\"`\n	Done  bool   `json:\"done\"`\n}\n\n// Storage 定义任务持久化的最小契约接口\ntype Storage interface {\n	Load() ([]Task, error)\n	Save(tasks []Task) error\n}\n\n// Manager 负责管理任务的增删改查\ntype Manager struct {\n	tasks   []Task\n	nextID  int\n	storage Storage\n}\n\n// NewManager 创建并初始化任务管理器\nfunc NewManager(storage Storage) (*Manager, error) {\n	loaded := make([]Task, 0)\n	if storage != nil {\n		var err error\n		loaded, err = storage.Load()\n		if err != nil {\n			return nil, fmt.Errorf(\"初始化加载任务失败: %w\", err)\n		}\n	}\n\n	nextID := 1\n	for _, t := range loaded {\n		if t.ID >= nextID {\n			nextID = t.ID + 1\n		}\n	}\n\n	return &Manager{\n		tasks:   loaded,\n		nextID:  nextID,\n		storage: storage,\n	}, nil\n}\n\nfunc (m *Manager) save() error {\n	if m.storage == nil {\n		return nil\n	}\n	if err := m.storage.Save(m.tasks); err != nil {\n		return fmt.Errorf(\"保存任务数据失败: %w\", err)\n	}\n	return nil\n}\n\nfunc (m *Manager) Add(title string) (Task, error) {\n	cleanTitle := strings.TrimSpace(title)\n	if cleanTitle == \"\" {\n		return Task{}, ErrInvalidTitle\n	}\n\n	newTask := Task{\n		ID:    m.nextID,\n		Title: cleanTitle,\n		Done:  false,\n	}\n	m.tasks = append(m.tasks, newTask)\n	m.nextID++\n\n	if err := m.save(); err != nil {\n		return Task{}, err\n	}\n	return newTask, nil\n}\n\nfunc (m *Manager) List() []Task {\n	result := make([]Task, len(m.tasks))\n	copy(result, m.tasks)\n	return result\n}\n\nfunc (m *Manager) Complete(id int) (Task, error) {\n	for i := range m.tasks {\n		if m.tasks[i].ID == id {\n			m.tasks[i].Done = true\n			if err := m.save(); err != nil {\n				return Task{}, err\n			}\n			return m.tasks[i], nil\n		}\n	}\n	return Task{}, fmt.Errorf(\"完成任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n\nfunc (m *Manager) Delete(id int) error {\n	for i, t := range m.tasks {\n		if t.ID == id {\n			m.tasks = append(m.tasks[:i], m.tasks[i+1:]...)\n			return m.save()\n		}\n	}\n	return fmt.Errorf(\"删除任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n",
		"task/file_storage.go": "package task\n\nimport (\n	\"bytes\"\n	\"encoding/json\"\n	\"errors\"\n	\"fmt\"\n	\"os\"\n)\n\n// FileStorage 实现 Storage 接口，将任务列表持久化到 JSON 文件\ntype FileStorage struct {\n	filePath string\n}\n\n// NewFileStorage 创建基于指定文件路径的 JSON 存储实例\nfunc NewFileStorage(filePath string) *FileStorage {\n	return &FileStorage{filePath: filePath}\n}\n\n// Load 从 JSON 文件加载任务列表\n// - 若文件不存在或为空文件，返回空切片且不报错\n// - 若 JSON 内容损坏，返回明确错误以防止静默覆盖原文件\nfunc (s *FileStorage) Load() ([]Task, error) {\n	data, err := os.ReadFile(s.filePath)\n	if err != nil {\n		if errors.Is(err, os.ErrNotExist) {\n			return []Task{}, nil\n		}\n		return nil, fmt.Errorf(\"读取任务文件 %s 失败: %w\", s.filePath, err)\n	}\n\n	if len(bytes.TrimSpace(data)) == 0 {\n		return []Task{}, nil\n	}\n\n	var tasks []Task\n	if err := json.Unmarshal(data, &tasks); err != nil {\n		return nil, fmt.Errorf(\"解析任务文件 %s 的 JSON 内容失败(文件可能已损坏): %w\", s.filePath, err)\n	}\n\n	if tasks == nil {\n		return []Task{}, nil\n	}\n	return tasks, nil\n}\n\n// Save 将任务列表安全写入 JSON 文件\n// 采用“写临时文件 -> Sync 刷盘 -> 显式检查 Close 错误 -> Rename 原子替换”策略\nfunc (s *FileStorage) Save(tasks []Task) error {\n	data, err := json.MarshalIndent(tasks, \"\", \"  \")\n	if err != nil {\n		return fmt.Errorf(\"序列化任务列表为 JSON 失败: %w\", err)\n	}\n	data = append(data, '\\n')\n\n	tmpPath := s.filePath + \".tmp\"\n	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)\n	if err != nil {\n		return fmt.Errorf(\"创建临时文件 %s 失败: %w\", tmpPath, err)\n	}\n\n	// 若后续步骤出错，确保关闭文件句柄并清理残留的临时文件\n	writeErr := func() error {\n		if _, err := f.Write(data); err != nil {\n			_ = f.Close()\n			return fmt.Errorf(\"写入数据到临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		if err := f.Sync(); err != nil {\n			_ = f.Close()\n			return fmt.Errorf(\"刷盘临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		if err := f.Close(); err != nil {\n			return fmt.Errorf(\"关闭临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		return nil\n	}()\n\n	if writeErr != nil {\n		_ = os.Remove(tmpPath)\n		return writeErr\n	}\n\n	if err := os.Rename(tmpPath, s.filePath); err != nil {\n		_ = os.Remove(tmpPath)\n		return fmt.Errorf(\"替换任务文件 %s 失败: %w\", s.filePath, err)\n	}\n\n	return nil\n}\n"
	},
	"day5": {
		"go.mod": "module example.com/taskmgr\n\ngo 1.22\n",
		"main.go": "package main\n\nimport (\n	\"fmt\"\n	\"log\"\n	\"net/http\"\n	\"os\"\n\n	\"example.com/taskmgr/server\"\n	\"example.com/taskmgr/task\"\n)\n\nfunc main() {\n	dataFile := \"tasks.json\"\n	if envFile := os.Getenv(\"TASK_FILE\"); envFile != \"\" {\n		dataFile = envFile\n	}\n\n	addr := \"127.0.0.1:8080\"\n	if envAddr := os.Getenv(\"TASK_ADDR\"); envAddr != \"\" {\n		addr = envAddr\n	}\n\n	storage := task.NewFileStorage(dataFile)\n	mgr, err := task.NewManager(storage)\n	if err != nil {\n		log.Fatalf(\"初始化任务管理器失败: %v\", err)\n	}\n\n	srv := server.NewTaskServer(mgr)\n	fmt.Printf(\"TaskMgr HTTP 服务已启动，监听地址 http://localhost%s (数据文件: %s)\\n\", addr, dataFile)\n	if err := http.ListenAndServe(addr, srv); err != nil {\n		log.Fatalf(\"HTTP 服务异常退出: %v\", err)\n	}\n}\n",
		"task/task.go": "package task\n\nimport (\n	\"errors\"\n	\"fmt\"\n	\"strings\"\n)\n\nvar (\n	ErrNotFound     = errors.New(\"任务不存在\")\n	ErrInvalidTitle = errors.New(\"任务标题不能为空\")\n)\n\n// Task 表示单条任务，带有 JSON 序列化标签\ntype Task struct {\n	ID    int    `json:\"id\"`\n	Title string `json:\"title\"`\n	Done  bool   `json:\"done\"`\n}\n\n// Storage 定义任务持久化的最小契约接口\ntype Storage interface {\n	Load() ([]Task, error)\n	Save(tasks []Task) error\n}\n\n// Manager 负责管理任务的增删改查\ntype Manager struct {\n	tasks   []Task\n	nextID  int\n	storage Storage\n}\n\n// NewManager 创建并初始化任务管理器\nfunc NewManager(storage Storage) (*Manager, error) {\n	loaded := make([]Task, 0)\n	if storage != nil {\n		var err error\n		loaded, err = storage.Load()\n		if err != nil {\n			return nil, fmt.Errorf(\"初始化加载任务失败: %w\", err)\n		}\n	}\n\n	nextID := 1\n	for _, t := range loaded {\n		if t.ID >= nextID {\n			nextID = t.ID + 1\n		}\n	}\n\n	return &Manager{\n		tasks:   loaded,\n		nextID:  nextID,\n		storage: storage,\n	}, nil\n}\n\nfunc (m *Manager) save() error {\n	if m.storage == nil {\n		return nil\n	}\n	if err := m.storage.Save(m.tasks); err != nil {\n		return fmt.Errorf(\"保存任务数据失败: %w\", err)\n	}\n	return nil\n}\n\nfunc (m *Manager) Add(title string) (Task, error) {\n	cleanTitle := strings.TrimSpace(title)\n	if cleanTitle == \"\" {\n		return Task{}, ErrInvalidTitle\n	}\n\n	newTask := Task{\n		ID:    m.nextID,\n		Title: cleanTitle,\n		Done:  false,\n	}\n	m.tasks = append(m.tasks, newTask)\n	m.nextID++\n\n	if err := m.save(); err != nil {\n		return Task{}, err\n	}\n	return newTask, nil\n}\n\nfunc (m *Manager) List() []Task {\n	result := make([]Task, len(m.tasks))\n	copy(result, m.tasks)\n	return result\n}\n\nfunc (m *Manager) Complete(id int) (Task, error) {\n	for i := range m.tasks {\n		if m.tasks[i].ID == id {\n			m.tasks[i].Done = true\n			if err := m.save(); err != nil {\n				return Task{}, err\n			}\n			return m.tasks[i], nil\n		}\n	}\n	return Task{}, fmt.Errorf(\"完成任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n\nfunc (m *Manager) Delete(id int) error {\n	for i, t := range m.tasks {\n		if t.ID == id {\n			m.tasks = append(m.tasks[:i], m.tasks[i+1:]...)\n			return m.save()\n		}\n	}\n	return fmt.Errorf(\"删除任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n",
		"task/file_storage.go": "package task\n\nimport (\n	\"bytes\"\n	\"encoding/json\"\n	\"errors\"\n	\"fmt\"\n	\"os\"\n)\n\n// FileStorage 实现 Storage 接口，将任务列表持久化到 JSON 文件\ntype FileStorage struct {\n	filePath string\n}\n\n// NewFileStorage 创建基于指定文件路径的 JSON 存储实例\nfunc NewFileStorage(filePath string) *FileStorage {\n	return &FileStorage{filePath: filePath}\n}\n\n// Load 从 JSON 文件加载任务列表\n// - 若文件不存在或为空文件，返回空切片且不报错\n// - 若 JSON 内容损坏，返回明确错误以防止静默覆盖原文件\nfunc (s *FileStorage) Load() ([]Task, error) {\n	data, err := os.ReadFile(s.filePath)\n	if err != nil {\n		if errors.Is(err, os.ErrNotExist) {\n			return []Task{}, nil\n		}\n		return nil, fmt.Errorf(\"读取任务文件 %s 失败: %w\", s.filePath, err)\n	}\n\n	if len(bytes.TrimSpace(data)) == 0 {\n		return []Task{}, nil\n	}\n\n	var tasks []Task\n	if err := json.Unmarshal(data, &tasks); err != nil {\n		return nil, fmt.Errorf(\"解析任务文件 %s 的 JSON 内容失败(文件可能已损坏): %w\", s.filePath, err)\n	}\n\n	if tasks == nil {\n		return []Task{}, nil\n	}\n	return tasks, nil\n}\n\n// Save 将任务列表安全写入 JSON 文件\n// 采用“写临时文件 -> Sync 刷盘 -> 显式检查 Close 错误 -> Rename 原子替换”策略\nfunc (s *FileStorage) Save(tasks []Task) error {\n	data, err := json.MarshalIndent(tasks, \"\", \"  \")\n	if err != nil {\n		return fmt.Errorf(\"序列化任务列表为 JSON 失败: %w\", err)\n	}\n	data = append(data, '\\n')\n\n	tmpPath := s.filePath + \".tmp\"\n	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)\n	if err != nil {\n		return fmt.Errorf(\"创建临时文件 %s 失败: %w\", tmpPath, err)\n	}\n\n	// 若后续步骤出错，确保关闭文件句柄并清理残留的临时文件\n	writeErr := func() error {\n		if _, err := f.Write(data); err != nil {\n			_ = f.Close()\n			return fmt.Errorf(\"写入数据到临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		if err := f.Sync(); err != nil {\n			_ = f.Close()\n			return fmt.Errorf(\"刷盘临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		if err := f.Close(); err != nil {\n			return fmt.Errorf(\"关闭临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		return nil\n	}()\n\n	if writeErr != nil {\n		_ = os.Remove(tmpPath)\n		return writeErr\n	}\n\n	if err := os.Rename(tmpPath, s.filePath); err != nil {\n		_ = os.Remove(tmpPath)\n		return fmt.Errorf(\"替换任务文件 %s 失败: %w\", s.filePath, err)\n	}\n\n	return nil\n}\n",
		"server/server.go": "package server\n\nimport (\n	\"encoding/json\"\n	\"errors\"\n	\"net/http\"\n	\"strconv\"\n\n	\"example.com/taskmgr/task\"\n)\n\n// TaskServer 封装任务管理的 HTTP 路由与处理器\ntype TaskServer struct {\n	manager *task.Manager\n	mux     *http.ServeMux\n}\n\n// NewTaskServer 创建 TaskServer 并注册所有路由规则\nfunc NewTaskServer(manager *task.Manager) *TaskServer {\n	s := &TaskServer{\n		manager: manager,\n		mux:     http.NewServeMux(),\n	}\n	s.registerRoutes()\n	return s\n}\n\nfunc (s *TaskServer) registerRoutes() {\n	s.mux.HandleFunc(\"GET /__go-learning/health\", func(w http.ResponseWriter, r *http.Request) {\n		w.Header().Set(\"X-Delivery-Go-Learning\", \"taskmgr\")\n		w.WriteHeader(http.StatusNoContent)\n	})\n	s.mux.HandleFunc(\"GET /tasks\", s.handleListTasks)\n	s.mux.HandleFunc(\"POST /tasks\", s.handleCreateTask)\n	s.mux.HandleFunc(\"PATCH /tasks/{id}/done\", s.handleCompleteTask)\n	s.mux.HandleFunc(\"DELETE /tasks/{id}\", s.handleDeleteTask)\n}\n\n// ServeHTTP 实现 http.Handler 接口，使 TaskServer 可直接传给 http.ListenAndServe 或 httptest\nfunc (s *TaskServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {\n	s.mux.ServeHTTP(w, r)\n}\n\n// createTaskRequest 定义 POST /tasks 的请求体结构\ntype createTaskRequest struct {\n	Title string `json:\"title\"`\n}\n\n// errorResponse 定义统一的错误响应 JSON 结构\ntype errorResponse struct {\n	Error string `json:\"error\"`\n}\n\n// messageResponse 定义通用操作成功提示 JSON 结构\ntype messageResponse struct {\n	Message string `json:\"message\"`\n}\n\n// writeJSON 统一设置 JSON 响应头、状态码并输出编码后的 JSON\nfunc writeJSON(w http.ResponseWriter, status int, data any) {\n	w.Header().Set(\"Content-Type\", \"application/json; charset=utf-8\")\n	w.WriteHeader(status)\n	_ = json.NewEncoder(w).Encode(data)\n}\n\nfunc writeError(w http.ResponseWriter, status int, msg string) {\n	writeJSON(w, status, errorResponse{Error: msg})\n}\n\n// parseID 校验并解析路径参数中的任务 ID（要求必须为正整数）\nfunc parseID(r *http.Request) (int, error) {\n	rawID := r.PathValue(\"id\")\n	id, err := strconv.Atoi(rawID)\n	if err != nil || id <= 0 {\n		return 0, errors.New(\"任务 ID 必须是大于 0 的整数\")\n	}\n	return id, nil\n}\n\n// handleListTasks 处理 GET /tasks\nfunc (s *TaskServer) handleListTasks(w http.ResponseWriter, r *http.Request) {\n	tasks := s.manager.List()\n	writeJSON(w, http.StatusOK, tasks)\n}\n\n// handleCreateTask 处理 POST /tasks\nfunc (s *TaskServer) handleCreateTask(w http.ResponseWriter, r *http.Request) {\n	defer r.Body.Close()\n\n	var req createTaskRequest\n	dec := json.NewDecoder(r.Body)\n	if err := dec.Decode(&req); err != nil {\n		writeError(w, http.StatusBadRequest, \"请求体必须是合法的 JSON 格式\")\n		return\n	}\n\n	created, err := s.manager.Add(req.Title)\n	if err != nil {\n		if errors.Is(err, task.ErrInvalidTitle) {\n			writeError(w, http.StatusBadRequest, err.Error())\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"保存任务失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusCreated, created)\n}\n\n// handleCompleteTask 处理 PATCH /tasks/{id}/done\nfunc (s *TaskServer) handleCompleteTask(w http.ResponseWriter, r *http.Request) {\n	id, err := parseID(r)\n	if err != nil {\n		writeError(w, http.StatusBadRequest, err.Error())\n		return\n	}\n\n	updated, err := s.manager.Complete(id)\n	if err != nil {\n		if errors.Is(err, task.ErrNotFound) {\n			writeError(w, http.StatusNotFound, \"指定的任务不存在\")\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"更新任务状态失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusOK, updated)\n}\n\n// handleDeleteTask 处理 DELETE /tasks/{id}\nfunc (s *TaskServer) handleDeleteTask(w http.ResponseWriter, r *http.Request) {\n	id, err := parseID(r)\n	if err != nil {\n		writeError(w, http.StatusBadRequest, err.Error())\n		return\n	}\n\n	if err := s.manager.Delete(id); err != nil {\n		if errors.Is(err, task.ErrNotFound) {\n			writeError(w, http.StatusNotFound, \"指定的任务不存在\")\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"删除任务失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusOK, messageResponse{Message: \"任务已删除\"})\n}\n"
	},
	"day6": {
		"go.mod": "module example.com/taskmgr\n\ngo 1.22\n",
		"main.go": "package main\n\nimport (\n	\"fmt\"\n	\"log\"\n	\"net/http\"\n	\"os\"\n\n	\"example.com/taskmgr/server\"\n	\"example.com/taskmgr/task\"\n)\n\nfunc main() {\n	dataFile := \"tasks.json\"\n	if envFile := os.Getenv(\"TASK_FILE\"); envFile != \"\" {\n		dataFile = envFile\n	}\n\n	addr := \"127.0.0.1:8080\"\n	if envAddr := os.Getenv(\"TASK_ADDR\"); envAddr != \"\" {\n		addr = envAddr\n	}\n\n	storage := task.NewFileStorage(dataFile)\n	mgr, err := task.NewManager(storage)\n	if err != nil {\n		log.Fatalf(\"初始化任务管理器失败: %v\", err)\n	}\n\n	srv := server.NewTaskServer(mgr)\n	fmt.Printf(\"TaskMgr HTTP 服务已启动，监听地址 http://localhost%s (数据文件: %s)\\n\", addr, dataFile)\n	if err := http.ListenAndServe(addr, srv); err != nil {\n		log.Fatalf(\"HTTP 服务异常退出: %v\", err)\n	}\n}\n",
		"task/task.go": "package task\n\nimport (\n	\"errors\"\n	\"fmt\"\n	\"strings\"\n	\"sync\"\n)\n\nvar (\n	ErrNotFound     = errors.New(\"任务不存在\")\n	ErrInvalidTitle = errors.New(\"任务标题不能为空\")\n)\n\n// Task 表示单条任务，带有 JSON 序列化标签\ntype Task struct {\n	ID    int    `json:\"id\"`\n	Title string `json:\"title\"`\n	Done  bool   `json:\"done\"`\n}\n\n// Storage 定义任务持久化的最小契约接口\ntype Storage interface {\n	Load() ([]Task, error)\n	Save(tasks []Task) error\n}\n\n// Manager 负责管理任务的增删改查，内置互斥锁保证并发安全\ntype Manager struct {\n	mu      sync.Mutex\n	tasks   []Task\n	nextID  int\n	storage Storage\n}\n\n// NewManager 创建并初始化任务管理器\nfunc NewManager(storage Storage) (*Manager, error) {\n	loaded := make([]Task, 0)\n	if storage != nil {\n		var err error\n		loaded, err = storage.Load()\n		if err != nil {\n			return nil, fmt.Errorf(\"初始化加载任务失败: %w\", err)\n		}\n	}\n\n	nextID := 1\n	for _, t := range loaded {\n		if t.ID >= nextID {\n			nextID = t.ID + 1\n		}\n	}\n\n	return &Manager{\n		tasks:   loaded,\n		nextID:  nextID,\n		storage: storage,\n	}, nil\n}\n\n// saveTasks 将指定的任务切片持久化到存储层（调用方需已持有 m.mu 锁）\nfunc (m *Manager) saveTasks(tasks []Task) error {\n	if m.storage == nil {\n		return nil\n	}\n	if err := m.storage.Save(tasks); err != nil {\n		return fmt.Errorf(\"保存任务数据失败: %w\", err)\n	}\n	return nil\n}\n\n// Add 校验标题并新增一条任务（并发安全，且在保存失败时保持原内存状态不变）\nfunc (m *Manager) Add(title string) (Task, error) {\n	cleanTitle := strings.TrimSpace(title)\n	if cleanTitle == \"\" {\n		return Task{}, ErrInvalidTitle\n	}\n\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	newTask := Task{\n		ID:    m.nextID,\n		Title: cleanTitle,\n		Done:  false,\n	}\n\n	updated := make([]Task, len(m.tasks), len(m.tasks)+1)\n	copy(updated, m.tasks)\n	updated = append(updated, newTask)\n\n	if err := m.saveTasks(updated); err != nil {\n		return Task{}, err\n	}\n\n	m.tasks = updated\n	m.nextID++\n	return newTask, nil\n}\n\n// List 返回当前所有任务的副本切片（并发安全，防止外部读写底层数组引发竞争）\nfunc (m *Manager) List() []Task {\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	result := make([]Task, len(m.tasks))\n	copy(result, m.tasks)\n	return result\n}\n\n// Complete 根据 ID 将任务标记为已完成（并发安全，保存失败时回滚状态）\nfunc (m *Manager) Complete(id int) (Task, error) {\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	for i := range m.tasks {\n		if m.tasks[i].ID == id {\n			prevDone := m.tasks[i].Done\n			m.tasks[i].Done = true\n			if err := m.saveTasks(m.tasks); err != nil {\n				m.tasks[i].Done = prevDone\n				return Task{}, err\n			}\n			return m.tasks[i], nil\n		}\n	}\n	return Task{}, fmt.Errorf(\"完成任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n\n// Delete 根据 ID 删除任务（并发安全，保存失败时不修改原切片）\nfunc (m *Manager) Delete(id int) error {\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	for i, t := range m.tasks {\n		if t.ID == id {\n			updated := make([]Task, 0, len(m.tasks)-1)\n			updated = append(updated, m.tasks[:i]...)\n			updated = append(updated, m.tasks[i+1:]...)\n\n			if err := m.saveTasks(updated); err != nil {\n				return err\n			}\n			m.tasks = updated\n			return nil\n		}\n	}\n	return fmt.Errorf(\"删除任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n",
		"task/file_storage.go": "package task\n\nimport (\n	\"bytes\"\n	\"encoding/json\"\n	\"errors\"\n	\"fmt\"\n	\"os\"\n)\n\n// FileStorage 实现 Storage 接口，将任务列表持久化到 JSON 文件\ntype FileStorage struct {\n	filePath string\n}\n\n// NewFileStorage 创建基于指定文件路径的 JSON 存储实例\nfunc NewFileStorage(filePath string) *FileStorage {\n	return &FileStorage{filePath: filePath}\n}\n\n// Load 从 JSON 文件加载任务列表\n// - 若文件不存在或为空文件，返回空切片且不报错\n// - 若 JSON 内容损坏，返回明确错误以防止静默覆盖原文件\nfunc (s *FileStorage) Load() ([]Task, error) {\n	data, err := os.ReadFile(s.filePath)\n	if err != nil {\n		if errors.Is(err, os.ErrNotExist) {\n			return []Task{}, nil\n		}\n		return nil, fmt.Errorf(\"读取任务文件 %s 失败: %w\", s.filePath, err)\n	}\n\n	if len(bytes.TrimSpace(data)) == 0 {\n		return []Task{}, nil\n	}\n\n	var tasks []Task\n	if err := json.Unmarshal(data, &tasks); err != nil {\n		return nil, fmt.Errorf(\"解析任务文件 %s 的 JSON 内容失败(文件可能已损坏): %w\", s.filePath, err)\n	}\n\n	if tasks == nil {\n		return []Task{}, nil\n	}\n	return tasks, nil\n}\n\n// Save 将任务列表安全写入 JSON 文件\n// 采用“写临时文件 -> Sync 刷盘 -> 显式检查 Close 错误 -> Rename 原子替换”策略\nfunc (s *FileStorage) Save(tasks []Task) error {\n	data, err := json.MarshalIndent(tasks, \"\", \"  \")\n	if err != nil {\n		return fmt.Errorf(\"序列化任务列表为 JSON 失败: %w\", err)\n	}\n	data = append(data, '\\n')\n\n	tmpPath := s.filePath + \".tmp\"\n	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)\n	if err != nil {\n		return fmt.Errorf(\"创建临时文件 %s 失败: %w\", tmpPath, err)\n	}\n\n	// 若后续步骤出错，确保关闭文件句柄并清理残留的临时文件\n	writeErr := func() error {\n		if _, err := f.Write(data); err != nil {\n			_ = f.Close()\n			return fmt.Errorf(\"写入数据到临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		if err := f.Sync(); err != nil {\n			_ = f.Close()\n			return fmt.Errorf(\"刷盘临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		if err := f.Close(); err != nil {\n			return fmt.Errorf(\"关闭临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		return nil\n	}()\n\n	if writeErr != nil {\n		_ = os.Remove(tmpPath)\n		return writeErr\n	}\n\n	if err := os.Rename(tmpPath, s.filePath); err != nil {\n		_ = os.Remove(tmpPath)\n		return fmt.Errorf(\"替换任务文件 %s 失败: %w\", s.filePath, err)\n	}\n\n	return nil\n}\n",
		"task/task_test.go": "package task\n\nimport (\n	\"errors\"\n	\"os\"\n	\"path/filepath\"\n	\"sync\"\n	\"testing\"\n)\n\n// TestManagerCRUDAndValidation 验证任务的增、查、完成、删除及错误分支\nfunc TestManagerCRUDAndValidation(t *testing.T) {\n	mgr, err := NewManager(nil)\n	if err != nil {\n		t.Fatalf(\"NewManager 失败: %v\", err)\n	}\n\n	// 1. 验证空白标题返回 ErrInvalidTitle\n	if _, err := mgr.Add(\"   \"); !errors.Is(err, ErrInvalidTitle) {\n		t.Fatalf(\"期望返回 ErrInvalidTitle，实际得到: %v\", err)\n	}\n\n	// 2. 验证正常新增\n	t1, err := mgr.Add(\"第一条任务\")\n	if err != nil {\n		t.Fatalf(\"Add 失败: %v\", err)\n	}\n	if t1.ID != 1 || t1.Title != \"第一条任务\" || t1.Done {\n		t.Fatalf(\"新增任务字段不符合预期: %+v\", t1)\n	}\n\n	// 3. 验证标记完成\n	completed, err := mgr.Complete(t1.ID)\n	if err != nil || !completed.Done {\n		t.Fatalf(\"Complete 失败: task=%+v, err=%v\", completed, err)\n	}\n\n	// 4. 验证操作不存在的任务返回 ErrNotFound\n	if _, err := mgr.Complete(999); !errors.Is(err, ErrNotFound) {\n		t.Fatalf(\"期望 Complete(999) 返回 ErrNotFound，实际得到: %v\", err)\n	}\n	if err := mgr.Delete(999); !errors.Is(err, ErrNotFound) {\n		t.Fatalf(\"期望 Delete(999) 返回 ErrNotFound，实际得到: %v\", err)\n	}\n\n	// 5. 验证删除任务\n	if err := mgr.Delete(t1.ID); err != nil {\n		t.Fatalf(\"Delete 失败: %v\", err)\n	}\n	if got := len(mgr.List()); got != 0 {\n		t.Fatalf(\"删除后期望任务数为 0，实际为 %d\", got)\n	}\n}\n\n// TestFileStoragePersistenceAndCorruption 验证文件持久化恢复与损坏检测\nfunc TestFileStoragePersistenceAndCorruption(t *testing.T) {\n	tmpDir := t.TempDir()\n	filePath := filepath.Join(tmpDir, \"tasks.json\")\n	store := NewFileStorage(filePath)\n\n	// 1. 首次启动（文件不存在）应成功且列表为空\n	mgr1, err := NewManager(store)\n	if err != nil {\n		t.Fatalf(\"首次初始化失败: %v\", err)\n	}\n	t1, _ := mgr1.Add(\"持久化任务 A\")\n	t2, _ := mgr1.Add(\"持久化任务 B\")\n	_, _ = mgr1.Complete(t1.ID)\n\n	// 2. 模拟服务重启：用同一个文件重新创建 Manager\n	mgr2, err := NewManager(store)\n	if err != nil {\n		t.Fatalf(\"重启加载失败: %v\", err)\n	}\n	list := mgr2.List()\n	if len(list) != 2 || !list[0].Done || list[1].ID != t2.ID {\n		t.Fatalf(\"重启后恢复的数据不匹配: %+v\", list)\n	}\n\n	// 3. 重启后再新增任务，ID 应从 3 继续递增\n	t3, err := mgr2.Add(\"重启后新任务 C\")\n	if err != nil || t3.ID != 3 {\n		t.Fatalf(\"期望新任务 ID 为 3，实际得到: %+v, err=%v\", t3, err)\n	}\n\n	// 4. 模拟文件内容损坏，验证能够识别并报错\n	if err := os.WriteFile(filePath, []byte(\"{corrupted json\"), 0644); err != nil {\n		t.Fatalf(\"写入损坏文件失败: %v\", err)\n	}\n	if _, err := NewManager(store); err == nil {\n		t.Fatal(\"期望加载损坏的 JSON 文件时返回错误，但返回了 nil\")\n	}\n}\n\n// TestManagerConcurrentAccess 验证多 goroutine 并发读写下的安全性（配合 go test -race）\nfunc TestManagerConcurrentAccess(t *testing.T) {\n	tmpDir := t.TempDir()\n	store := NewFileStorage(filepath.Join(tmpDir, \"concurrent_tasks.json\"))\n	mgr, err := NewManager(store)\n	if err != nil {\n		t.Fatalf(\"初始化失败: %v\", err)\n	}\n\n	const workers = 20\n	var wg sync.WaitGroup\n	wg.Add(workers)\n\n	for i := 0; i < workers; i++ {\n		go func() {\n			defer wg.Done()\n			created, err := mgr.Add(\"并发任务\")\n			if err != nil {\n				t.Errorf(\"并发 Add 失败: %v\", err)\n				return\n			}\n			_ = mgr.List()\n			if _, err := mgr.Complete(created.ID); err != nil {\n				t.Errorf(\"并发 Complete 失败: %v\", err)\n			}\n		}()\n	}\n\n	wg.Wait()\n\n	tasks := mgr.List()\n	if len(tasks) != workers {\n		t.Fatalf(\"期望最终任务数量为 %d，实际为 %d\", workers, len(tasks))\n	}\n}\n",
		"server/server.go": "package server\n\nimport (\n	\"encoding/json\"\n	\"errors\"\n	\"net/http\"\n	\"strconv\"\n\n	\"example.com/taskmgr/task\"\n)\n\n// TaskServer 封装任务管理的 HTTP 路由与处理器\ntype TaskServer struct {\n	manager *task.Manager\n	mux     *http.ServeMux\n}\n\n// NewTaskServer 创建 TaskServer 并注册所有路由规则\nfunc NewTaskServer(manager *task.Manager) *TaskServer {\n	s := &TaskServer{\n		manager: manager,\n		mux:     http.NewServeMux(),\n	}\n	s.registerRoutes()\n	return s\n}\n\nfunc (s *TaskServer) registerRoutes() {\n	s.mux.HandleFunc(\"GET /__go-learning/health\", func(w http.ResponseWriter, r *http.Request) {\n		w.Header().Set(\"X-Delivery-Go-Learning\", \"taskmgr\")\n		w.WriteHeader(http.StatusNoContent)\n	})\n	s.mux.HandleFunc(\"GET /tasks\", s.handleListTasks)\n	s.mux.HandleFunc(\"POST /tasks\", s.handleCreateTask)\n	s.mux.HandleFunc(\"PATCH /tasks/{id}/done\", s.handleCompleteTask)\n	s.mux.HandleFunc(\"DELETE /tasks/{id}\", s.handleDeleteTask)\n}\n\n// ServeHTTP 实现 http.Handler 接口，使 TaskServer 可直接传给 http.ListenAndServe 或 httptest\nfunc (s *TaskServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {\n	s.mux.ServeHTTP(w, r)\n}\n\n// createTaskRequest 定义 POST /tasks 的请求体结构\ntype createTaskRequest struct {\n	Title string `json:\"title\"`\n}\n\n// errorResponse 定义统一的错误响应 JSON 结构\ntype errorResponse struct {\n	Error string `json:\"error\"`\n}\n\n// messageResponse 定义通用操作成功提示 JSON 结构\ntype messageResponse struct {\n	Message string `json:\"message\"`\n}\n\n// writeJSON 统一设置 JSON 响应头、状态码并输出编码后的 JSON\nfunc writeJSON(w http.ResponseWriter, status int, data any) {\n	w.Header().Set(\"Content-Type\", \"application/json; charset=utf-8\")\n	w.WriteHeader(status)\n	_ = json.NewEncoder(w).Encode(data)\n}\n\nfunc writeError(w http.ResponseWriter, status int, msg string) {\n	writeJSON(w, status, errorResponse{Error: msg})\n}\n\n// parseID 校验并解析路径参数中的任务 ID（要求必须为正整数）\nfunc parseID(r *http.Request) (int, error) {\n	rawID := r.PathValue(\"id\")\n	id, err := strconv.Atoi(rawID)\n	if err != nil || id <= 0 {\n		return 0, errors.New(\"任务 ID 必须是大于 0 的整数\")\n	}\n	return id, nil\n}\n\n// handleListTasks 处理 GET /tasks\nfunc (s *TaskServer) handleListTasks(w http.ResponseWriter, r *http.Request) {\n	tasks := s.manager.List()\n	writeJSON(w, http.StatusOK, tasks)\n}\n\n// handleCreateTask 处理 POST /tasks\nfunc (s *TaskServer) handleCreateTask(w http.ResponseWriter, r *http.Request) {\n	defer r.Body.Close()\n\n	var req createTaskRequest\n	dec := json.NewDecoder(r.Body)\n	if err := dec.Decode(&req); err != nil {\n		writeError(w, http.StatusBadRequest, \"请求体必须是合法的 JSON 格式\")\n		return\n	}\n\n	created, err := s.manager.Add(req.Title)\n	if err != nil {\n		if errors.Is(err, task.ErrInvalidTitle) {\n			writeError(w, http.StatusBadRequest, err.Error())\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"保存任务失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusCreated, created)\n}\n\n// handleCompleteTask 处理 PATCH /tasks/{id}/done\nfunc (s *TaskServer) handleCompleteTask(w http.ResponseWriter, r *http.Request) {\n	id, err := parseID(r)\n	if err != nil {\n		writeError(w, http.StatusBadRequest, err.Error())\n		return\n	}\n\n	updated, err := s.manager.Complete(id)\n	if err != nil {\n		if errors.Is(err, task.ErrNotFound) {\n			writeError(w, http.StatusNotFound, \"指定的任务不存在\")\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"更新任务状态失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusOK, updated)\n}\n\n// handleDeleteTask 处理 DELETE /tasks/{id}\nfunc (s *TaskServer) handleDeleteTask(w http.ResponseWriter, r *http.Request) {\n	id, err := parseID(r)\n	if err != nil {\n		writeError(w, http.StatusBadRequest, err.Error())\n		return\n	}\n\n	if err := s.manager.Delete(id); err != nil {\n		if errors.Is(err, task.ErrNotFound) {\n			writeError(w, http.StatusNotFound, \"指定的任务不存在\")\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"删除任务失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusOK, messageResponse{Message: \"任务已删除\"})\n}\n",
		"server/server_test.go": "package server\n\nimport (\n	\"bytes\"\n	\"encoding/json\"\n	\"fmt\"\n	\"net/http\"\n	\"net/http/httptest\"\n	\"path/filepath\"\n	\"sync\"\n	\"testing\"\n\n	\"example.com/taskmgr/task\"\n)\n\nfunc setupTestServer(t *testing.T) *TaskServer {\n	t.Helper()\n	store := task.NewFileStorage(filepath.Join(t.TempDir(), \"test_tasks.json\"))\n	mgr, err := task.NewManager(store)\n	if err != nil {\n		t.Fatalf(\"创建 Manager 失败: %v\", err)\n	}\n	return NewTaskServer(mgr)\n}\n\n// TestTaskServerEndToEnd 验证 HTTP 增删改查及异常输入状态码\nfunc TestTaskServerEndToEnd(t *testing.T) {\n	srv := setupTestServer(t)\n\n	// 1. POST /tasks 创建任务 -> 期望 201 Created\n	reqBody := bytes.NewBufferString(`{\"title\":\"编写 HTTP 测试\"}`)\n	req := httptest.NewRequest(http.MethodPost, \"/tasks\", reqBody)\n	rec := httptest.NewRecorder()\n	srv.ServeHTTP(rec, req)\n\n	if rec.Code != http.StatusCreated {\n		t.Fatalf(\"期望状态码 201，实际得到 %d, 响应: %s\", rec.Code, rec.Body.String())\n	}\n\n	var created task.Task\n	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {\n		t.Fatalf(\"解析创建响应失败: %v\", err)\n	}\n	if created.ID != 1 || created.Title != \"编写 HTTP 测试\" || created.Done {\n		t.Fatalf(\"创建的任务内容不符: %+v\", created)\n	}\n\n	// 2. POST /tasks 传入空标题 -> 期望 400 Bad Request\n	badReq := httptest.NewRequest(http.MethodPost, \"/tasks\", bytes.NewBufferString(`{\"title\":\"  \"}`))\n	badRec := httptest.NewRecorder()\n	srv.ServeHTTP(badRec, badReq)\n	if badRec.Code != http.StatusBadRequest {\n		t.Fatalf(\"空标题期望状态码 400，实际得到 %d\", badRec.Code)\n	}\n\n	// 3. PATCH /tasks/1/done 标记完成 -> 期望 200 OK\n	patchReq := httptest.NewRequest(http.MethodPatch, \"/tasks/1/done\", nil)\n	patchRec := httptest.NewRecorder()\n	srv.ServeHTTP(patchRec, patchReq)\n	if patchRec.Code != http.StatusOK {\n		t.Fatalf(\"完成任务期望状态码 200，实际得到 %d\", patchRec.Code)\n	}\n\n	// 4. PATCH /tasks/999/done 不存在的任务 -> 期望 404 Not Found\n	notFoundReq := httptest.NewRequest(http.MethodPatch, \"/tasks/999/done\", nil)\n	notFoundRec := httptest.NewRecorder()\n	srv.ServeHTTP(notFoundRec, notFoundReq)\n	if notFoundRec.Code != http.StatusNotFound {\n		t.Fatalf(\"不存在的任务期望状态码 404，实际得到 %d\", notFoundRec.Code)\n	}\n\n	// 5. DELETE /tasks/1 删除任务 -> 期望 200 OK\n	delReq := httptest.NewRequest(http.MethodDelete, \"/tasks/1\", nil)\n	delRec := httptest.NewRecorder()\n	srv.ServeHTTP(delRec, delReq)\n	if delRec.Code != http.StatusOK {\n		t.Fatalf(\"删除任务期望状态码 200，实际得到 %d\", delRec.Code)\n	}\n\n	// 6. GET /tasks 确认列表已清空 -> 期望 200 OK 且长度为 0\n	listReq := httptest.NewRequest(http.MethodGet, \"/tasks\", nil)\n	listRec := httptest.NewRecorder()\n	srv.ServeHTTP(listRec, listReq)\n	var list []task.Task\n	_ = json.Unmarshal(listRec.Body.Bytes(), &list)\n	if len(list) != 0 {\n		t.Fatalf(\"删除后期望列表为空，实际得到: %+v\", list)\n	}\n}\n\n// TestTaskServerConcurrentRequests 验证并发 HTTP 请求不会触发数据竞争\nfunc TestTaskServerConcurrentRequests(t *testing.T) {\n	srv := setupTestServer(t)\n\n	const total = 15\n	var wg sync.WaitGroup\n	wg.Add(total)\n\n	for i := 0; i < total; i++ {\n		go func(idx int) {\n			defer wg.Done()\n			payload := fmt.Sprintf(`{\"title\":\"并发HTTP任务-%d\"}`, idx)\n			postReq := httptest.NewRequest(http.MethodPost, \"/tasks\", bytes.NewBufferString(payload))\n			postRec := httptest.NewRecorder()\n			srv.ServeHTTP(postRec, postReq)\n			if postRec.Code != http.StatusCreated {\n				t.Errorf(\"并发 POST 状态码异常: %d\", postRec.Code)\n			}\n\n			getReq := httptest.NewRequest(http.MethodGet, \"/tasks\", nil)\n			getRec := httptest.NewRecorder()\n			srv.ServeHTTP(getRec, getReq)\n			if getRec.Code != http.StatusOK {\n				t.Errorf(\"并发 GET 状态码异常: %d\", getRec.Code)\n			}\n		}(i)\n	}\n\n	wg.Wait()\n}\n"
	},
	"day7": {
		"go.mod": "module example.com/taskmgr\n\ngo 1.22\n",
		"main.go": "package main\n\nimport (\n	\"fmt\"\n	\"log\"\n	\"net/http\"\n	\"os\"\n\n	\"example.com/taskmgr/server\"\n	\"example.com/taskmgr/task\"\n)\n\nfunc main() {\n	dataFile := \"tasks.json\"\n	if envFile := os.Getenv(\"TASK_FILE\"); envFile != \"\" {\n		dataFile = envFile\n	}\n\n	addr := \"127.0.0.1:8080\"\n	if envAddr := os.Getenv(\"TASK_ADDR\"); envAddr != \"\" {\n		addr = envAddr\n	}\n\n	storage := task.NewFileStorage(dataFile)\n	mgr, err := task.NewManager(storage)\n	if err != nil {\n		log.Fatalf(\"初始化任务管理器失败: %v\", err)\n	}\n\n	srv := server.NewTaskServer(mgr)\n	fmt.Printf(\"TaskMgr HTTP 服务已启动，监听地址 http://localhost%s (数据文件: %s)\\n\", addr, dataFile)\n	if err := http.ListenAndServe(addr, srv); err != nil {\n		log.Fatalf(\"HTTP 服务异常退出: %v\", err)\n	}\n}\n",
		"task/task.go": "package task\n\nimport (\n	\"errors\"\n	\"fmt\"\n	\"strings\"\n	\"sync\"\n)\n\nvar (\n	ErrNotFound     = errors.New(\"任务不存在\")\n	ErrInvalidTitle = errors.New(\"任务标题不能为空\")\n)\n\n// Task 表示单条任务，带有 JSON 序列化标签\ntype Task struct {\n	ID    int    `json:\"id\"`\n	Title string `json:\"title\"`\n	Done  bool   `json:\"done\"`\n}\n\n// Storage 定义任务持久化的最小契约接口\ntype Storage interface {\n	Load() ([]Task, error)\n	Save(tasks []Task) error\n}\n\n// Manager 负责管理任务的增删改查，内置互斥锁保证并发安全\ntype Manager struct {\n	mu      sync.Mutex\n	tasks   []Task\n	nextID  int\n	storage Storage\n}\n\n// NewManager 创建并初始化任务管理器\nfunc NewManager(storage Storage) (*Manager, error) {\n	loaded := make([]Task, 0)\n	if storage != nil {\n		var err error\n		loaded, err = storage.Load()\n		if err != nil {\n			return nil, fmt.Errorf(\"初始化加载任务失败: %w\", err)\n		}\n	}\n\n	nextID := 1\n	for _, t := range loaded {\n		if t.ID >= nextID {\n			nextID = t.ID + 1\n		}\n	}\n\n	return &Manager{\n		tasks:   loaded,\n		nextID:  nextID,\n		storage: storage,\n	}, nil\n}\n\n// saveTasks 将指定的任务切片持久化到存储层（调用方需已持有 m.mu 锁）\nfunc (m *Manager) saveTasks(tasks []Task) error {\n	if m.storage == nil {\n		return nil\n	}\n	if err := m.storage.Save(tasks); err != nil {\n		return fmt.Errorf(\"保存任务数据失败: %w\", err)\n	}\n	return nil\n}\n\n// Add 校验标题并新增一条任务（并发安全，且在保存失败时保持原内存状态不变）\nfunc (m *Manager) Add(title string) (Task, error) {\n	cleanTitle := strings.TrimSpace(title)\n	if cleanTitle == \"\" {\n		return Task{}, ErrInvalidTitle\n	}\n\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	newTask := Task{\n		ID:    m.nextID,\n		Title: cleanTitle,\n		Done:  false,\n	}\n\n	updated := make([]Task, len(m.tasks), len(m.tasks)+1)\n	copy(updated, m.tasks)\n	updated = append(updated, newTask)\n\n	if err := m.saveTasks(updated); err != nil {\n		return Task{}, err\n	}\n\n	m.tasks = updated\n	m.nextID++\n	return newTask, nil\n}\n\n// List 返回当前所有任务的副本切片（并发安全，防止外部读写底层数组引发竞争）\nfunc (m *Manager) List() []Task {\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	result := make([]Task, len(m.tasks))\n	copy(result, m.tasks)\n	return result\n}\n\n// Complete 根据 ID 将任务标记为已完成（并发安全，保存失败时回滚状态）\nfunc (m *Manager) Complete(id int) (Task, error) {\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	for i := range m.tasks {\n		if m.tasks[i].ID == id {\n			prevDone := m.tasks[i].Done\n			m.tasks[i].Done = true\n			if err := m.saveTasks(m.tasks); err != nil {\n				m.tasks[i].Done = prevDone\n				return Task{}, err\n			}\n			return m.tasks[i], nil\n		}\n	}\n	return Task{}, fmt.Errorf(\"完成任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n\n// Delete 根据 ID 删除任务（并发安全，保存失败时不修改原切片）\nfunc (m *Manager) Delete(id int) error {\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	for i, t := range m.tasks {\n		if t.ID == id {\n			updated := make([]Task, 0, len(m.tasks)-1)\n			updated = append(updated, m.tasks[:i]...)\n			updated = append(updated, m.tasks[i+1:]...)\n\n			if err := m.saveTasks(updated); err != nil {\n				return err\n			}\n			m.tasks = updated\n			return nil\n		}\n	}\n	return fmt.Errorf(\"删除任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n",
		"task/file_storage.go": "package task\n\nimport (\n	\"bytes\"\n	\"encoding/json\"\n	\"errors\"\n	\"fmt\"\n	\"os\"\n)\n\n// FileStorage 实现 Storage 接口，将任务列表持久化到 JSON 文件\ntype FileStorage struct {\n	filePath string\n}\n\n// NewFileStorage 创建基于指定文件路径的 JSON 存储实例\nfunc NewFileStorage(filePath string) *FileStorage {\n	return &FileStorage{filePath: filePath}\n}\n\n// Load 从 JSON 文件加载任务列表\n// - 若文件不存在或为空文件，返回空切片且不报错\n// - 若 JSON 内容损坏，返回明确错误以防止静默覆盖原文件\nfunc (s *FileStorage) Load() ([]Task, error) {\n	data, err := os.ReadFile(s.filePath)\n	if err != nil {\n		if errors.Is(err, os.ErrNotExist) {\n			return []Task{}, nil\n		}\n		return nil, fmt.Errorf(\"读取任务文件 %s 失败: %w\", s.filePath, err)\n	}\n\n	if len(bytes.TrimSpace(data)) == 0 {\n		return []Task{}, nil\n	}\n\n	var tasks []Task\n	if err := json.Unmarshal(data, &tasks); err != nil {\n		return nil, fmt.Errorf(\"解析任务文件 %s 的 JSON 内容失败(文件可能已损坏): %w\", s.filePath, err)\n	}\n\n	if tasks == nil {\n		return []Task{}, nil\n	}\n	return tasks, nil\n}\n\n// Save 将任务列表安全写入 JSON 文件\n// 采用“写临时文件 -> Sync 刷盘 -> 显式检查 Close 错误 -> Rename 原子替换”策略\nfunc (s *FileStorage) Save(tasks []Task) error {\n	data, err := json.MarshalIndent(tasks, \"\", \"  \")\n	if err != nil {\n		return fmt.Errorf(\"序列化任务列表为 JSON 失败: %w\", err)\n	}\n	data = append(data, '\\n')\n\n	tmpPath := s.filePath + \".tmp\"\n	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)\n	if err != nil {\n		return fmt.Errorf(\"创建临时文件 %s 失败: %w\", tmpPath, err)\n	}\n\n	// 若后续步骤出错，确保关闭文件句柄并清理残留的临时文件\n	writeErr := func() error {\n		if _, err := f.Write(data); err != nil {\n			_ = f.Close()\n			return fmt.Errorf(\"写入数据到临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		if err := f.Sync(); err != nil {\n			_ = f.Close()\n			return fmt.Errorf(\"刷盘临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		if err := f.Close(); err != nil {\n			return fmt.Errorf(\"关闭临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		return nil\n	}()\n\n	if writeErr != nil {\n		_ = os.Remove(tmpPath)\n		return writeErr\n	}\n\n	if err := os.Rename(tmpPath, s.filePath); err != nil {\n		_ = os.Remove(tmpPath)\n		return fmt.Errorf(\"替换任务文件 %s 失败: %w\", s.filePath, err)\n	}\n\n	return nil\n}\n",
		"task/task_test.go": "package task\n\nimport (\n	\"errors\"\n	\"os\"\n	\"path/filepath\"\n	\"sync\"\n	\"testing\"\n)\n\n// TestManagerCRUDAndValidation 验证任务的增、查、完成、删除及错误分支\nfunc TestManagerCRUDAndValidation(t *testing.T) {\n	mgr, err := NewManager(nil)\n	if err != nil {\n		t.Fatalf(\"NewManager 失败: %v\", err)\n	}\n\n	// 1. 验证空白标题返回 ErrInvalidTitle\n	if _, err := mgr.Add(\"   \"); !errors.Is(err, ErrInvalidTitle) {\n		t.Fatalf(\"期望返回 ErrInvalidTitle，实际得到: %v\", err)\n	}\n\n	// 2. 验证正常新增\n	t1, err := mgr.Add(\"第一条任务\")\n	if err != nil {\n		t.Fatalf(\"Add 失败: %v\", err)\n	}\n	if t1.ID != 1 || t1.Title != \"第一条任务\" || t1.Done {\n		t.Fatalf(\"新增任务字段不符合预期: %+v\", t1)\n	}\n\n	// 3. 验证标记完成\n	completed, err := mgr.Complete(t1.ID)\n	if err != nil || !completed.Done {\n		t.Fatalf(\"Complete 失败: task=%+v, err=%v\", completed, err)\n	}\n\n	// 4. 验证操作不存在的任务返回 ErrNotFound\n	if _, err := mgr.Complete(999); !errors.Is(err, ErrNotFound) {\n		t.Fatalf(\"期望 Complete(999) 返回 ErrNotFound，实际得到: %v\", err)\n	}\n	if err := mgr.Delete(999); !errors.Is(err, ErrNotFound) {\n		t.Fatalf(\"期望 Delete(999) 返回 ErrNotFound，实际得到: %v\", err)\n	}\n\n	// 5. 验证删除任务\n	if err := mgr.Delete(t1.ID); err != nil {\n		t.Fatalf(\"Delete 失败: %v\", err)\n	}\n	if got := len(mgr.List()); got != 0 {\n		t.Fatalf(\"删除后期望任务数为 0，实际为 %d\", got)\n	}\n}\n\n// TestFileStoragePersistenceAndCorruption 验证文件持久化恢复与损坏检测\nfunc TestFileStoragePersistenceAndCorruption(t *testing.T) {\n	tmpDir := t.TempDir()\n	filePath := filepath.Join(tmpDir, \"tasks.json\")\n	store := NewFileStorage(filePath)\n\n	// 1. 首次启动（文件不存在）应成功且列表为空\n	mgr1, err := NewManager(store)\n	if err != nil {\n		t.Fatalf(\"首次初始化失败: %v\", err)\n	}\n	t1, _ := mgr1.Add(\"持久化任务 A\")\n	t2, _ := mgr1.Add(\"持久化任务 B\")\n	_, _ = mgr1.Complete(t1.ID)\n\n	// 2. 模拟服务重启：用同一个文件重新创建 Manager\n	mgr2, err := NewManager(store)\n	if err != nil {\n		t.Fatalf(\"重启加载失败: %v\", err)\n	}\n	list := mgr2.List()\n	if len(list) != 2 || !list[0].Done || list[1].ID != t2.ID {\n		t.Fatalf(\"重启后恢复的数据不匹配: %+v\", list)\n	}\n\n	// 3. 重启后再新增任务，ID 应从 3 继续递增\n	t3, err := mgr2.Add(\"重启后新任务 C\")\n	if err != nil || t3.ID != 3 {\n		t.Fatalf(\"期望新任务 ID 为 3，实际得到: %+v, err=%v\", t3, err)\n	}\n\n	// 4. 模拟文件内容损坏，验证能够识别并报错\n	if err := os.WriteFile(filePath, []byte(\"{corrupted json\"), 0644); err != nil {\n		t.Fatalf(\"写入损坏文件失败: %v\", err)\n	}\n	if _, err := NewManager(store); err == nil {\n		t.Fatal(\"期望加载损坏的 JSON 文件时返回错误，但返回了 nil\")\n	}\n}\n\n// TestManagerConcurrentAccess 验证多 goroutine 并发读写下的安全性（配合 go test -race）\nfunc TestManagerConcurrentAccess(t *testing.T) {\n	tmpDir := t.TempDir()\n	store := NewFileStorage(filepath.Join(tmpDir, \"concurrent_tasks.json\"))\n	mgr, err := NewManager(store)\n	if err != nil {\n		t.Fatalf(\"初始化失败: %v\", err)\n	}\n\n	const workers = 20\n	var wg sync.WaitGroup\n	wg.Add(workers)\n\n	for i := 0; i < workers; i++ {\n		go func() {\n			defer wg.Done()\n			created, err := mgr.Add(\"并发任务\")\n			if err != nil {\n				t.Errorf(\"并发 Add 失败: %v\", err)\n				return\n			}\n			_ = mgr.List()\n			if _, err := mgr.Complete(created.ID); err != nil {\n				t.Errorf(\"并发 Complete 失败: %v\", err)\n			}\n		}()\n	}\n\n	wg.Wait()\n\n	tasks := mgr.List()\n	if len(tasks) != workers {\n		t.Fatalf(\"期望最终任务数量为 %d，实际为 %d\", workers, len(tasks))\n	}\n}\n",
		"server/server.go": "package server\n\nimport (\n	\"encoding/json\"\n	\"errors\"\n	\"net/http\"\n	\"strconv\"\n\n	\"example.com/taskmgr/task\"\n)\n\n// TaskServer 封装任务管理的 HTTP 路由与处理器\ntype TaskServer struct {\n	manager *task.Manager\n	mux     *http.ServeMux\n}\n\n// NewTaskServer 创建 TaskServer 并注册所有路由规则\nfunc NewTaskServer(manager *task.Manager) *TaskServer {\n	s := &TaskServer{\n		manager: manager,\n		mux:     http.NewServeMux(),\n	}\n	s.registerRoutes()\n	return s\n}\n\nfunc (s *TaskServer) registerRoutes() {\n	s.mux.HandleFunc(\"GET /__go-learning/health\", func(w http.ResponseWriter, r *http.Request) {\n		w.Header().Set(\"X-Delivery-Go-Learning\", \"taskmgr\")\n		w.WriteHeader(http.StatusNoContent)\n	})\n	s.mux.HandleFunc(\"GET /tasks\", s.handleListTasks)\n	s.mux.HandleFunc(\"POST /tasks\", s.handleCreateTask)\n	s.mux.HandleFunc(\"PATCH /tasks/{id}/done\", s.handleCompleteTask)\n	s.mux.HandleFunc(\"DELETE /tasks/{id}\", s.handleDeleteTask)\n}\n\n// ServeHTTP 实现 http.Handler 接口，使 TaskServer 可直接传给 http.ListenAndServe 或 httptest\nfunc (s *TaskServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {\n	s.mux.ServeHTTP(w, r)\n}\n\n// createTaskRequest 定义 POST /tasks 的请求体结构\ntype createTaskRequest struct {\n	Title string `json:\"title\"`\n}\n\n// errorResponse 定义统一的错误响应 JSON 结构\ntype errorResponse struct {\n	Error string `json:\"error\"`\n}\n\n// messageResponse 定义通用操作成功提示 JSON 结构\ntype messageResponse struct {\n	Message string `json:\"message\"`\n}\n\n// writeJSON 统一设置 JSON 响应头、状态码并输出编码后的 JSON\nfunc writeJSON(w http.ResponseWriter, status int, data any) {\n	w.Header().Set(\"Content-Type\", \"application/json; charset=utf-8\")\n	w.WriteHeader(status)\n	_ = json.NewEncoder(w).Encode(data)\n}\n\nfunc writeError(w http.ResponseWriter, status int, msg string) {\n	writeJSON(w, status, errorResponse{Error: msg})\n}\n\n// parseID 校验并解析路径参数中的任务 ID（要求必须为正整数）\nfunc parseID(r *http.Request) (int, error) {\n	rawID := r.PathValue(\"id\")\n	id, err := strconv.Atoi(rawID)\n	if err != nil || id <= 0 {\n		return 0, errors.New(\"任务 ID 必须是大于 0 的整数\")\n	}\n	return id, nil\n}\n\n// handleListTasks 处理 GET /tasks\nfunc (s *TaskServer) handleListTasks(w http.ResponseWriter, r *http.Request) {\n	tasks := s.manager.List()\n	writeJSON(w, http.StatusOK, tasks)\n}\n\n// handleCreateTask 处理 POST /tasks\nfunc (s *TaskServer) handleCreateTask(w http.ResponseWriter, r *http.Request) {\n	defer r.Body.Close()\n\n	var req createTaskRequest\n	dec := json.NewDecoder(r.Body)\n	if err := dec.Decode(&req); err != nil {\n		writeError(w, http.StatusBadRequest, \"请求体必须是合法的 JSON 格式\")\n		return\n	}\n\n	created, err := s.manager.Add(req.Title)\n	if err != nil {\n		if errors.Is(err, task.ErrInvalidTitle) {\n			writeError(w, http.StatusBadRequest, err.Error())\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"保存任务失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusCreated, created)\n}\n\n// handleCompleteTask 处理 PATCH /tasks/{id}/done\nfunc (s *TaskServer) handleCompleteTask(w http.ResponseWriter, r *http.Request) {\n	id, err := parseID(r)\n	if err != nil {\n		writeError(w, http.StatusBadRequest, err.Error())\n		return\n	}\n\n	updated, err := s.manager.Complete(id)\n	if err != nil {\n		if errors.Is(err, task.ErrNotFound) {\n			writeError(w, http.StatusNotFound, \"指定的任务不存在\")\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"更新任务状态失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusOK, updated)\n}\n\n// handleDeleteTask 处理 DELETE /tasks/{id}\nfunc (s *TaskServer) handleDeleteTask(w http.ResponseWriter, r *http.Request) {\n	id, err := parseID(r)\n	if err != nil {\n		writeError(w, http.StatusBadRequest, err.Error())\n		return\n	}\n\n	if err := s.manager.Delete(id); err != nil {\n		if errors.Is(err, task.ErrNotFound) {\n			writeError(w, http.StatusNotFound, \"指定的任务不存在\")\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"删除任务失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusOK, messageResponse{Message: \"任务已删除\"})\n}\n",
		"server/server_test.go": "package server\n\nimport (\n	\"bytes\"\n	\"encoding/json\"\n	\"fmt\"\n	\"net/http\"\n	\"net/http/httptest\"\n	\"path/filepath\"\n	\"sync\"\n	\"testing\"\n\n	\"example.com/taskmgr/task\"\n)\n\nfunc setupTestServer(t *testing.T) *TaskServer {\n	t.Helper()\n	store := task.NewFileStorage(filepath.Join(t.TempDir(), \"test_tasks.json\"))\n	mgr, err := task.NewManager(store)\n	if err != nil {\n		t.Fatalf(\"创建 Manager 失败: %v\", err)\n	}\n	return NewTaskServer(mgr)\n}\n\n// TestTaskServerEndToEnd 验证 HTTP 增删改查及异常输入状态码\nfunc TestTaskServerEndToEnd(t *testing.T) {\n	srv := setupTestServer(t)\n\n	// 1. POST /tasks 创建任务 -> 期望 201 Created\n	reqBody := bytes.NewBufferString(`{\"title\":\"编写 HTTP 测试\"}`)\n	req := httptest.NewRequest(http.MethodPost, \"/tasks\", reqBody)\n	rec := httptest.NewRecorder()\n	srv.ServeHTTP(rec, req)\n\n	if rec.Code != http.StatusCreated {\n		t.Fatalf(\"期望状态码 201，实际得到 %d, 响应: %s\", rec.Code, rec.Body.String())\n	}\n\n	var created task.Task\n	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {\n		t.Fatalf(\"解析创建响应失败: %v\", err)\n	}\n	if created.ID != 1 || created.Title != \"编写 HTTP 测试\" || created.Done {\n		t.Fatalf(\"创建的任务内容不符: %+v\", created)\n	}\n\n	// 2. POST /tasks 传入空标题 -> 期望 400 Bad Request\n	badReq := httptest.NewRequest(http.MethodPost, \"/tasks\", bytes.NewBufferString(`{\"title\":\"  \"}`))\n	badRec := httptest.NewRecorder()\n	srv.ServeHTTP(badRec, badReq)\n	if badRec.Code != http.StatusBadRequest {\n		t.Fatalf(\"空标题期望状态码 400，实际得到 %d\", badRec.Code)\n	}\n\n	// 3. PATCH /tasks/1/done 标记完成 -> 期望 200 OK\n	patchReq := httptest.NewRequest(http.MethodPatch, \"/tasks/1/done\", nil)\n	patchRec := httptest.NewRecorder()\n	srv.ServeHTTP(patchRec, patchReq)\n	if patchRec.Code != http.StatusOK {\n		t.Fatalf(\"完成任务期望状态码 200，实际得到 %d\", patchRec.Code)\n	}\n\n	// 4. PATCH /tasks/999/done 不存在的任务 -> 期望 404 Not Found\n	notFoundReq := httptest.NewRequest(http.MethodPatch, \"/tasks/999/done\", nil)\n	notFoundRec := httptest.NewRecorder()\n	srv.ServeHTTP(notFoundRec, notFoundReq)\n	if notFoundRec.Code != http.StatusNotFound {\n		t.Fatalf(\"不存在的任务期望状态码 404，实际得到 %d\", notFoundRec.Code)\n	}\n\n	// 5. DELETE /tasks/1 删除任务 -> 期望 200 OK\n	delReq := httptest.NewRequest(http.MethodDelete, \"/tasks/1\", nil)\n	delRec := httptest.NewRecorder()\n	srv.ServeHTTP(delRec, delReq)\n	if delRec.Code != http.StatusOK {\n		t.Fatalf(\"删除任务期望状态码 200，实际得到 %d\", delRec.Code)\n	}\n\n	// 6. GET /tasks 确认列表已清空 -> 期望 200 OK 且长度为 0\n	listReq := httptest.NewRequest(http.MethodGet, \"/tasks\", nil)\n	listRec := httptest.NewRecorder()\n	srv.ServeHTTP(listRec, listReq)\n	var list []task.Task\n	_ = json.Unmarshal(listRec.Body.Bytes(), &list)\n	if len(list) != 0 {\n		t.Fatalf(\"删除后期望列表为空，实际得到: %+v\", list)\n	}\n}\n\n// TestTaskServerConcurrentRequests 验证并发 HTTP 请求不会触发数据竞争\nfunc TestTaskServerConcurrentRequests(t *testing.T) {\n	srv := setupTestServer(t)\n\n	const total = 15\n	var wg sync.WaitGroup\n	wg.Add(total)\n\n	for i := 0; i < total; i++ {\n		go func(idx int) {\n			defer wg.Done()\n			payload := fmt.Sprintf(`{\"title\":\"并发HTTP任务-%d\"}`, idx)\n			postReq := httptest.NewRequest(http.MethodPost, \"/tasks\", bytes.NewBufferString(payload))\n			postRec := httptest.NewRecorder()\n			srv.ServeHTTP(postRec, postReq)\n			if postRec.Code != http.StatusCreated {\n				t.Errorf(\"并发 POST 状态码异常: %d\", postRec.Code)\n			}\n\n			getReq := httptest.NewRequest(http.MethodGet, \"/tasks\", nil)\n			getRec := httptest.NewRecorder()\n			srv.ServeHTTP(getRec, getReq)\n			if getRec.Code != http.StatusOK {\n				t.Errorf(\"并发 GET 状态码异常: %d\", getRec.Code)\n			}\n		}(i)\n	}\n\n	wg.Wait()\n}\n"
	},
	"day7-graduation": {
		"go.mod": "module example.com/taskmgr\n\ngo 1.22\n",
		"main.go": "package main\n\nimport (\n	\"fmt\"\n	\"log\"\n	\"net/http\"\n	\"os\"\n\n	\"example.com/taskmgr/server\"\n	\"example.com/taskmgr/task\"\n)\n\nfunc main() {\n	dataFile := \"tasks.json\"\n	if envFile := os.Getenv(\"TASK_FILE\"); envFile != \"\" {\n		dataFile = envFile\n	}\n\n	addr := \"127.0.0.1:8080\"\n	if envAddr := os.Getenv(\"TASK_ADDR\"); envAddr != \"\" {\n		addr = envAddr\n	}\n\n	storage := task.NewFileStorage(dataFile)\n	mgr, err := task.NewManager(storage)\n	if err != nil {\n		log.Fatalf(\"初始化任务管理器失败: %v\", err)\n	}\n\n	srv := server.NewTaskServer(mgr)\n	fmt.Printf(\"TaskMgr HTTP 服务已启动，监听地址 http://localhost%s (数据文件: %s)\\n\", addr, dataFile)\n	if err := http.ListenAndServe(addr, srv); err != nil {\n		log.Fatalf(\"HTTP 服务异常退出: %v\", err)\n	}\n}\n",
		"task/task.go": "package task\n\nimport (\n	\"errors\"\n	\"fmt\"\n	\"strings\"\n	\"sync\"\n)\n\nvar (\n	ErrNotFound     = errors.New(\"任务不存在\")\n	ErrInvalidTitle = errors.New(\"任务标题不能为空\")\n)\n\n// Task 表示单条任务，带有 JSON 序列化标签\ntype Task struct {\n	ID    int    `json:\"id\"`\n	Title string `json:\"title\"`\n	Done  bool   `json:\"done\"`\n}\n\n// Storage 定义任务持久化的最小契约接口\ntype Storage interface {\n	Load() ([]Task, error)\n	Save(tasks []Task) error\n}\n\n// Manager 负责管理任务的增删改查，内置互斥锁保证并发安全\ntype Manager struct {\n	mu      sync.Mutex\n	tasks   []Task\n	nextID  int\n	storage Storage\n}\n\n// NewManager 创建并初始化任务管理器\nfunc NewManager(storage Storage) (*Manager, error) {\n	loaded := make([]Task, 0)\n	if storage != nil {\n		var err error\n		loaded, err = storage.Load()\n		if err != nil {\n			return nil, fmt.Errorf(\"初始化加载任务失败: %w\", err)\n		}\n	}\n\n	nextID := 1\n	for _, t := range loaded {\n		if t.ID >= nextID {\n			nextID = t.ID + 1\n		}\n	}\n\n	return &Manager{\n		tasks:   loaded,\n		nextID:  nextID,\n		storage: storage,\n	}, nil\n}\n\n// saveTasks 将指定的任务切片持久化到存储层（调用方需已持有 m.mu 锁）\nfunc (m *Manager) saveTasks(tasks []Task) error {\n	if m.storage == nil {\n		return nil\n	}\n	if err := m.storage.Save(tasks); err != nil {\n		return fmt.Errorf(\"保存任务数据失败: %w\", err)\n	}\n	return nil\n}\n\n// Add 校验标题并新增一条任务（并发安全，且在保存失败时保持原内存状态不变）\nfunc (m *Manager) Add(title string) (Task, error) {\n	cleanTitle := strings.TrimSpace(title)\n	if cleanTitle == \"\" {\n		return Task{}, ErrInvalidTitle\n	}\n\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	newTask := Task{\n		ID:    m.nextID,\n		Title: cleanTitle,\n		Done:  false,\n	}\n\n	updated := make([]Task, len(m.tasks), len(m.tasks)+1)\n	copy(updated, m.tasks)\n	updated = append(updated, newTask)\n\n	if err := m.saveTasks(updated); err != nil {\n		return Task{}, err\n	}\n\n	m.tasks = updated\n	m.nextID++\n	return newTask, nil\n}\n\n// List 返回当前所有任务的副本切片（并发安全，防止外部读写底层数组引发竞争）\nfunc (m *Manager) List() []Task {\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	result := make([]Task, len(m.tasks))\n	copy(result, m.tasks)\n	return result\n}\n\n// Complete 根据 ID 将任务标记为已完成（并发安全，保存失败时回滚状态）\nfunc (m *Manager) Complete(id int) (Task, error) {\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	for i := range m.tasks {\n		if m.tasks[i].ID == id {\n			prevDone := m.tasks[i].Done\n			m.tasks[i].Done = true\n			if err := m.saveTasks(m.tasks); err != nil {\n				m.tasks[i].Done = prevDone\n				return Task{}, err\n			}\n			return m.tasks[i], nil\n		}\n	}\n	return Task{}, fmt.Errorf(\"完成任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n\n// Delete 根据 ID 删除任务（并发安全，保存失败时不修改原切片）\nfunc (m *Manager) Delete(id int) error {\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	for i, t := range m.tasks {\n		if t.ID == id {\n			updated := make([]Task, 0, len(m.tasks)-1)\n			updated = append(updated, m.tasks[:i]...)\n			updated = append(updated, m.tasks[i+1:]...)\n\n			if err := m.saveTasks(updated); err != nil {\n				return err\n			}\n			m.tasks = updated\n			return nil\n		}\n	}\n	return fmt.Errorf(\"删除任务 (ID=%d) 失败: %w\", id, ErrNotFound)\n}\n\n// ListByStatus 返回符合指定完成状态的任务列表副本（并发安全）\nfunc (m *Manager) ListByStatus(done bool) []Task {\n	m.mu.Lock()\n	defer m.mu.Unlock()\n\n	result := make([]Task, 0)\n	for _, t := range m.tasks {\n		if t.Done == done {\n			result = append(result, t)\n		}\n	}\n	return result\n}\n",
		"task/file_storage.go": "package task\n\nimport (\n	\"bytes\"\n	\"encoding/json\"\n	\"errors\"\n	\"fmt\"\n	\"os\"\n)\n\n// FileStorage 实现 Storage 接口，将任务列表持久化到 JSON 文件\ntype FileStorage struct {\n	filePath string\n}\n\n// NewFileStorage 创建基于指定文件路径的 JSON 存储实例\nfunc NewFileStorage(filePath string) *FileStorage {\n	return &FileStorage{filePath: filePath}\n}\n\n// Load 从 JSON 文件加载任务列表\n// - 若文件不存在或为空文件，返回空切片且不报错\n// - 若 JSON 内容损坏，返回明确错误以防止静默覆盖原文件\nfunc (s *FileStorage) Load() ([]Task, error) {\n	data, err := os.ReadFile(s.filePath)\n	if err != nil {\n		if errors.Is(err, os.ErrNotExist) {\n			return []Task{}, nil\n		}\n		return nil, fmt.Errorf(\"读取任务文件 %s 失败: %w\", s.filePath, err)\n	}\n\n	if len(bytes.TrimSpace(data)) == 0 {\n		return []Task{}, nil\n	}\n\n	var tasks []Task\n	if err := json.Unmarshal(data, &tasks); err != nil {\n		return nil, fmt.Errorf(\"解析任务文件 %s 的 JSON 内容失败(文件可能已损坏): %w\", s.filePath, err)\n	}\n\n	if tasks == nil {\n		return []Task{}, nil\n	}\n	return tasks, nil\n}\n\n// Save 将任务列表安全写入 JSON 文件\n// 采用“写临时文件 -> Sync 刷盘 -> 显式检查 Close 错误 -> Rename 原子替换”策略\nfunc (s *FileStorage) Save(tasks []Task) error {\n	data, err := json.MarshalIndent(tasks, \"\", \"  \")\n	if err != nil {\n		return fmt.Errorf(\"序列化任务列表为 JSON 失败: %w\", err)\n	}\n	data = append(data, '\\n')\n\n	tmpPath := s.filePath + \".tmp\"\n	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)\n	if err != nil {\n		return fmt.Errorf(\"创建临时文件 %s 失败: %w\", tmpPath, err)\n	}\n\n	// 若后续步骤出错，确保关闭文件句柄并清理残留的临时文件\n	writeErr := func() error {\n		if _, err := f.Write(data); err != nil {\n			_ = f.Close()\n			return fmt.Errorf(\"写入数据到临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		if err := f.Sync(); err != nil {\n			_ = f.Close()\n			return fmt.Errorf(\"刷盘临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		if err := f.Close(); err != nil {\n			return fmt.Errorf(\"关闭临时文件 %s 失败: %w\", tmpPath, err)\n		}\n		return nil\n	}()\n\n	if writeErr != nil {\n		_ = os.Remove(tmpPath)\n		return writeErr\n	}\n\n	if err := os.Rename(tmpPath, s.filePath); err != nil {\n		_ = os.Remove(tmpPath)\n		return fmt.Errorf(\"替换任务文件 %s 失败: %w\", s.filePath, err)\n	}\n\n	return nil\n}\n",
		"task/task_test.go": "package task\n\nimport (\n	\"errors\"\n	\"os\"\n	\"path/filepath\"\n	\"sync\"\n	\"testing\"\n)\n\n// TestManagerCRUDAndValidation 验证任务的增、查、完成、删除及错误分支\nfunc TestManagerCRUDAndValidation(t *testing.T) {\n	mgr, err := NewManager(nil)\n	if err != nil {\n		t.Fatalf(\"NewManager 失败: %v\", err)\n	}\n\n	// 1. 验证空白标题返回 ErrInvalidTitle\n	if _, err := mgr.Add(\"   \"); !errors.Is(err, ErrInvalidTitle) {\n		t.Fatalf(\"期望返回 ErrInvalidTitle，实际得到: %v\", err)\n	}\n\n	// 2. 验证正常新增\n	t1, err := mgr.Add(\"第一条任务\")\n	if err != nil {\n		t.Fatalf(\"Add 失败: %v\", err)\n	}\n	if t1.ID != 1 || t1.Title != \"第一条任务\" || t1.Done {\n		t.Fatalf(\"新增任务字段不符合预期: %+v\", t1)\n	}\n\n	// 3. 验证标记完成\n	completed, err := mgr.Complete(t1.ID)\n	if err != nil || !completed.Done {\n		t.Fatalf(\"Complete 失败: task=%+v, err=%v\", completed, err)\n	}\n\n	// 4. 验证操作不存在的任务返回 ErrNotFound\n	if _, err := mgr.Complete(999); !errors.Is(err, ErrNotFound) {\n		t.Fatalf(\"期望 Complete(999) 返回 ErrNotFound，实际得到: %v\", err)\n	}\n	if err := mgr.Delete(999); !errors.Is(err, ErrNotFound) {\n		t.Fatalf(\"期望 Delete(999) 返回 ErrNotFound，实际得到: %v\", err)\n	}\n\n	// 5. 验证删除任务\n	if err := mgr.Delete(t1.ID); err != nil {\n		t.Fatalf(\"Delete 失败: %v\", err)\n	}\n	if got := len(mgr.List()); got != 0 {\n		t.Fatalf(\"删除后期望任务数为 0，实际为 %d\", got)\n	}\n}\n\n// TestFileStoragePersistenceAndCorruption 验证文件持久化恢复与损坏检测\nfunc TestFileStoragePersistenceAndCorruption(t *testing.T) {\n	tmpDir := t.TempDir()\n	filePath := filepath.Join(tmpDir, \"tasks.json\")\n	store := NewFileStorage(filePath)\n\n	// 1. 首次启动（文件不存在）应成功且列表为空\n	mgr1, err := NewManager(store)\n	if err != nil {\n		t.Fatalf(\"首次初始化失败: %v\", err)\n	}\n	t1, _ := mgr1.Add(\"持久化任务 A\")\n	t2, _ := mgr1.Add(\"持久化任务 B\")\n	_, _ = mgr1.Complete(t1.ID)\n\n	// 2. 模拟服务重启：用同一个文件重新创建 Manager\n	mgr2, err := NewManager(store)\n	if err != nil {\n		t.Fatalf(\"重启加载失败: %v\", err)\n	}\n	list := mgr2.List()\n	if len(list) != 2 || !list[0].Done || list[1].ID != t2.ID {\n		t.Fatalf(\"重启后恢复的数据不匹配: %+v\", list)\n	}\n\n	// 3. 重启后再新增任务，ID 应从 3 继续递增\n	t3, err := mgr2.Add(\"重启后新任务 C\")\n	if err != nil || t3.ID != 3 {\n		t.Fatalf(\"期望新任务 ID 为 3，实际得到: %+v, err=%v\", t3, err)\n	}\n\n	// 4. 模拟文件内容损坏，验证能够识别并报错\n	if err := os.WriteFile(filePath, []byte(\"{corrupted json\"), 0644); err != nil {\n		t.Fatalf(\"写入损坏文件失败: %v\", err)\n	}\n	if _, err := NewManager(store); err == nil {\n		t.Fatal(\"期望加载损坏的 JSON 文件时返回错误，但返回了 nil\")\n	}\n}\n\n// TestManagerConcurrentAccess 验证多 goroutine 并发读写下的安全性（配合 go test -race）\nfunc TestManagerConcurrentAccess(t *testing.T) {\n	tmpDir := t.TempDir()\n	store := NewFileStorage(filepath.Join(tmpDir, \"concurrent_tasks.json\"))\n	mgr, err := NewManager(store)\n	if err != nil {\n		t.Fatalf(\"初始化失败: %v\", err)\n	}\n\n	const workers = 20\n	var wg sync.WaitGroup\n	wg.Add(workers)\n\n	for i := 0; i < workers; i++ {\n		go func() {\n			defer wg.Done()\n			created, err := mgr.Add(\"并发任务\")\n			if err != nil {\n				t.Errorf(\"并发 Add 失败: %v\", err)\n				return\n			}\n			_ = mgr.List()\n			if _, err := mgr.Complete(created.ID); err != nil {\n				t.Errorf(\"并发 Complete 失败: %v\", err)\n			}\n		}()\n	}\n\n	wg.Wait()\n\n	tasks := mgr.List()\n	if len(tasks) != workers {\n		t.Fatalf(\"期望最终任务数量为 %d，实际为 %d\", workers, len(tasks))\n	}\n}\n",
		"server/server.go": "package server\n\nimport (\n	\"encoding/json\"\n	\"errors\"\n	\"net/http\"\n	\"strconv\"\n\n	\"example.com/taskmgr/task\"\n)\n\n// TaskServer 封装任务管理的 HTTP 路由与处理器\ntype TaskServer struct {\n	manager *task.Manager\n	mux     *http.ServeMux\n}\n\n// NewTaskServer 创建 TaskServer 并注册所有路由规则\nfunc NewTaskServer(manager *task.Manager) *TaskServer {\n	s := &TaskServer{\n		manager: manager,\n		mux:     http.NewServeMux(),\n	}\n	s.registerRoutes()\n	return s\n}\n\nfunc (s *TaskServer) registerRoutes() {\n	s.mux.HandleFunc(\"GET /__go-learning/health\", func(w http.ResponseWriter, r *http.Request) {\n		w.Header().Set(\"X-Delivery-Go-Learning\", \"taskmgr\")\n		w.WriteHeader(http.StatusNoContent)\n	})\n	s.mux.HandleFunc(\"GET /tasks\", s.handleListTasks)\n	s.mux.HandleFunc(\"POST /tasks\", s.handleCreateTask)\n	s.mux.HandleFunc(\"PATCH /tasks/{id}/done\", s.handleCompleteTask)\n	s.mux.HandleFunc(\"DELETE /tasks/{id}\", s.handleDeleteTask)\n}\n\n// ServeHTTP 实现 http.Handler 接口，使 TaskServer 可直接传给 http.ListenAndServe 或 httptest\nfunc (s *TaskServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {\n	s.mux.ServeHTTP(w, r)\n}\n\n// createTaskRequest 定义 POST /tasks 的请求体结构\ntype createTaskRequest struct {\n	Title string `json:\"title\"`\n}\n\n// errorResponse 定义统一的错误响应 JSON 结构\ntype errorResponse struct {\n	Error string `json:\"error\"`\n}\n\n// messageResponse 定义通用操作成功提示 JSON 结构\ntype messageResponse struct {\n	Message string `json:\"message\"`\n}\n\n// writeJSON 统一设置 JSON 响应头、状态码并输出编码后的 JSON\nfunc writeJSON(w http.ResponseWriter, status int, data any) {\n	w.Header().Set(\"Content-Type\", \"application/json; charset=utf-8\")\n	w.WriteHeader(status)\n	_ = json.NewEncoder(w).Encode(data)\n}\n\nfunc writeError(w http.ResponseWriter, status int, msg string) {\n	writeJSON(w, status, errorResponse{Error: msg})\n}\n\n// parseID 校验并解析路径参数中的任务 ID（要求必须为正整数）\nfunc parseID(r *http.Request) (int, error) {\n	rawID := r.PathValue(\"id\")\n	id, err := strconv.Atoi(rawID)\n	if err != nil || id <= 0 {\n		return 0, errors.New(\"任务 ID 必须是大于 0 的整数\")\n	}\n	return id, nil\n}\n\n// handleListTasks 处理 GET /tasks\nfunc (s *TaskServer) handleListTasks(w http.ResponseWriter, r *http.Request) {\n	doneParam := r.URL.Query().Get(\"done\")\n	if doneParam == \"\" {\n		writeJSON(w, http.StatusOK, s.manager.List())\n		return\n	}\n\n	switch doneParam {\n	case \"true\":\n		writeJSON(w, http.StatusOK, s.manager.ListByStatus(true))\n	case \"false\":\n		writeJSON(w, http.StatusOK, s.manager.ListByStatus(false))\n	default:\n		writeError(w, http.StatusBadRequest, \"done 参数仅支持 true 或 false\")\n	}\n}\n\n// handleCreateTask 处理 POST /tasks\nfunc (s *TaskServer) handleCreateTask(w http.ResponseWriter, r *http.Request) {\n	defer r.Body.Close()\n\n	var req createTaskRequest\n	dec := json.NewDecoder(r.Body)\n	if err := dec.Decode(&req); err != nil {\n		writeError(w, http.StatusBadRequest, \"请求体必须是合法的 JSON 格式\")\n		return\n	}\n\n	created, err := s.manager.Add(req.Title)\n	if err != nil {\n		if errors.Is(err, task.ErrInvalidTitle) {\n			writeError(w, http.StatusBadRequest, err.Error())\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"保存任务失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusCreated, created)\n}\n\n// handleCompleteTask 处理 PATCH /tasks/{id}/done\nfunc (s *TaskServer) handleCompleteTask(w http.ResponseWriter, r *http.Request) {\n	id, err := parseID(r)\n	if err != nil {\n		writeError(w, http.StatusBadRequest, err.Error())\n		return\n	}\n\n	updated, err := s.manager.Complete(id)\n	if err != nil {\n		if errors.Is(err, task.ErrNotFound) {\n			writeError(w, http.StatusNotFound, \"指定的任务不存在\")\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"更新任务状态失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusOK, updated)\n}\n\n// handleDeleteTask 处理 DELETE /tasks/{id}\nfunc (s *TaskServer) handleDeleteTask(w http.ResponseWriter, r *http.Request) {\n	id, err := parseID(r)\n	if err != nil {\n		writeError(w, http.StatusBadRequest, err.Error())\n		return\n	}\n\n	if err := s.manager.Delete(id); err != nil {\n		if errors.Is(err, task.ErrNotFound) {\n			writeError(w, http.StatusNotFound, \"指定的任务不存在\")\n			return\n		}\n		writeError(w, http.StatusInternalServerError, \"删除任务失败\")\n		return\n	}\n\n	writeJSON(w, http.StatusOK, messageResponse{Message: \"任务已删除\"})\n}\n",
		"server/server_test.go": "package server\n\nimport (\n	\"bytes\"\n	\"encoding/json\"\n	\"fmt\"\n	\"net/http\"\n	\"net/http/httptest\"\n	\"path/filepath\"\n	\"sync\"\n	\"testing\"\n\n	\"example.com/taskmgr/task\"\n)\n\nfunc setupTestServer(t *testing.T) *TaskServer {\n	t.Helper()\n	store := task.NewFileStorage(filepath.Join(t.TempDir(), \"test_tasks.json\"))\n	mgr, err := task.NewManager(store)\n	if err != nil {\n		t.Fatalf(\"创建 Manager 失败: %v\", err)\n	}\n	return NewTaskServer(mgr)\n}\n\n// TestTaskServerEndToEnd 验证 HTTP 增删改查及异常输入状态码\nfunc TestTaskServerEndToEnd(t *testing.T) {\n	srv := setupTestServer(t)\n\n	// 1. POST /tasks 创建任务 -> 期望 201 Created\n	reqBody := bytes.NewBufferString(`{\"title\":\"编写 HTTP 测试\"}`)\n	req := httptest.NewRequest(http.MethodPost, \"/tasks\", reqBody)\n	rec := httptest.NewRecorder()\n	srv.ServeHTTP(rec, req)\n\n	if rec.Code != http.StatusCreated {\n		t.Fatalf(\"期望状态码 201，实际得到 %d, 响应: %s\", rec.Code, rec.Body.String())\n	}\n\n	var created task.Task\n	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {\n		t.Fatalf(\"解析创建响应失败: %v\", err)\n	}\n	if created.ID != 1 || created.Title != \"编写 HTTP 测试\" || created.Done {\n		t.Fatalf(\"创建的任务内容不符: %+v\", created)\n	}\n\n	// 2. POST /tasks 传入空标题 -> 期望 400 Bad Request\n	badReq := httptest.NewRequest(http.MethodPost, \"/tasks\", bytes.NewBufferString(`{\"title\":\"  \"}`))\n	badRec := httptest.NewRecorder()\n	srv.ServeHTTP(badRec, badReq)\n	if badRec.Code != http.StatusBadRequest {\n		t.Fatalf(\"空标题期望状态码 400，实际得到 %d\", badRec.Code)\n	}\n\n	// 3. PATCH /tasks/1/done 标记完成 -> 期望 200 OK\n	patchReq := httptest.NewRequest(http.MethodPatch, \"/tasks/1/done\", nil)\n	patchRec := httptest.NewRecorder()\n	srv.ServeHTTP(patchRec, patchReq)\n	if patchRec.Code != http.StatusOK {\n		t.Fatalf(\"完成任务期望状态码 200，实际得到 %d\", patchRec.Code)\n	}\n\n	// 4. PATCH /tasks/999/done 不存在的任务 -> 期望 404 Not Found\n	notFoundReq := httptest.NewRequest(http.MethodPatch, \"/tasks/999/done\", nil)\n	notFoundRec := httptest.NewRecorder()\n	srv.ServeHTTP(notFoundRec, notFoundReq)\n	if notFoundRec.Code != http.StatusNotFound {\n		t.Fatalf(\"不存在的任务期望状态码 404，实际得到 %d\", notFoundRec.Code)\n	}\n\n	// 5. DELETE /tasks/1 删除任务 -> 期望 200 OK\n	delReq := httptest.NewRequest(http.MethodDelete, \"/tasks/1\", nil)\n	delRec := httptest.NewRecorder()\n	srv.ServeHTTP(delRec, delReq)\n	if delRec.Code != http.StatusOK {\n		t.Fatalf(\"删除任务期望状态码 200，实际得到 %d\", delRec.Code)\n	}\n\n	// 6. GET /tasks 确认列表已清空 -> 期望 200 OK 且长度为 0\n	listReq := httptest.NewRequest(http.MethodGet, \"/tasks\", nil)\n	listRec := httptest.NewRecorder()\n	srv.ServeHTTP(listRec, listReq)\n	var list []task.Task\n	_ = json.Unmarshal(listRec.Body.Bytes(), &list)\n	if len(list) != 0 {\n		t.Fatalf(\"删除后期望列表为空，实际得到: %+v\", list)\n	}\n}\n\n// TestTaskServerConcurrentRequests 验证并发 HTTP 请求不会触发数据竞争\nfunc TestTaskServerConcurrentRequests(t *testing.T) {\n	srv := setupTestServer(t)\n\n	const total = 15\n	var wg sync.WaitGroup\n	wg.Add(total)\n\n	for i := 0; i < total; i++ {\n		go func(idx int) {\n			defer wg.Done()\n			payload := fmt.Sprintf(`{\"title\":\"并发HTTP任务-%d\"}`, idx)\n			postReq := httptest.NewRequest(http.MethodPost, \"/tasks\", bytes.NewBufferString(payload))\n			postRec := httptest.NewRecorder()\n			srv.ServeHTTP(postRec, postReq)\n			if postRec.Code != http.StatusCreated {\n				t.Errorf(\"并发 POST 状态码异常: %d\", postRec.Code)\n			}\n\n			getReq := httptest.NewRequest(http.MethodGet, \"/tasks\", nil)\n			getRec := httptest.NewRecorder()\n			srv.ServeHTTP(getRec, getReq)\n			if getRec.Code != http.StatusOK {\n				t.Errorf(\"并发 GET 状态码异常: %d\", getRec.Code)\n			}\n		}(i)\n	}\n\n	wg.Wait()\n}\n"
	}
};
var GO_DAYS_META = [
	{
		day: 1,
		id: "day1",
		title: "第 1 天：环境与基本语法",
		shortTitle: "环境与基本语法",
		goal: "搭建 Go 开发环境，掌握模块、包、变量、条件、循环与多返回值函数，跑通第一个程序",
		estimatedHours: "2.0～2.5 小时",
		keywords: [
			"go mod",
			"package main",
			"var 与 :=",
			"for 循环",
			"多返回值函数"
		],
		deliverable: "创建 example.com/taskmgr 模块，编写单文件 main.go 打印任务列表与进度统计",
		docFile: "Day1-环境与基本语法.md",
		expectedRunOutput: `====================================
欢迎使用 TaskMgr 命令行任务管理
====================================
#1 [x] 已完成 - 安装 Go 开发环境并运行第一个程序
#2 [x] 已完成 - 学习 Go 变量、循环与多返回值函数
#3 [ ] 待办 - 完成第 1 天课后练习
------------------------------------
统计：共 3 项，已完成 2 项，待办 1 项
提示： 进展顺利，继续保持！`,
		checklist: [
			{
				id: "d1-c1",
				text: "终端执行 go version 能看到 Go 版本号（建议 Go 1.22～1.27+）"
			},
			{
				id: "d1-c2",
				text: "沙盒目录下存在 go.mod 和 main.go 两个文件"
			},
			{
				id: "d1-c3",
				text: "执行 go run . 能正确打印 3 条任务及统计信息，无任何报错"
			},
			{
				id: "d1-c4",
				text: "理解 var 与 := 的区别，理解为什么函数能返回 (int, string) 两个值"
			}
		],
		exercises: [
			{
				id: "d1-e1",
				level: "基础",
				title: "实现优先级标签函数 priorityLabel",
				description: "编写 priorityLabel(level int) string，当 level 为 1 返回 \"【高优】\"，2 返回 \"【普通】\"，其他返回 \"【低优】\"。"
			},
			{
				id: "d1-e2",
				level: "进阶",
				title: "统计 1~100 偶数和与奇数个数",
				description: "使用 for 循环封装 sumEvenAndCountOdd(max int) (int, int)，同时返回偶数和与奇数个数。"
			},
			{
				id: "d1-e3",
				level: "挑战",
				title: "实现任务标题校验函数 validateTitle",
				description: "编写 validateTitle(title string) (bool, string)，校验空字符串与超长（>60 字节）情况。"
			}
		]
	},
	{
		day: 2,
		id: "day2",
		title: "第 2 天：组织和处理数据",
		shortTitle: "切片、Map 与指针",
		goal: "理解切片扩容机制、map 安全读写、结构体与指针传递，在内存中实现任务增删改查",
		estimatedHours: "2.5～3.0 小时",
		keywords: [
			"切片 Slice",
			"append 扩容",
			"map 与 make",
			"结构体 struct",
			"指针 * 与 &"
		],
		deliverable: "定义 Task 与 TaskManager 结构体，在内存中实现任务的新增、查询、完成与删除",
		docFile: "Day2-组织和处理数据.md",
		expectedRunOutput: `--- 1. 新增 3 条任务后 ---
#1 [ ] 待办 学习 Go 切片与底层数组机制
#2 [ ] 待办 理解结构体与指针传递
#3 [ ] 待办 清理临时测试任务

--- 2. 将任务 #1 标记为完成后 ---
操作成功：任务 #1 已标记为完成
#1 [x] 已完成 学习 Go 切片与底层数组机制
#2 [ ] 待办 理解结构体与指针传递
#3 [ ] 待办 清理临时测试任务

--- 3. 删除任务 #3 后 ---
操作成功：任务 #3 已删除
#1 [x] 已完成 学习 Go 切片与底层数组机制
#2 [ ] 待办 理解结构体与指针传递`,
		checklist: [
			{
				id: "d2-c1",
				text: "能用自己的话解释为什么 append 必须写成 s = append(s, x)"
			},
			{
				id: "d2-c2",
				text: "理解为什么 var m map[string]int 不先 make 就写入会触发 panic"
			},
			{
				id: "d2-c3",
				text: "理解为什么修改结构体字段或遍历切片修改元素时需要使用指针或下标 slice[i]"
			},
			{
				id: "d2-c4",
				text: "运行第 2 天代码能看到内存增、查、完成、删四个阶段的正确输出"
			}
		],
		exercises: [
			{
				id: "d2-e1",
				level: "基础",
				title: "使用指针重置任务状态 resetTask",
				description: "编写 resetTask(t *Task)，将任务的 Done 设为 false，并在标题前加上 \"[重置] \"。"
			},
			{
				id: "d2-e2",
				level: "进阶",
				title: "使用 map 统计完成与待办数量",
				description: "编写 countByStatus(tasks []Task) map[string]int，返回 \"done\" 和 \"pending\" 的任务数。"
			},
			{
				id: "d2-e3",
				level: "挑战",
				title: "实现按 ID 查找任务指针 findTaskByID",
				description: "编写 findTaskByID(mgr *TaskManager, id int) (*Task, bool)，返回原切片中元素的真实地址。"
			}
		]
	},
	{
		day: 3,
		id: "day3",
		title: "第 3 天：组织行为与处理错误",
		shortTitle: "方法、错误与接口",
		goal: "学会拆分包、定义方法接收者、显式处理 error、使用 defer 并通过 Storage 接口解耦存储",
		estimatedHours: "2.5～3.0 小时",
		keywords: [
			"指针接收者",
			"error 与 %w",
			"errors.Is",
			"defer",
			"Storage 接口"
		],
		deliverable: "拆分为 task 子包（task/task.go）与 main.go，定义哨兵错误与 Storage 接口",
		docFile: "Day3-组织行为与处理错误.md",
		expectedRunOutput: `[演示完成] 函数即将退出（defer 执行）
新增成功: #1 拆分子包 task
新增成功: #2 学习显式错误处理与接口
[预期之中的拦截] 标题校验未通过：任务标题不能为空
[预期之中的拦截] 找不到指定任务：完成任务 (ID=99) 失败: 任务不存在

--- 当前任务列表 ---
#1 [x] 拆分子包 task
#2 [ ] 学习显式错误处理与接口`,
		checklist: [
			{
				id: "d3-c1",
				text: "项目已拆分为 main.go 和 task/task.go，且包名与导出大小写正确"
			},
			{
				id: "d3-c2",
				text: "理解 fmt.Errorf(\"...: %w\", err) 包装错误与 errors.Is 判断哨兵错误的配合"
			},
			{
				id: "d3-c3",
				text: "理解 defer 的后进先出与函数返回前执行机制"
			},
			{
				id: "d3-c4",
				text: "理解 Storage 接口为什么能让 Manager 不依赖任何具体文件或数据库实现"
			}
		],
		exercises: [
			{
				id: "d3-e1",
				level: "基础",
				title: "为 Task 实现 String() 格式化方法",
				description: "在 Task 上定义 (t Task) Format() string 方法，返回 \"#1 [x] 标题\" 格式。"
			},
			{
				id: "d3-e2",
				level: "进阶",
				title: "新增 Rename 修改标题方法与错误校验",
				description: "为 Manager 增加 Rename(id int, newTitle string) error，校验空标题与 ID 不存在。"
			},
			{
				id: "d3-e3",
				level: "挑战",
				title: "实现 MemoryStorage 内存存储满足 Storage 接口",
				description: "编写 MemoryStorage 结构体实现 Load() 和 Save()，验证隐式接口实现。"
			}
		]
	},
	{
		day: 4,
		id: "day4",
		title: "第 4 天：JSON 与文件",
		shortTitle: "JSON 与安全写文件",
		goal: "掌握 JSON Struct Tag、文件读取异常处理，以及临时文件 + Rename 原子持久化",
		estimatedHours: "2.5～3.0 小时",
		keywords: [
			"Struct Tag",
			"encoding/json",
			"os.ErrNotExist",
			"临时文件 .tmp",
			"os.Rename"
		],
		deliverable: "新增 task/file_storage.go 实现 FileStorage，支持 tasks.json 自动加载与安全落盘",
		docFile: "Day4-JSON与文件.md",
		expectedRunOutput: `当前共有 2 条任务（已持久化至 tasks.json）：
#1 [x] 学习 encoding/json 编解码
#2 [ ] 掌握文件安全写入与原子替换`,
		checklist: [
			{
				id: "d4-c1",
				text: "理解为什么结构体字段必须首字母大写才能被 encoding/json 序列化"
			},
			{
				id: "d4-c2",
				text: "区分首次启动文件不存在（返回空切片）与 JSON 内容损坏（返回错误拒绝覆盖）"
			},
			{
				id: "d4-c3",
				text: "理解为什么写文件要先写 .tmp、执行 Sync() 与 Close() 检查错误后再 Rename"
			},
			{
				id: "d4-c4",
				text: "执行命令新增任务后，沙盒目录下生成格式良好的 tasks.json 且重启数据不丢"
			}
		],
		exercises: [
			{
				id: "d4-e1",
				level: "基础",
				title: "为 Task 增加 CreatedAt 字段与 omitempty 标签",
				description: "练习 json:\"created_at,omitempty\" 标签在字段为空与非空时的 JSON 输出差异。"
			},
			{
				id: "d4-e2",
				level: "进阶",
				title: "编写损坏 JSON 恢复或备份函数",
				description: "当检测到 JSON 解析失败时，打印清晰错误提示而不是静默清空文件。"
			},
			{
				id: "d4-e3",
				level: "挑战",
				title: "实现 ExportDoneTasks 导出已完成任务到独立文件",
				description: "筛选所有 Done == true 的任务并格式化写入 done_tasks.json。"
			}
		]
	},
	{
		day: 5,
		id: "day5",
		title: "第 5 天：HTTP 服务",
		shortTitle: "HTTP JSON API 服务",
		goal: "使用标准库 net/http（Go 1.22+ 增强路由）实现 REST 风格任务管理 API 与状态码规范",
		estimatedHours: "2.5～3.0 小时",
		keywords: [
			"net/http",
			"ServeMux 路由",
			"r.PathValue",
			"JSON 请求解析",
			"HTTP 状态码"
		],
		deliverable: "新增 server/server.go，实现 GET/POST/PATCH/DELETE 四个 HTTP JSON 接口",
		docFile: "Day5-HTTP服务.md",
		expectedRunOutput: `TaskMgr HTTP 服务已启动，监听地址 http://localhost:8080 (数据文件: tasks.json)
[提示] 可直接在右侧「🌐 HTTP 接口调试」面板一键发送 GET / POST / PATCH / DELETE 请求验证！`,
		checklist: [
			{
				id: "d5-c1",
				text: "理解 http.ResponseWriter（写响应托盘）与 *http.Request（读请求菜单）的职责"
			},
			{
				id: "d5-c2",
				text: "掌握 Go 1.22+ 的 \"PATCH /tasks/{id}/done\" 路由写法与 r.PathValue(\"id\") 读取"
			},
			{
				id: "d5-c3",
				text: "理解为什么必须先设置 Header、再调 w.WriteHeader(status)、最后写响应体"
			},
			{
				id: "d5-c4",
				text: "通过 HTTP 调试器验证新增(201)、查询(200)、空标题报错(400)与不存在报错(404)"
			}
		],
		exercises: [
			{
				id: "d5-e1",
				level: "基础",
				title: "新增 GET /health 健康检查接口",
				description: "在 registerRoutes 中注册 GET /health，返回 200 OK 与 {\"status\":\"ok\"}。"
			},
			{
				id: "d5-e2",
				level: "进阶",
				title: "新增 GET /tasks/{id} 查询单条任务详情接口",
				description: "解析路径参数 id，存在时返回 200 OK，不存在时返回 404 Not Found。"
			},
			{
				id: "d5-e3",
				level: "挑战",
				title: "限制请求体大小防止恶意大 JSON 攻击",
				description: "使用 http.MaxBytesReader 限制 POST /tasks 请求体不超过 4KB。"
			}
		]
	},
	{
		day: 6,
		id: "day6",
		title: "第 6 天：测试与并发基础",
		shortTitle: "单元测试与并发安全",
		goal: "掌握 testing 与 httptest，理解 Goroutine、Channel 与 sync.Mutex，修复 HTTP 并发数据竞争",
		estimatedHours: "2.5～3.0 小时",
		keywords: [
			"sync.Mutex",
			"Goroutine",
			"Channel",
			"testing",
			"httptest",
			"go test -race"
		],
		deliverable: "为 Manager 增加互斥锁与保存失败回滚，编写 task_test.go 与 server_test.go",
		docFile: "Day6-测试与并发基础.md",
		expectedRunOutput: `=== RUN   TestManagerCRUDAndValidation
--- PASS: TestManagerCRUDAndValidation (0.00s)
=== RUN   TestFileStoragePersistenceAndCorruption
--- PASS: TestFileStoragePersistenceAndCorruption (0.01s)
=== RUN   TestManagerConcurrentAccess
--- PASS: TestManagerConcurrentAccess (0.02s)
PASS
coverage: 86.4% of statements
ok  	example.com/taskmgr/task	0.035s
=== RUN   TestTaskServerEndToEnd
--- PASS: TestTaskServerEndToEnd (0.00s)
=== RUN   TestTaskServerConcurrentRequests
--- PASS: TestTaskServerConcurrentRequests (0.01s)
PASS
coverage: 84.1% of statements
ok  	example.com/taskmgr/server	0.024s`,
		checklist: [
			{
				id: "d6-c1",
				text: "能清楚说明为什么 HTTP 服务的每个请求在独立 Goroutine 中运行会导致数据竞争"
			},
			{
				id: "d6-c2",
				text: "理解为什么 List() 必须在持有锁时 copy 一份切片副本返回，而不能直接返回 m.tasks"
			},
			{
				id: "d6-c3",
				text: "理解当文件 Save 失败时，为什么要保持或回滚内存状态以保证内存与磁盘一致"
			},
			{
				id: "d6-c4",
				text: "运行 go test -v -cover ./... 全部 PASS，并理解 go test -race 的作用与 CGO 限制"
			}
		],
		exercises: [
			{
				id: "d6-e1",
				level: "基础",
				title: "为空标题与非法 ID 编写表格驱动测试（Table-Driven Test）",
				description: "使用 []struct{ name string; input string; wantErr error } 组织多组测试输入。"
			},
			{
				id: "d6-e2",
				level: "进阶",
				title: "使用 Channel 实现并发任务结果汇总小示例",
				description: "开启 3 个 Goroutine 模拟耗时计算，通过带缓冲 Channel 收集结果。"
			},
			{
				id: "d6-e3",
				level: "挑战",
				title: "编写 Mock FailingStorage 测试保存失败时的内存回滚",
				description: "实现一个故意在 Save 时返回错误的 Storage，验证 Complete 失败后 Done 状态已回滚。"
			}
		]
	},
	{
		day: 7,
		id: "day7",
		title: "第 7 天：整合与独立练习",
		shortTitle: "工程整合与结业实战",
		goal: "汇总完整项目，掌握 gofmt/go vet/go test 工程化验证与排错，独立实现按状态筛选功能",
		estimatedHours: "2.0～3.0 小时",
		keywords: [
			"gofmt",
			"go vet",
			"故障排查",
			"URL Query 筛选",
			"结业验收"
		],
		deliverable: "通过 6 项结业验收，独立为 GET /tasks?done=true|false 增加按状态筛选功能并补齐测试",
		docFile: "Day7-整合与独立练习.md",
		expectedRunOutput: `[工程化体检通过]
1. gofmt -s -w .         -> 格式规范，无差异
2. go vet ./...          -> 静态检查通过，无锁拷贝或占位符隐患
3. go test -v ./...      -> 核心逻辑、文件恢复、HTTP 接口与并发测试全部 PASS
4. 结业任务验证          -> GET /tasks?done=true 与 GET /tasks?done=false 筛选正常！`,
		checklist: [
			{
				id: "d7-c1",
				text: "完成结业验收 1~3：启动服务完成增删改查、重启后恢复数据、无效输入返回 400/404"
			},
			{
				id: "d7-c2",
				text: "完成结业验收 4~5：运行核心测试并能解释测试覆盖的行为，能说明并发锁保护原因"
			},
			{
				id: "d7-c3",
				text: "独立在 task.go 中实现 ListByStatus(done bool) 并在 server.go 中支持 ?done=true|false"
			},
			{
				id: "d7-c4",
				text: "在 server_test.go 中为按状态筛选功能补充单元测试并运行通过"
			}
		],
		exercises: [
			{
				id: "d7-e1",
				level: "基础",
				title: "结业步骤 1：在 Manager 中新增 ListByStatus(done bool) 方法",
				description: "加锁遍历 m.tasks，筛选 t.Done == done 的任务放入新切片返回。"
			},
			{
				id: "d7-e2",
				level: "进阶",
				title: "结业步骤 2：在 handleListTasks 中解析 ?done= 查询参数",
				description: "使用 r.URL.Query().Get(\"done\") 支持 true、false，非法值返回 400 Bad Request。"
			},
			{
				id: "d7-e3",
				level: "挑战",
				title: "结业步骤 3：编写 TestTaskServerFilterByDone 单元测试",
				description: "使用 httptest 验证 /tasks?done=true、/tasks?done=false 与 /tasks?done=invalid。"
			}
		]
	}
];
function stripNavigationQuotes(raw) {
	return raw.replace(/^> \[⬅️.*?\n\n/s, "").replace(/\n---\n\n> \[⬅️.*$/s, "").replace(/^> \[🏠.*?\n\n/s, "").replace(/\n---\n\n> \[🏠.*$/s, "").trim();
}
function extractCardAndTutorial(markdown) {
	const cleaned = stripNavigationQuotes(markdown);
	let cardMarkdown = "";
	let rest = cleaned;
	const cardMatch = cleaned.match(/\n(> ### 💡 本日大白话速懂卡片.*?)(?=\n### 1\. 学习目标)/s);
	if (cardMatch) {
		cardMarkdown = cardMatch[1].split("\n").map((line) => line.replace(/^> ?/, "")).join("\n").trim();
		rest = cleaned.replace(cardMatch[0], "\n");
	}
	let answerCode = "";
	const answerMatch = rest.match(/#### (?:第 \d 天练习参考答案|结业独立任务参考答案.*?)\n+(?:<details>\s*<summary>.*?<\/summary>\s*)?(```go\n.*?```|[\s\S]*?)(?:\n<\/details>)?$/s);
	if (answerMatch) answerCode = answerMatch[1].replace(/<\/?details>|<summary>.*?<\/summary>/g, "").trim();
	const tutorialMarkdown = rest.replace(/<details>\s*<summary>(.*?)<\/summary>/g, "> **$1**").replace(/<\/details>/g, "").replace(/<\/?b>/g, "**").trim();
	return {
		cardMarkdown,
		tutorialMarkdown,
		answerCode
	};
}
async function readGoDayDetail(docsRoot, dayNumber) {
	const meta = GO_DAYS_META.find((item) => item.day === dayNumber) || GO_DAYS_META[0];
	const filePath = path.join(docsRoot, "docs", meta.docFile);
	let raw = "";
	try {
		raw = await fs.readFile(filePath, "utf8");
	} catch {
		const steps = meta.checklist.map((item) => `- ${item.text}`).join("\n");
		const exercises = meta.exercises.map((item) => `- **${item.title}**　${item.description}`).join("\n");
		const files = GO_SANDBOX_SNAPSHOTS[meta.day === 7 ? "day7-graduation" : `day${meta.day}`] || {};
		const answerCode = Object.entries(files).filter(([name]) => name.endsWith(".go")).map(([name, content]) => `#### ${name}\n\n\`\`\`go\n${content.trimEnd()}\n\`\`\``).join("\n\n");
		return {
			...meta,
			cardMarkdown: meta.goal,
			answerCode,
			tutorialMarkdown: `### 学习目标\n\n${meta.goal}\n\n### 练习步骤\n\n${steps}\n\n### 本日练习\n\n${exercises}\n\n### 交付成果\n\n${meta.deliverable}`
		};
	}
	const { cardMarkdown, tutorialMarkdown, answerCode } = extractCardAndTutorial(raw);
	return {
		...meta,
		cardMarkdown,
		tutorialMarkdown,
		answerCode
	};
}
async function readGoGuideAndCheatSheet(docsRoot) {
	let guideMarkdown = "";
	let cheatSheetMarkdown = "";
	try {
		guideMarkdown = await fs.readFile(path.join(docsRoot, "README.md"), "utf8");
	} catch {
		guideMarkdown = "# 《7 天上手 Go》通俗图解导读\n\n按顺序学习七章，每天阅读目标、修改课程代码并完成检查清单。前四天练习命令行任务管理，后三天加入 HTTP 接口、测试和并发安全。";
	}
	try {
		cheatSheetMarkdown = stripNavigationQuotes(await fs.readFile(path.join(docsRoot, "docs", "08-结业验收与语法速查表.md"), "utf8"));
	} catch {
		cheatSheetMarkdown = "# Go 核心语法与常用命令速查表\n\n- `go run .` 编译并运行当前模块\n- `go test -v -cover ./...` 运行测试并显示覆盖率\n- `go test -race ./...` 检查数据竞争\n- `go vet ./...` 运行静态检查\n- `gofmt -s -w .` 格式化 Go 源码";
	}
	return {
		guideMarkdown,
		cheatSheetMarkdown
	};
}
//#endregion
//#region plugins/go-learning/service.ts
var execFileAsync = promisify(execFile);
var goPath = [...new Set([
	...(process.env.PATH || "").split(path.delimiter),
	"/opt/homebrew/bin",
	"/usr/local/go/bin",
	"/usr/local/bin",
	path.join(os.homedir(), "go", "bin")
].filter((directory) => path.isAbsolute(directory)))];
var taskManagerOrigin = "http://127.0.0.1:8080";
var CANDIDATE_GO_PATHS = [
	"/opt/homebrew/bin/go",
	"/usr/local/go/bin/go",
	"/usr/local/bin/go",
	path.join(os.homedir(), "go", "bin", "go"),
	path.join(os.homedir(), "sdk", "go", "bin", "go")
];
async function findGoBinary() {
	try {
		const { stdout } = await execFileAsync("which", ["go"], {
			env: { PATH: goPath.join(path.delimiter) },
			timeout: 3e3
		});
		const resolved = stdout.trim();
		if (resolved) return resolved;
	} catch {}
	for (const candidate of CANDIDATE_GO_PATHS) try {
		await fs.access(candidate, fs.constants.X_OK);
		return candidate;
	} catch {}
	return null;
}
async function isTaskManagerListening() {
	try {
		const response = await fetch(`${taskManagerOrigin}/__go-learning/health`, {
			redirect: "error",
			signal: AbortSignal.timeout(600)
		});
		await response.body?.cancel();
		return response.status === 204 && response.headers.get("x-delivery-go-learning") === "taskmgr";
	} catch {
		return false;
	}
}
var activeGoProcesses = /* @__PURE__ */ new Set();
function stopGoLearningProcesses() {
	for (const stop of activeGoProcesses) stop();
}
function runGoProcess(binary, args, options) {
	return new Promise((resolve) => {
		const child = spawn(binary, args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			detached: process.platform !== "win32",
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "", stderr = "", failure = "", httpStarted = false;
		let preview;
		const stop = () => {
			if (!child.pid) return;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch {}
		};
		activeGoProcesses.add(stop);
		const timeout = setTimeout(() => {
			failure = "Go 命令运行超时";
			stop();
		}, 45e3);
		child.stdout.setEncoding("utf8").on("data", (text) => {
			stdout += text;
			if (stdout.length > 1048576) {
				stdout = stdout.slice(0, 1048576);
				failure = "Go 命令输出超过限制";
				stop();
			}
			if (options.httpPreview && !preview && stdout.includes("TaskMgr HTTP 服务已启动")) preview = setTimeout(() => {
				httpStarted = true;
				stop();
			}, 1e3);
		});
		child.stderr.setEncoding("utf8").on("data", (text) => {
			stderr += text;
			if (stderr.length > 1048576) {
				stderr = stderr.slice(0, 1048576);
				failure = "Go 命令输出超过限制";
				stop();
			}
		});
		child.on("error", (error) => {
			failure = error.message;
		});
		child.on("exit", stop);
		child.on("close", (code) => {
			activeGoProcesses.delete(stop);
			clearTimeout(timeout);
			clearTimeout(preview);
			resolve({
				exitCode: failure ? 1 : httpStarted ? 0 : code ?? 1,
				stdout: stdout.trimEnd(),
				stderr: [stderr.trimEnd(), failure].filter(Boolean).join("\n"),
				httpStarted
			});
		});
	});
}
async function createGoLearningService(stateDir, options) {
	await fs.mkdir(stateDir, { recursive: true });
	const progressFile = path.join(stateDir, "progress.json");
	const root = await fs.realpath(options.rootDir);
	const sandboxParent = path.join(root, "work");
	const sandboxPath = path.join(sandboxParent, "go-taskmgr-lab");
	const docsPath = path.join(options.rootDir, "work", "go-learning-docs");
	const toolchainHome = path.join(await fs.realpath(stateDir), "toolchain");
	await fs.mkdir(toolchainHome, {
		recursive: true,
		mode: 448
	});
	const toolchainEnv = (goBinary) => ({
		PATH: [.../* @__PURE__ */ new Set([path.dirname(goBinary), ...goPath])].join(path.delimiter),
		HOME: toolchainHome,
		USERPROFILE: toolchainHome,
		GOCACHE: path.join(toolchainHome, "cache"),
		GOMODCACHE: path.join(toolchainHome, "modules"),
		GOENV: "off",
		GOWORK: "off",
		GOTOOLCHAIN: "local",
		GOPROXY: "off",
		...process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}
	});
	let progress = {
		currentDay: 1,
		activeSnapshot: "day1",
		checkedItems: [],
		completedExercises: [],
		notes: {},
		updatedAt: (/* @__PURE__ */ new Date()).toISOString()
	};
	try {
		const raw = JSON.parse(await fs.readFile(progressFile, "utf8"));
		if (raw && typeof raw === "object") progress = {
			currentDay: typeof raw.currentDay === "number" && raw.currentDay >= 1 && raw.currentDay <= 7 ? raw.currentDay : 1,
			activeSnapshot: typeof raw.activeSnapshot === "string" && raw.activeSnapshot in GO_SANDBOX_SNAPSHOTS ? raw.activeSnapshot : "day1",
			checkedItems: Array.isArray(raw.checkedItems) ? raw.checkedItems.filter((x) => typeof x === "string") : [],
			completedExercises: Array.isArray(raw.completedExercises) ? raw.completedExercises.filter((x) => typeof x === "string") : [],
			notes: raw.notes && typeof raw.notes === "object" ? raw.notes : {},
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : (/* @__PURE__ */ new Date()).toISOString()
		};
	} catch {}
	async function sandboxDirectory(subdirectory = "") {
		const directories = [sandboxParent, sandboxPath];
		if (subdirectory) directories.push(path.join(sandboxPath, subdirectory));
		for (const directory of directories) {
			await fs.mkdir(directory).catch((error) => {
				if (error.code !== "EEXIST") throw error;
			});
			if (!(await fs.lstat(directory)).isDirectory()) throw new Error("沙盒路径必须是普通目录");
		}
		return directories.at(-1);
	}
	async function sandboxFile(relativePath) {
		const folder = path.posix.dirname(relativePath);
		const directory = await sandboxDirectory(folder === "." ? "" : folder);
		const file = path.join(directory, path.posix.basename(relativePath));
		const stat = await fs.lstat(file).catch((error) => {
			if (error.code !== "ENOENT") throw error;
		});
		if (stat && !stat.isFile()) throw new Error("沙盒只允许访问普通文件");
		return file;
	}
	let progressWrite = Promise.resolve();
	function saveProgress() {
		progress.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
		const contents = JSON.stringify(progress, null, 2);
		progressWrite = progressWrite.catch(() => {}).then(async () => {
			const tmpFile = `${progressFile}.tmp`;
			await fs.writeFile(tmpFile, contents, "utf8");
			await fs.rename(tmpFile, progressFile);
		});
		return progressWrite;
	}
	async function applySnapshot(snapshotKey) {
		const files = GO_SANDBOX_SNAPSHOTS[snapshotKey] || GO_SANDBOX_SNAPSHOTS.day1;
		await sandboxDirectory();
		for (const sub of [
			"",
			"task",
			"server"
		]) try {
			const targetDir = await sandboxDirectory(sub);
			const entries = await fs.readdir(targetDir, { withFileTypes: true });
			for (const entry of entries) if (entry.isFile() && (entry.name.endsWith(".go") || entry.name === "go.mod")) await fs.unlink(path.join(targetDir, entry.name));
		} catch {}
		for (const [relPath, content] of Object.entries(files)) {
			const absPath = await sandboxFile(relPath);
			await fs.writeFile(absPath, content, "utf8");
		}
		const pkgJsonPath = await sandboxFile("package.json");
		await fs.writeFile(pkgJsonPath, JSON.stringify({
			name: "go-taskmgr-lab",
			version: "1.0.0",
			private: true,
			description: "Delivery Workspace - Go 实训工坊沙盒工程 (example.com/taskmgr)",
			scripts: {
				dev: "PORT=8080 go run .",
				start: "PORT=8080 go run .",
				build: "go build -o taskmgr .",
				test: "go test -v ./..."
			}
		}, null, 2) + "\n", "utf8");
		progress.activeSnapshot = snapshotKey;
		await saveProgress();
	}
	try {
		await fs.access(path.join(sandboxPath, "go.mod"));
		await fs.access(path.join(sandboxPath, "package.json"));
	} catch {
		await applySnapshot(progress.activeSnapshot);
	}
	async function readSandboxFiles() {
		await sandboxDirectory();
		const result = [];
		async function walk(relDir) {
			const absDir = relDir ? path.join(sandboxPath, relDir) : sandboxPath;
			let entries;
			try {
				entries = await fs.readdir(absDir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
				const absPath = path.join(sandboxPath, relPath);
				if (entry.isDirectory()) {
					if (["task", "server"].includes(entry.name)) await walk(relPath);
				} else if (entry.isFile() && (entry.name.endsWith(".go") || entry.name === "go.mod" || entry.name === "tasks.json")) try {
					const [stat, content] = await Promise.all([fs.stat(absPath), fs.readFile(absPath, "utf8")]);
					result.push({
						path: relPath,
						content,
						size: stat.size,
						updatedAt: stat.mtime.toISOString()
					});
				} catch {}
			}
		}
		await walk("");
		result.sort((a, b) => {
			const order = (p) => p === "main.go" ? 0 : p === "go.mod" ? 1 : p.startsWith("task/") ? 2 : p.startsWith("server/") ? 3 : 4;
			return order(a.path) - order(b.path) || a.path.localeCompare(b.path);
		});
		return {
			files: result,
			tasksJsonContent: result.find((f) => f.path === "tasks.json")?.content ?? null
		};
	}
	async function detectEnvironment() {
		const [goBinary, port8080Listening] = await Promise.all([findGoBinary(), isTaskManagerListening()]);
		if (!goBinary) return {
			installed: false,
			version: "未检测到本机 Go 工具链",
			goBinaryPath: "",
			goproxy: "未检测",
			cgoEnabled: "未检测",
			installHint: "macOS 推荐在终端执行 `brew install go`，或前往 https://go.dev/dl/ 下载安装包。未安装前本工坊已为您开启「预期输出模拟与沙盒演练模式」！",
			port8080Listening
		};
		const env = toolchainEnv(goBinary);
		try {
			const [verRes, envRes] = await Promise.all([execFileAsync(goBinary, ["version"], {
				env,
				timeout: 4e3
			}), execFileAsync(goBinary, [
				"env",
				"GOPROXY",
				"CGO_ENABLED"
			], {
				env,
				timeout: 4e3
			})]);
			const envLines = envRes.stdout.trim().split("\n");
			return {
				installed: true,
				version: verRes.stdout.trim(),
				goBinaryPath: goBinary,
				goproxy: envLines[0]?.trim() || "default",
				cgoEnabled: envLines[1]?.trim() || "1",
				installHint: "本机 Go 工具链已就绪，点击右侧运行按钮将直接调用真实编译器与测试器。",
				port8080Listening
			};
		} catch (error) {
			return {
				installed: false,
				version: error instanceof Error ? error.message : "Go 环境检测异常",
				goBinaryPath: goBinary,
				goproxy: "",
				cgoEnabled: "",
				installHint: "请检查本机 Go 安装权限。",
				port8080Listening
			};
		}
	}
	async function overview(dayOverride) {
		const currentDay = dayOverride && dayOverride >= 1 && dayOverride <= 7 ? dayOverride : progress.currentDay;
		const [environment, currentDayDetail, sandbox, guideAndCheat] = await Promise.all([
			detectEnvironment(),
			readGoDayDetail(docsPath, currentDay),
			readSandboxFiles(),
			readGoGuideAndCheatSheet(docsPath)
		]);
		const days = GO_DAYS_META.map(({ docFile: _doc, expectedRunOutput: _out, ...summary }) => summary);
		return {
			environment,
			sandboxPath,
			docsPath,
			progress: structuredClone({
				...progress,
				currentDay
			}),
			days,
			currentDayDetail,
			sandboxFiles: sandbox.files,
			tasksJsonContent: sandbox.tasksJsonContent,
			guideMarkdown: guideAndCheat.guideMarkdown,
			cheatSheetMarkdown: guideAndCheat.cheatSheetMarkdown
		};
	}
	async function getDay(dayNumber) {
		const clamped = Math.max(1, Math.min(7, dayNumber));
		return {
			dayDetail: await readGoDayDetail(docsPath, clamped),
			progress: structuredClone({
				...progress,
				currentDay: clamped
			})
		};
	}
	async function updateProgress(input) {
		if (input.currentDay !== void 0) progress.currentDay = Math.max(1, Math.min(7, input.currentDay));
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
		if (input.note) progress.notes[String(input.note.day)] = input.note.content;
		await saveProgress();
		return structuredClone(progress);
	}
	async function saveSandboxFile(relFilePath, content) {
		const normalized = path.posix.normalize(relFilePath.replace(/\\/g, "/")).replace(/^\/+/, "");
		if (normalized.startsWith("..") || normalized.includes("/../")) throw new Error("不允许访问沙盒目录之外的文件");
		if (!/^(?:go\.mod|tasks\.json|(?:(?:task|server)\/)?[A-Za-z0-9_-]+\.go)$/.test(normalized)) throw new Error("只可保存课程沙盒中的 Go 文件、go.mod 或 tasks.json");
		const absPath = await sandboxFile(normalized);
		await fs.writeFile(absPath, content, "utf8");
		return readSandboxFiles();
	}
	async function runCommand(action, extraArgs = []) {
		const startTime = Date.now();
		const goBinary = await findGoBinary();
		const dayMeta = GO_DAYS_META.find((d) => d.day === progress.currentDay) || GO_DAYS_META[0];
		const spec = {
			version: {
				cmd: "go",
				args: ["version"],
				display: "go version"
			},
			run: {
				cmd: "go",
				args: [
					"run",
					".",
					...extraArgs
				],
				display: ["go run .", ...extraArgs].join(" ")
			},
			test: {
				cmd: "go",
				args: [
					"test",
					"-v",
					"-cover",
					"./..."
				],
				display: "go test -v -cover ./..."
			},
			race: {
				cmd: "go",
				args: [
					"test",
					"-race",
					"./..."
				],
				display: "go test -race ./..."
			},
			vet: {
				cmd: "go",
				args: ["vet", "./..."],
				display: "go vet ./..."
			},
			fmt: {
				cmd: "gofmt",
				args: [
					"-s",
					"-w",
					"."
				],
				display: "gofmt -s -w ."
			}
		}[action];
		if (!goBinary) {
			let simulatedStdout = "";
			if (action === "version") simulatedStdout = "go version go1.27.3 darwin/arm64 (预期输出示例)";
			else if (action === "run") {
				simulatedStdout = dayMeta.expectedRunOutput;
				if (progress.currentDay >= 4) {
					const tasksFile = await sandboxFile("tasks.json");
					try {
						await fs.access(tasksFile);
					} catch {
						await fs.writeFile(tasksFile, `${JSON.stringify([{
							id: 1,
							title: "学习 encoding/json 编解码",
							done: true
						}, {
							id: 2,
							title: "掌握文件安全写入与原子替换",
							done: false
						}], null, 2)}\n`, "utf8");
					}
				}
			} else if (action === "test") simulatedStdout = GO_DAYS_META[5].expectedRunOutput;
			else if (action === "race") simulatedStdout = "ok  	example.com/taskmgr/task	0.142s\nok  	example.com/taskmgr/server	0.118s\n[并发竞态检测通过：未发现未加锁的共享内存竞争]";
			else if (action === "vet") simulatedStdout = "[go vet ./... 检查通过：退出码 0，未发现静态代码隐患]";
			else if (action === "fmt") simulatedStdout = "[gofmt -s -w . 执行完成：所有 .go 文件已按官方标准格式化]";
			return {
				action,
				command: spec.display,
				exitCode: 0,
				stdout: simulatedStdout,
				stderr: "",
				durationMs: Date.now() - startTime,
				ranAt: (/* @__PURE__ */ new Date()).toISOString(),
				simulated: true,
				notice: "本机暂未安装 Go 工具链（未实际执行二进制命令），以上为当前章节代码的标准预期输出预览。安装 Go 后点击按钮将直接执行真实编译！"
			};
		}
		const binDir = path.dirname(goBinary);
		const executable = spec.cmd === "gofmt" ? path.join(binDir, "gofmt") : goBinary;
		const cwd = await sandboxDirectory();
		if ((await fs.readdir(cwd, {
			withFileTypes: true,
			recursive: true
		})).some((entry) => entry.isSymbolicLink())) throw new Error("运行前请移除沙盒中的符号链接");
		const { httpStarted, ...output } = await runGoProcess(executable, spec.args, {
			cwd,
			env: toolchainEnv(goBinary),
			httpPreview: action === "run" && [
				"day5",
				"day6",
				"day7",
				"day7-graduation"
			].includes(progress.activeSnapshot)
		});
		return {
			action,
			command: spec.display,
			...output,
			stdout: output.stdout || (output.exitCode === 0 && (action === "vet" || action === "fmt") ? `[${spec.display} 执行成功，无报错输出]` : ""),
			durationMs: Date.now() - startTime,
			ranAt: (/* @__PURE__ */ new Date()).toISOString(),
			simulated: false,
			...httpStarted ? { notice: "单次启动演示已结束。可用 HTTP 调试面板模拟请求，也可在终端启动课程服务后调试实际接口。" } : {}
		};
	}
	async function debugHttpEndpoint(input) {
		const startTime = Date.now();
		const requestUrl = new URL(input.path, taskManagerOrigin);
		if (requestUrl.origin !== taskManagerOrigin || !/^\/tasks(?:\/|$)/.test(requestUrl.pathname)) throw new Error("HTTP 调试仅支持 TaskMgr 的 /tasks 接口");
		if (await isTaskManagerListening()) try {
			const res = await fetch(requestUrl, {
				method: input.method,
				redirect: "manual",
				signal: AbortSignal.timeout(3e3),
				headers: input.body ? { "Content-Type": "application/json" } : void 0,
				body: input.method === "POST" ? input.body : void 0
			});
			const text = await res.text();
			const { tasksJsonContent } = await readSandboxFiles();
			return {
				method: input.method,
				path: input.path,
				status: res.status,
				statusText: res.statusText || (res.status === 200 ? "OK" : res.status === 201 ? "Created" : "Error"),
				responseBody: text,
				mode: "live-server",
				durationMs: Date.now() - startTime,
				tasksJsonContent
			};
		} catch {
			throw new Error("TaskMgr 服务未返回完整响应，请核对运行状态");
		}
		const tasksFile = await sandboxFile("tasks.json");
		let tasks = [];
		try {
			const raw = await fs.readFile(tasksFile, "utf8");
			if (raw.trim()) {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) tasks = parsed;
			}
		} catch (error) {
			if (error.code !== "ENOENT") return {
				method: input.method,
				path: input.path,
				status: 500,
				statusText: "Internal Server Error",
				responseBody: JSON.stringify({ error: "tasks.json 文件内容已损坏，无法解析 JSON" }, null, 2),
				mode: "sandbox-simulator",
				durationMs: Date.now() - startTime,
				tasksJsonContent: null
			};
		}
		const saveTasksFile = async (nextTasks) => {
			const content = `${JSON.stringify(nextTasks, null, 2)}\n`;
			await fs.writeFile(tasksFile, content, "utf8");
			return content;
		};
		const parsedUrl = requestUrl;
		const pathname = parsedUrl.pathname;
		if (input.method === "GET" && pathname === "/tasks") {
			const doneParam = parsedUrl.searchParams.get("done");
			let resultTasks = tasks;
			if (doneParam !== null && doneParam !== "") {
				if (doneParam !== "true" && doneParam !== "false") {
					const { tasksJsonContent } = await readSandboxFiles();
					return {
						method: "GET",
						path: input.path,
						status: 400,
						statusText: "Bad Request",
						responseBody: JSON.stringify({ error: "done 参数仅支持 true 或 false" }, null, 2),
						mode: "sandbox-simulator",
						durationMs: Date.now() - startTime,
						tasksJsonContent
					};
				}
				const wantDone = doneParam === "true";
				resultTasks = tasks.filter((t) => t.done === wantDone);
			}
			const { tasksJsonContent } = await readSandboxFiles();
			return {
				method: "GET",
				path: input.path,
				status: 200,
				statusText: "OK",
				responseBody: JSON.stringify(resultTasks, null, 2),
				mode: "sandbox-simulator",
				durationMs: Date.now() - startTime,
				tasksJsonContent
			};
		}
		if (input.method === "POST" && pathname === "/tasks") {
			let payload;
			try {
				payload = JSON.parse(input.body || "{}");
			} catch {
				const { tasksJsonContent } = await readSandboxFiles();
				return {
					method: "POST",
					path: input.path,
					status: 400,
					statusText: "Bad Request",
					responseBody: JSON.stringify({ error: "请求体必须是合法的 JSON 格式" }, null, 2),
					mode: "sandbox-simulator",
					durationMs: Date.now() - startTime,
					tasksJsonContent
				};
			}
			const cleanTitle = typeof payload.title === "string" ? payload.title.trim() : "";
			if (!cleanTitle) {
				const { tasksJsonContent } = await readSandboxFiles();
				return {
					method: "POST",
					path: input.path,
					status: 400,
					statusText: "Bad Request",
					responseBody: JSON.stringify({ error: "任务标题不能为空" }, null, 2),
					mode: "sandbox-simulator",
					durationMs: Date.now() - startTime,
					tasksJsonContent
				};
			}
			const created = {
				id: tasks.reduce((max, item) => Math.max(max, item.id), 0) + 1,
				title: cleanTitle,
				done: false
			};
			tasks.push(created);
			const savedContent = await saveTasksFile(tasks);
			return {
				method: "POST",
				path: input.path,
				status: 201,
				statusText: "Created",
				responseBody: JSON.stringify(created, null, 2),
				mode: "sandbox-simulator",
				durationMs: Date.now() - startTime,
				tasksJsonContent: savedContent
			};
		}
		const patchMatch = /^\/tasks\/([^/]+)\/done$/.exec(pathname);
		if (input.method === "PATCH" && patchMatch) {
			const id = Number(patchMatch[1]);
			if (!Number.isInteger(id) || id <= 0) {
				const { tasksJsonContent } = await readSandboxFiles();
				return {
					method: "PATCH",
					path: input.path,
					status: 400,
					statusText: "Bad Request",
					responseBody: JSON.stringify({ error: "任务 ID 必须是大于 0 的整数" }, null, 2),
					mode: "sandbox-simulator",
					durationMs: Date.now() - startTime,
					tasksJsonContent
				};
			}
			const target = tasks.find((t) => t.id === id);
			if (!target) {
				const { tasksJsonContent } = await readSandboxFiles();
				return {
					method: "PATCH",
					path: input.path,
					status: 404,
					statusText: "Not Found",
					responseBody: JSON.stringify({ error: "指定的任务不存在" }, null, 2),
					mode: "sandbox-simulator",
					durationMs: Date.now() - startTime,
					tasksJsonContent
				};
			}
			target.done = true;
			const savedContent = await saveTasksFile(tasks);
			return {
				method: "PATCH",
				path: input.path,
				status: 200,
				statusText: "OK",
				responseBody: JSON.stringify(target, null, 2),
				mode: "sandbox-simulator",
				durationMs: Date.now() - startTime,
				tasksJsonContent: savedContent
			};
		}
		const deleteMatch = /^\/tasks\/([^/]+)$/.exec(pathname);
		if (input.method === "DELETE" && deleteMatch) {
			const id = Number(deleteMatch[1]);
			if (!Number.isInteger(id) || id <= 0) {
				const { tasksJsonContent } = await readSandboxFiles();
				return {
					method: "DELETE",
					path: input.path,
					status: 400,
					statusText: "Bad Request",
					responseBody: JSON.stringify({ error: "任务 ID 必须是大于 0 的整数" }, null, 2),
					mode: "sandbox-simulator",
					durationMs: Date.now() - startTime,
					tasksJsonContent
				};
			}
			const idx = tasks.findIndex((t) => t.id === id);
			if (idx < 0) {
				const { tasksJsonContent } = await readSandboxFiles();
				return {
					method: "DELETE",
					path: input.path,
					status: 404,
					statusText: "Not Found",
					responseBody: JSON.stringify({ error: "指定的任务不存在" }, null, 2),
					mode: "sandbox-simulator",
					durationMs: Date.now() - startTime,
					tasksJsonContent
				};
			}
			tasks.splice(idx, 1);
			const savedContent = await saveTasksFile(tasks);
			return {
				method: "DELETE",
				path: input.path,
				status: 200,
				statusText: "OK",
				responseBody: JSON.stringify({ message: "任务已删除" }, null, 2),
				mode: "sandbox-simulator",
				durationMs: Date.now() - startTime,
				tasksJsonContent: savedContent
			};
		}
		const { tasksJsonContent } = await readSandboxFiles();
		return {
			method: input.method,
			path: input.path,
			status: 404,
			statusText: "Not Found",
			responseBody: JSON.stringify({ error: "未匹配的路由路径" }, null, 2),
			mode: "sandbox-simulator",
			durationMs: Date.now() - startTime,
			tasksJsonContent
		};
	}
	return {
		async close() {
			await progressWrite;
		},
		overview,
		getDay,
		updateProgress,
		applySnapshot,
		readSandboxFiles,
		saveSandboxFile,
		runCommand,
		debugHttpEndpoint
	};
}
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function joinValues(array, separator = "|") {
	return array.map((val) => stringifyPrimitive(val)).join(separator);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
function cached(getter) {
	return { get value() {
		{
			const value = getter();
			Object.defineProperty(this, "value", { value });
			return value;
		}
	} };
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const ratio = val / step;
	const roundedRatio = Math.round(ratio);
	const tolerance = 4 * Number.EPSILON * Math.max(Math.abs(ratio), 1);
	if (Math.abs(ratio - roundedRatio) < tolerance) return 0;
	return ratio - roundedRatio;
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) {
		const descriptors = Object.getOwnPropertyDescriptors(def);
		Object.assign(mergedDescriptors, descriptors);
	}
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__*/ cached(() => {
	if (globalConfig.jitless) return false;
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	if (o instanceof Map) return new Map(o);
	if (o instanceof Set) return new Set(o);
	return o;
}
var propertyKeyTypes = /* @__PURE__*/ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function stringifyPrimitive(value) {
	if (typeof value === "bigint") return value.toString() + "n";
	if (typeof value === "string") return `"${value}"`;
	return `${value}`;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin !== void 0 && shape[k]._zod.optout === "optional";
	});
}
var NUMBER_FORMAT_RANGES = /*@__PURE__*/ (() => ({
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
}))();
function pick(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = {};
			for (const key of Reflect.ownKeys(mask)) {
				if (!Object.prototype.hasOwnProperty.call(currDef.shape, key)) throw new Error(`Unrecognized key: "${String(key)}"`);
				if (!mask[key]) continue;
				assignProp(newShape, key, currDef.shape[key]);
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function omit(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = { ...schema._zod.def.shape };
			for (const key of Reflect.ownKeys(mask)) {
				if (!Object.prototype.hasOwnProperty.call(currDef.shape, key)) throw new Error(`Unrecognized key: "${String(key)}"`);
				if (!mask[key]) continue;
				delete newShape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = schema._zod.def.shape;
		for (const key of Reflect.ownKeys(shape)) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function merge(a, b) {
	if (!b?._zod?.def) throw new Error("Invalid input to merge: expected an object schema. To merge a plain shape, use `.extend()`.");
	if (a._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
	return clone(a, mergeDefs(a._zod.def, {
		get shape() {
			const _shape = {
				...a._zod.def.shape,
				...b._zod.def.shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		},
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: b._zod.def.checks ?? []
	}));
}
function partial(Class, schema, mask, name = "partial") {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(`.${name}() cannot be used on object schemas containing refinements`);
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const oldShape = schema._zod.def.shape;
			const shape = { ...oldShape };
			if (mask) for (const key of Reflect.ownKeys(mask)) {
				if (!Object.prototype.hasOwnProperty.call(oldShape, key)) throw new Error(`Unrecognized key: "${String(key)}"`);
				if (!mask[key]) continue;
				shape[key] = Class ? new Class({
					type: "optional",
					innerType: oldShape[key]
				}) : oldShape[key];
			}
			else for (const key of Reflect.ownKeys(oldShape)) shape[key] = Class ? new Class({
				type: "optional",
				innerType: oldShape[key]
			}) : oldShape[key];
			assignProp(this, "shape", shape);
			return shape;
		},
		checks: []
	}));
}
function required(Class, schema, mask) {
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const oldShape = schema._zod.def.shape;
		const shape = { ...oldShape };
		if (mask) for (const key of Reflect.ownKeys(mask)) {
			if (!Object.prototype.hasOwnProperty.call(shape, key)) throw new Error(`Unrecognized key: "${String(key)}"`);
			if (!mask[key]) continue;
			shape[key] = new Class({
				type: "nonoptional",
				innerType: oldShape[key]
			});
		}
		else for (const key of Reflect.ownKeys(oldShape)) shape[key] = new Class({
			type: "nonoptional",
			innerType: oldShape[key]
		});
		assignProp(this, "shape", shape);
		return shape;
	} }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function explicitlyAborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue === false) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
function attachSchema(issues, start, inst) {
	var _a;
	for (let i = start; i < issues.length; i++) (_a = issues[i]).schema ?? (_a.schema = inst);
}
function finalizeIssue(iss, ctx, config) {
	var _a;
	const traits = iss.inst?._zod?.traits;
	if (traits?.has("$ZodType")) {
		if (traits.has("$ZodCheck")) (_a = iss).schema ?? (_a.schema = iss.inst);
		else iss.schema = iss.inst;
	}
	const schemaError = iss.schema !== iss.inst ? iss.schema?._zod.def?.error : void 0;
	const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(schemaError?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	const { inst: _inst, schema: _schema, continue: _continue, input: _input, ...rest } = iss;
	rest.path ?? (rest.path = []);
	rest.message = message;
	if (ctx?.reportInput) rest.input = _input;
	return rest;
}
var highSurrogate = /[\uD800-\uDBFF]/;
function codePointLength(str) {
	const units = str.length;
	if (!highSurrogate.test(str)) return units;
	let count = units;
	for (let i = 0; i < units - 1; i++) if ((str.charCodeAt(i) & 64512) === 55296 && (str.charCodeAt(i + 1) & 64512) === 56320) {
		count--;
		i++;
	}
	return count;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function parsedType(data) {
	const t = typeof data;
	switch (t) {
		case "number": return Number.isNaN(data) ? "nan" : "number";
		case "object": {
			if (data === null) return "null";
			if (Array.isArray(data)) return "array";
			const obj = data;
			if (obj && Object.getPrototypeOf(obj) !== Object.prototype && "constructor" in obj && obj.constructor) return obj.constructor.name;
		}
	}
	return t;
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}
/**
* Installs a trait's members on its prototype. Each value builds that member for the instance on first read; the built value shadows the accessor as an own property, so a detached `const { parse } = schema` keeps working.
*
* Call this from a `proto` initializer, which runs once per prototype — never per instance.
*/
function members(proto, table) {
	for (const key in table) {
		const desc = Object.getOwnPropertyDescriptor(table, key);
		if (desc.get) Object.defineProperty(proto, key, {
			...desc,
			enumerable: false
		});
		else defineBound(proto, key, desc.value);
	}
}
/** Shadows a prototype member with an own value, so a getter that builds from the instance runs once. */
function own(inst, key, value, enumerable = true) {
	Object.defineProperty(inst, key, {
		configurable: true,
		writable: true,
		enumerable,
		value
	});
	return value;
}
/** Like {@link own}, for a member that was never an own data property and has to stay out of `Object.keys`. */
function hide(inst, key, value) {
	return own(inst, key, value, false);
}
function defineBound(proto, key, fn) {
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			return this == null ? fn : own(this, key, fn.bind(this));
		},
		set(value) {
			own(this, key, value);
		}
	});
}
/** Returns the prototype to install on, or `undefined` if this group is already installed on it. */
function claim(inst, sentinel) {
	const proto = Object.getPrototypeOf(inst);
	return sentinel in proto ? void 0 : proto;
}
var installing;
var broke = false;
var breaker = {
	configurable: true,
	get() {
		broke = true;
	}
};
/**
* Installs a lazily-derived internal on the `_zod` prototype of `inst`'s
* constructor, computed from the internals object itself and cached there on
* first read. One accessor per constructor rather than one per instance.
*/
function defineLazyInternal(inst, key, compute) {
	const proto = Object.getPrototypeOf(inst._zod);
	if (key in proto && installing !== inst._zod) {
		installing = void 0;
		return;
	}
	installing = inst._zod;
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			Object.defineProperty(this, key, breaker);
			const outer = broke;
			broke = false;
			try {
				const value = compute(this);
				if (broke) delete this[key];
				else Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					value
				});
				broke = broke || outer;
				return value;
			} catch (err) {
				delete this[key];
				broke = broke || outer;
				throw err;
			}
		},
		set(value) {
			Object.defineProperty(this, key, {
				configurable: true,
				writable: true,
				value
			});
		}
	});
}
/**
* Installs `key` on `inst`'s prototype, computed by `make` on first read and cached there as an own
* data property. One accessor per constructor rather than one per instance, because an own accessor
* puts every instance after the first into v8 dictionary mode. The key doubles as the sentinel.
*/
function installLazyProp(inst, key, make, enumerable) {
	const proto = claim(inst, key);
	if (!proto) return;
	Object.defineProperty(proto, key, {
		configurable: true,
		get() {
			const desc = {
				configurable: true,
				writable: true,
				enumerable,
				value: void 0
			};
			Object.defineProperty(this, key, desc);
			desc.value = make(this);
			Object.defineProperty(this, key, desc);
			return desc.value;
		},
		set(value) {
			Object.defineProperty(this, key, {
				configurable: true,
				writable: true,
				enumerable,
				value
			});
		}
	});
}
/** Marks the thunk `_catch` synthesises for a constant catch value. `Function.length` cannot tell that thunk from a user callback — rest and defaulted parameters both report arity 0 — and a user callback reads `ctx.error`, whose issues only finalize correctly against the caller's per-parse error map. Provenance can say what arity cannot. A plain string key rather than `Symbol.for`, whose call at module scope no bundler can prove pure — the same shape that anchored `urlCanParse` into every build. */
var CONSTANT_CATCH = "~constantCatch";
/** Wraps a constant catch value in a thunk tagged with {@link CONSTANT_CATCH}. */
function constantCatch(value) {
	const fn = () => value;
	fn[CONSTANT_CATCH] = true;
	return fn;
}
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/core.js
var _a$1;
var _zodDesc$1 = {
	value: void 0,
	enumerable: false
};
var _E = "captureStackTrace" in Error ? Error : null;
function newError(Definition) {
	const E = _E;
	if (E) {
		const saved = E.stackTraceLimit;
		if (typeof saved === "number") {
			try {
				E.stackTraceLimit = 0;
			} catch {
				_E = null;
				return new Definition();
			}
			try {
				return new Definition();
			} finally {
				E.stackTraceLimit = saved;
			}
		}
	}
	return new Definition();
}
function $constructor(name, initializer, proto, params) {
	const zodProto = {};
	function Internals(def) {
		this.def = def;
		this.constr = _;
		this.traits = /* @__PURE__ */ new Set();
	}
	Internals.prototype = zodProto;
	const protoMembers = proto;
	const initialized = protoMembers && /* @__PURE__ */ new WeakSet();
	function init(inst, def) {
		if (!inst._zod) {
			_zodDesc$1.value = new Internals(def);
			try {
				Object.defineProperty(inst, "_zod", _zodDesc$1);
			} finally {
				_zodDesc$1.value = void 0;
			}
		}
		if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		if (initialized) {
			const own = Object.getPrototypeOf(inst);
			const ctorProto = inst._zod.constr.prototype;
			let up = own;
			while (up && up !== ctorProto) up = Object.getPrototypeOf(up);
			const target = up ?? own;
			if (!initialized.has(target)) {
				initialized.add(target);
				members(target, protoMembers);
			}
		}
		const proto = _.prototype;
		for (const k in proto) {
			if (!Object.prototype.hasOwnProperty.call(proto, k)) continue;
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		const inst = params?.Parent ? newError(Definition) : this;
		init(inst, def);
		const deferred = inst._zod.deferred;
		if (deferred) {
			for (const fn of deferred) fn();
			inst._zod.deferred = void 0;
		}
		const pp = globalThis.__zod_globalConfig?.postProcessor;
		if (pp) pp(inst);
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
(_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/errors.js
function _getMessage() {
	const internals = this._zod;
	internals.message ?? (internals.message = JSON.stringify(internals.def, jsonStringifyReplacer, 2));
	return internals.message;
}
function _setMessage(value) {
	this._zod.message = value;
}
var _messageDesc = {
	get: _getMessage,
	set: _setMessage,
	enumerable: true,
	configurable: true
};
var _zodDesc = {
	value: void 0,
	enumerable: false
};
var _issuesDesc = {
	value: void 0,
	enumerable: false
};
var _installedToString = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
var initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	_zodDesc.value = inst._zod;
	Object.defineProperty(inst, "_zod", _zodDesc);
	_issuesDesc.value = def;
	Object.defineProperty(inst, "issues", _issuesDesc);
	_zodDesc.value = void 0;
	_issuesDesc.value = void 0;
	Object.defineProperty(inst, "message", _messageDesc);
	const proto = Object.getPrototypeOf(inst);
	if (!_installedToString.has(proto)) {
		_installedToString.add(proto);
		Object.defineProperty(proto, "toString", {
			configurable: true,
			enumerable: false,
			get() {
				const value = () => this.message;
				Object.defineProperty(this, "toString", {
					value,
					configurable: true,
					writable: true
				});
				return value;
			},
			set(value) {
				Object.defineProperty(this, "toString", {
					value,
					configurable: true,
					writable: true
				});
			}
		});
	}
};
var $ZodError = $constructor("$ZodError", initializer$1);
var $ZodRealError = $constructor("$ZodError", initializer$1, void 0, { Parent: Error });
/** Get-or-create `obj[key]` as an own data property. A path segment naming an inherited member
* ("toString", "constructor") would otherwise read through to the prototype, and assigning
* "__proto__" would hit the setter instead of creating a key. */
function node(obj, key, make) {
	if (!Object.prototype.hasOwnProperty.call(obj, key)) {
		if (key === "__proto__") Object.defineProperty(obj, key, {
			value: make(),
			writable: true,
			enumerable: true,
			configurable: true
		});
		else obj[key] = make();
	}
	return obj[key];
}
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) node(fieldErrors, sub.path[0], () => []).push(mapper(sub));
	else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error, path = []) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else if (issue.code === "invalid_element") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else {
			const fullpath = [...path, ...issue.path];
			if (fullpath.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < fullpath.length) {
					const el = fullpath[i];
					const terminal = i === fullpath.length - 1;
					if (el === "_errors") {
						if (terminal) curr._errors.push(mapper(issue));
						i++;
						continue;
					}
					if (!Object.prototype.hasOwnProperty.call(curr, el)) Object.defineProperty(curr, el, {
						value: { _errors: [] },
						enumerable: true,
						writable: true,
						configurable: true
					});
					const node = curr[el];
					if (terminal) node._errors.push(mapper(issue));
					curr = node;
					i++;
				}
			}
		}
	};
	processError(error);
	return fieldErrors;
}
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/parse.js
function finalizeParams(callee, params) {
	return {
		callee: params?.callee ?? callee,
		Err: params?.Err
	};
}
var _parse = (_Err) => {
	const fn = (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: false
		} : { async: false };
		const result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) throw new $ZodAsyncError();
		if (result.issues.length) {
			const e = new ((_params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, _params?.callee ?? fn);
			throw e;
		}
		return result.value;
	};
	return fn;
};
var _parseAsync = (_Err) => {
	const fn = async (schema, value, _ctx, params) => {
		const ctx = _ctx ? {
			..._ctx,
			async: true
		} : { async: true };
		let result = schema._zod.run({
			value,
			issues: []
		}, ctx);
		if (result instanceof Promise) result = await result;
		if (result.issues.length) {
			const e = new ((params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
			captureStackTrace(e, params?.callee ?? fn);
			throw e;
		}
		return result.value;
	};
	return fn;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? {
		success: false,
		error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
var safeParse$1 = /* @__PURE__*/ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? {
		success: false,
		error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
var safeParseAsync$1 = /* @__PURE__*/ _safeParseAsync($ZodRealError);
var _encode = (_Err) => {
	const parse = _parse(_Err);
	const fn = (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" };
		return parse(schema, value, ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _decode = (_Err) => {
	const parse = _parse(_Err);
	const fn = (schema, value, _ctx, _params) => {
		return parse(schema, value, _ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _encodeAsync = (_Err) => {
	const parseAsync = _parseAsync(_Err);
	const fn = async (schema, value, _ctx, _params) => {
		const ctx = _ctx ? {
			..._ctx,
			direction: "backward"
		} : { direction: "backward" };
		return await parseAsync(schema, value, ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _decodeAsync = (_Err) => {
	const parseAsync = _parseAsync(_Err);
	const fn = async (schema, value, _ctx, _params) => {
		return await parseAsync(schema, value, _ctx, finalizeParams(fn, _params));
	};
	return fn;
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/regexes.js
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
function nanoidOfLength(length) {
	return new RegExp(`^[a-zA-Z0-9_-]{${length}}$`);
}
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
var duration = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
var uuid = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
var email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji$1 = `^[\\p{Extended_Pictographic}\\p{Emoji_Component}]+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^[A-Za-z0-9_-]*$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
/** Anchors a pattern source. The interpolation lives here rather than at the call site because
* esbuild will not drop a `@__PURE__` call whose own argument interpolates a variable, but it
* will drop `anchor(dateSource)`. Keeping it inline pinned `date` into every bundle. */
function anchor(source) {
	return new RegExp(`^${source}$`);
}
var date = /*@__PURE__*/ anchor(dateSource);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : args.seconds ? `${hhmm}:[0-5]\\d(?:\\.\\d+)?` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime(args) {
	const opts = ["Z"];
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const qualified = `${timeSource({
		precision: args.precision,
		seconds: true
	})}(?:${opts.join("|")})`;
	const timeRegex = args.local ? `${qualified}|${timeSource({ precision: args.precision })}` : qualified;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string$1 = (params) => {
	const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
	return new RegExp(`^${regex}$`);
};
var integer = /^-?\d+$/;
var number$1 = /^-?\d+(?:\.\d+)?$/;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/checks.js
var $ZodCheck = /*@__PURE__*/ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
/** Default `when` for length-based checks: run only on non-nullish values with a `length`. */
var _whenHasLength = (payload) => {
	const val = payload.value;
	return !nullish(val) && val.length !== void 0;
};
var numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
var $ZodCheckLessThan = /*@__PURE__*/ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
		if (def.value < curr) {
			if (def.inclusive) bag.maximum = def.value;
			else bag.exclusiveMaximum = def.value;
		}
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin: numericOriginMap[typeof payload.value] ?? origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckGreaterThan = /*@__PURE__*/ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
		if (def.value > curr) {
			if (def.inclusive) bag.minimum = def.value;
			else bag.exclusiveMinimum = def.value;
		}
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin: numericOriginMap[typeof payload.value] ?? origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMultipleOf = /*@__PURE__*/ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		var _a;
		(_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
	});
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? def.value !== BigInt(0) && payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckNumberFormat = /*@__PURE__*/ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		bag.minimum = minimum;
		bag.maximum = maximum;
		if (isInt) bag.pattern = integer;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMaxLength = /*@__PURE__*/ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
		if (def.maximum < curr) inst._zod.bag.maximum = def.maximum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		if ((typeof input === "string" && units > def.maximum ? codePointLength(input) : units) <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMinLength = /*@__PURE__*/ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
		if (def.minimum > curr) inst._zod.bag.minimum = def.minimum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		if ((typeof input === "string" && units >= def.minimum && units < def.minimum * 2 ? codePointLength(input) : units) >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckLengthEquals = /*@__PURE__*/ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = _whenHasLength);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.minimum = def.length;
		bag.maximum = def.length;
		bag.length = def.length;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const units = input.length;
		const length = typeof input === "string" && units >= def.length && units <= def.length * 2 ? codePointLength(input) : units;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckStringFormat = /*@__PURE__*/ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		if (def.pattern) {
			bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
			bag.patterns.add(def.pattern);
		}
	});
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /*@__PURE__*/ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckLowerCase = /*@__PURE__*/ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /*@__PURE__*/ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /*@__PURE__*/ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position},}${escapedRegex}` : escapedRegex);
	def.pattern = pattern;
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckStartsWith = /*@__PURE__*/ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckEndsWith = /*@__PURE__*/ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckOverwrite = /*@__PURE__*/ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = [], closed = {}) {
		this.content = [];
		this.indent = 0;
		this.args = args;
		this.closed = closed;
	}
	indented(fn) {
		this.indent += 1;
		fn(this);
		this.indent -= 1;
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const content = this?.content ?? [``];
		return new F(...Object.keys(this.closed), `return function (${this.args.join(", ")}) {\n${content.join("\n")}\n};`)(...Object.values(this.closed));
	}
};
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/versions.js
var version = {
	major: 4,
	minor: 5,
	patch: 4
};
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/schemas.js
var $ZodType = /*@__PURE__*/ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const defChecks = inst._zod.def.checks;
	const checks = inst._zod.traits.has("$ZodCheck") ? [inst, ...defChecks ?? []] : defChecks?.length ? [...defChecks] : [];
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			if (payload.memo) return payload;
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (explicitlyAborted(payload)) continue;
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					attachSchema(payload.issues, currLen, inst);
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					attachSchema(payload.issues, currLen, inst);
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
}, {
	get "~standard"() {
		return hide(this, "~standard", standardProps(this));
	},
	set "~standard"(value) {
		own(this, "~standard", value);
	}
});
/** The Standard Schema surface for `inst`. Shared so wrappers can extend it without forcing it. */
var toStandardResult = (r) => r.success ? { value: r.data } : { issues: r.error?.issues };
function standardProps(inst) {
	return {
		validate: (value) => {
			try {
				return toStandardResult(safeParse$1(inst, value));
			} catch (_) {
				return safeParseAsync$1(inst, value).then(toStandardResult);
			}
		},
		vendor: "zod",
		version: 1
	};
}
var $ZodString = /*@__PURE__*/ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string$1(inst._zod.bag);
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
var $ZodStringFormat = /*@__PURE__*/ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
var $ZodGUID = /*@__PURE__*/ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
var $ZodUUID = /*@__PURE__*/ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid(v));
	} else def.pattern ?? (def.pattern = uuid());
	$ZodStringFormat.init(inst, def);
});
var $ZodEmail = /*@__PURE__*/ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
/** Parses a URL for `$ZodURL`, applying the one guard the URL constructor cannot express. Returns the parsed URL, or a code naming the stage that rejected it — the runtime needs that distinction to pick an issue note, and compiled code only needs to know it is not a URL. */
function parseURLObject(trimmed, def) {
	if (!def.normalize && def.protocol?.source === httpProtocol.source && !/^https?:\/\//i.test(trimmed)) return 1;
	try {
		return new URL(trimmed);
	} catch {
		return 2;
	}
}
var asciiTabOrNewline = /[\t\n\r]/g;
/** The URL parser deletes every ASCII tab, LF and CR from its input before it parses, so `new URL("https://exa\nmple.com")` reports on `example.com`. Applying the same deletion to the returned value closes the half of that divergence which can move the host; the parser's other rewrite, stripping C0 controls at the edges, cannot. */
function stripTabAndNewline(value) {
	return value.replace(asciiTabOrNewline, "");
}
function urlHostnameOk(url, hostname) {
	hostname.lastIndex = 0;
	return hostname.test(url.hostname);
}
function urlProtocolOk(url, protocol) {
	protocol.lastIndex = 0;
	return protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol);
}
var $ZodURL = /*@__PURE__*/ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			const url = parseURLObject(trimmed, def);
			if (url === 1) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid URL format",
					input: payload.value,
					inst,
					continue: !def.abort
				});
				return;
			}
			if (url === 2) {
				payload.issues.push({
					code: "invalid_format",
					format: "url",
					input: payload.value,
					inst,
					continue: !def.abort
				});
				return;
			}
			if (def.hostname && !urlHostnameOk(url, def.hostname)) payload.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid hostname",
				pattern: def.hostname.source,
				input: payload.value,
				inst,
				continue: !def.abort
			});
			if (def.protocol && !urlProtocolOk(url, def.protocol)) payload.issues.push({
				code: "invalid_format",
				format: "url",
				note: "Invalid protocol",
				pattern: def.protocol.source,
				input: payload.value,
				inst,
				continue: !def.abort
			});
			payload.value = def.normalize ? url.href : stripTabAndNewline(trimmed);
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
var $ZodEmoji = /*@__PURE__*/ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /*@__PURE__*/ $constructor("$ZodNanoID", (inst, def) => {
	if (def.length !== void 0 && (!Number.isInteger(def.length) || def.length < 1)) throw new Error(`Invalid nanoid length: ${def.length}`);
	def.pattern ?? (def.pattern = def.length === void 0 ? nanoid : nanoidOfLength(def.length));
	$ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var $ZodCUID = /*@__PURE__*/ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /*@__PURE__*/ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
var $ZodULID = /*@__PURE__*/ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
var $ZodXID = /*@__PURE__*/ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /*@__PURE__*/ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /*@__PURE__*/ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime(def));
	$ZodStringFormat.init(inst, def);
	if (def.local || def.precision === -1) {
		inst._zod.bag.laxFormat = true;
		inst._zod.onattach.push((s) => {
			s._zod.bag.laxFormat = true;
		});
	}
});
var $ZodISODate = /*@__PURE__*/ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date);
	$ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /*@__PURE__*/ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time(def));
	$ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /*@__PURE__*/ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration);
	$ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /*@__PURE__*/ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv4`;
});
/** An IPv6 address is written with hex digits, colons and dots, and nothing else. The guard is what makes the check below an IPv6 check: `new URL("http://[...]")` parses an authority, not an address, so `@` and `\` re-delimit it and `"::@1\\"` validates against the host `0.0.0.1`. The URL parser also deletes ASCII tab, LF and CR rather than failing, which is how `"::1\n"` validated as `::1`. */
var ipv6Alphabet = /^[0-9a-fA-F:.]+$/;
function isValidIPv6(value) {
	if (!ipv6Alphabet.test(value)) return false;
	try {
		new URL(`http://[${value}]`);
		return true;
	} catch {
		return false;
	}
}
var $ZodIPv6 = /*@__PURE__*/ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv6`;
	inst._zod.check = (payload) => {
		if (!isValidIPv6(payload.value)) payload.issues.push({
			code: "invalid_format",
			format: "ipv6",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCIDRv4 = /*@__PURE__*/ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
function isValidCIDRv6(value) {
	const parts = value.split("/");
	if (parts.length !== 2) return false;
	const [address, prefix] = parts;
	if (!prefix) return false;
	const prefixNum = Number(prefix);
	if (`${prefixNum}` !== prefix) return false;
	if (prefixNum < 0 || prefixNum > 128) return false;
	return isValidIPv6(address);
}
var $ZodCIDRv6 = /*@__PURE__*/ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (!isValidCIDRv6(payload.value)) payload.issues.push({
			code: "invalid_format",
			format: "cidrv6",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (/\s/.test(data)) return false;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
var $ZodBase64 = /*@__PURE__*/ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64";
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64URL(data) {
	if (!base64url.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
var $ZodBase64URL = /*@__PURE__*/ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64url);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64url";
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodE164 = /*@__PURE__*/ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
var $ZodJWT = /*@__PURE__*/ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodNumber = /*@__PURE__*/ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = inst._zod.bag.pattern ?? number$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? String(input) : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
var $ZodNumberFormat = /*@__PURE__*/ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
var $ZodUnknown = /*@__PURE__*/ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
var $ZodNever = /*@__PURE__*/ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
var $ZodArray = /*@__PURE__*/ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = memo ? memo.alloc(inst, payload, Array(input.length), ctx) : Array(input.length);
		const proms = [];
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else handleArrayResult(result, payload, i);
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
function handlePropertyResult(result, final, key, input, optin, optout) {
	const isPresent = key in input;
	const isOptionalOut = optout === "optional";
	if (!isPresent && isOptionalOut && optin === "optional") return;
	if (result.issues.length) {
		if (optin !== void 0 && isOptionalOut && !isPresent) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (!isPresent && optin === void 0) {
		if (!result.issues.length) final.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: void 0,
			path: [key]
		});
		return;
	}
	if (result.value === void 0) {
		if (isPresent) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
var NO_SYMBOL_KEYS = [];
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	const ownSymbols = Object.getOwnPropertySymbols(def.shape);
	const symbolKeys = ownSymbols.length ? ownSymbols : NO_SYMBOL_KEYS;
	const allKeys = symbolKeys.length ? [...keys, ...symbolKeys] : keys;
	for (const k of allKeys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${String(k)}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		allKeys,
		symbolKeys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const optin = _catchall.optin;
	const optout = _catchall.optout;
	for (const key in input) {
		if (keySet.has(key)) continue;
		if (key === "__proto__") {
			if (t === "never") unrecognized.push(key);
			continue;
		}
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
		else handlePropertyResult(r, payload, key, input, optin, optout);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst,
		continue: true
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
var propShapes = /* @__PURE__ */ new WeakMap();
var $ZodObject = /*@__PURE__*/ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	if (!Object.getOwnPropertyDescriptor(def, "shape")?.get) {
		const sh = def.shape;
		propShapes.set(def, sh);
		Object.defineProperty(def, "shape", { get: () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			propShapes.set(def, newSh);
			return newSh;
		} });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazyInternal(inst, "propValues", (zod) => {
		const shape = zod.def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				if (!Object.prototype.hasOwnProperty.call(propValues, key)) assignProp(propValues, key, /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
				if (field.optin !== void 0) propValues[key].add(void 0);
			}
		}
		return propValues;
	});
	const isObject$1 = isObject;
	const catchall = def.catchall;
	let value;
	const memo = globalConfig.memoizer;
	memo?.attach(inst);
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = memo ? memo.alloc(inst, payload, {}, ctx) : {};
		const proms = [];
		const shape = value.shape;
		for (const key of value.allKeys) {
			if (key === "__proto__") continue;
			const el = shape[key];
			const optin = el._zod.optin;
			const optout = el._zod.optout;
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, optin, optout)));
			else handlePropertyResult(r, payload, key, input, optin, optout);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
	};
});
var $ZodObjectJIT = /*@__PURE__*/ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const memo = globalConfig.memoizer;
	const generateFastpass = (shape) => {
		const normalized = _normalized.value;
		const syms = normalized.symbolKeys;
		const doc = new Doc(["payload", "ctx"], {
			shape,
			inst,
			memo,
			syms
		});
		const parseStr = (k) => `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		const prefixStr = (id, k) => `
          for (let i = 0; i < ${id}.issues.length; i++) {
            const iss = ${id}.issues[i];
            iss.path = iss.path ? [${k}, ...iss.path] : [${k}];
            payload.issues.push(iss);
          }`;
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.allKeys) ids[key] = `key_${counter++}`;
		doc.write(memo ? `const newResult = memo.alloc(inst, payload, {}, ctx);` : `const newResult = {};`);
		for (const key of normalized.allKeys) {
			if (key === "__proto__") continue;
			const id = ids[key];
			const k = typeof key === "symbol" ? `syms[${syms.indexOf(key)}]` : esc(key);
			const isPresent = `${k} in input`;
			const schema = shape[key];
			const optin = schema?._zod?.optin;
			const isOptionalIn = optin !== void 0;
			const isOptionalOut = schema?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(k)};`);
			if (isOptionalIn && isOptionalOut) {
				const assign = optin === "optional" ? `${id}_present` : `${id}.value !== undefined || ${id}_present`;
				doc.write(`
        const ${id}_present = ${isPresent};
        if (!${id}.issues.length || ${id}_present) {
          if (${id}.issues.length) {${prefixStr(id, k)}
          }

          if (${assign}) {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
			} else if (!isOptionalIn) doc.write(`
        const ${id}_present = ${isPresent};
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
        }

        if (${id}_present) {
          newResult[${k}] = ${id}.value;
        }

      `);
			else doc.write(`
        if (${id}.issues.length) {${prefixStr(id, k)}
        }
        
        if (${id}.value === undefined) {
          if (${isPresent}) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }

      `);
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		return doc.compile();
	};
	let fastpass;
	const isObject$2 = isObject;
	const jit = !globalConfig.jitless;
	const fastEnabled = jit && allowsEval.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
var $ZodUnion = /*@__PURE__*/ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.options.some((o) => o._zod.optin === "defaulted") ? "defaulted" : zod.def.options.some((o) => o._zod.optin !== void 0) ? "optional" : void 0);
	defineLazyInternal(inst, "optout", (zod) => zod.def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazyInternal(inst, "values", (zod) => {
		if (zod.def.options.every((o) => o._zod.values)) return new Set(zod.def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazyInternal(inst, "pattern", (zod) => {
		if (zod.def.options.every((o) => o._zod.pattern)) {
			const patterns = zod.def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const first = def.options.length === 1 ? def.options[0]._zod.run : null;
	inst._zod.parse = (payload, ctx) => {
		if (first) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
var $ZodIntersection = /*@__PURE__*/ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		if (Object.prototype.hasOwnProperty.call(newObj, "__proto__")) delete newObj.__proto__;
		for (const key of sharedKeys) {
			if (key === "__proto__") continue;
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	const keyIssues = /* @__PURE__ */ new Map();
	const collect = (iss, side) => {
		let keys;
		if (iss.code === "unrecognized_keys" && !iss.path?.length) {
			unrecIssue ?? (unrecIssue = iss);
			keys = iss.keys;
		} else if (iss.code === "invalid_key" && iss.origin === "record" && iss.path?.length === 1) {
			const k = String(iss.path[0]);
			if (!keyIssues.has(k)) keyIssues.set(k, iss);
			keys = [k];
		} else return false;
		for (const k of keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k)[side] = true;
		}
		return true;
	};
	for (const iss of left.issues) if (!collect(iss, "l")) result.issues.push(iss);
	for (const iss of right.issues) if (!collect(iss, "r")) result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length) {
		const aggregated = unrecIssue ? bothKeys.filter((k) => unrecIssue.keys.includes(k)) : [];
		if (aggregated.length) result.issues.push({
			...unrecIssue,
			keys: aggregated
		});
		for (const k of bothKeys) if (!aggregated.includes(k) && keyIssues.has(k)) result.issues.push(keyIssues.get(k));
	}
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) {
		if (aborted(result)) return result;
		throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	}
	result.value = merged.data;
	return result;
}
var $ZodEnum = /*@__PURE__*/ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	const patternValues = values.filter((k) => propertyKeyTypes.has(typeof k));
	inst._zod.pattern = new RegExp(patternValues.length ? `^(${patternValues.map((o) => escapeRegex(o.toString())).join("|")})$` : "^[^\\s\\S]$");
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
var $ZodTransform = /*@__PURE__*/ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	globalConfig.memoizer?.guard(inst);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		return payload;
	};
});
function handleOptionalResult(payload, result) {
	payload.value = result.issues.length ? void 0 : result.value;
	return payload;
}
var $ZodOptional = /*@__PURE__*/ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
	inst._zod.optout = "optional";
	defineLazyInternal(inst, "values", (zod) => {
		const values = zod.def.innerType._zod.values;
		return values ? /* @__PURE__ */ new Set([...values, void 0]) : void 0;
	});
	defineLazyInternal(inst, "pattern", (zod) => {
		const pattern = zod.def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === void 0) {
			if (def.innerType._zod.optin !== "defaulted") return payload;
			const result = def.innerType._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) return result.then((result) => handleOptionalResult(payload, result));
			return handleOptionalResult(payload, result);
		}
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodExactOptional = /*@__PURE__*/ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	defineLazyInternal(inst, "pattern", (zod) => zod.def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodNullable = /*@__PURE__*/ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
	defineLazyInternal(inst, "pattern", (zod) => {
		const pattern = zod.def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazyInternal(inst, "values", (zod) => {
		return zod.def.innerType._zod.values ? /* @__PURE__ */ new Set([...zod.def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodDefault = /*@__PURE__*/ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "defaulted";
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
var $ZodPrefault = /*@__PURE__*/ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "defaulted";
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodNonOptional = /*@__PURE__*/ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => {
		const v = zod.def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
function handleCatchResult(payload, result, def, ctx) {
	if (!result.issues.length) {
		payload.value = result.value;
		if (result.memo) payload.memo = true;
		return payload;
	}
	payload.value = def.catchValue({
		...result,
		value: payload.value,
		error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
		input: payload.value
	});
	return payload;
}
var $ZodCatch = /*@__PURE__*/ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType._zod.optin === "defaulted" ? "defaulted" : "optional");
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType._zod.optout);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run({
			value: payload.value,
			issues: []
		}, ctx);
		if (result instanceof Promise) return result.then((result) => handleCatchResult(payload, result, def, ctx));
		return handleCatchResult(payload, result, def, ctx);
	};
});
var $ZodPipe = /*@__PURE__*/ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "values", (zod) => zod.def.in._zod.values);
	defineLazyInternal(inst, "optin", (zod) => zod.def.in._zod.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.out._zod.optout);
	defineLazyInternal(inst, "propValues", (zod) => zod.def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.some((iss) => iss.code !== "unrecognized_keys")) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues
	}, ctx);
}
var $ZodReadonly = /*@__PURE__*/ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazyInternal(inst, "propValues", (zod) => zod.def.innerType._zod.propValues);
	defineLazyInternal(inst, "values", (zod) => zod.def.innerType._zod.values);
	defineLazyInternal(inst, "optin", (zod) => zod.def.innerType?._zod?.optin);
	defineLazyInternal(inst, "optout", (zod) => zod.def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	if (!payload.memo) payload.value = Object.freeze(payload.value);
	return payload;
}
var $ZodCustom = /*@__PURE__*/ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/memoizer.js
var $ZodCyclicError = class extends Error {
	constructor() {
		super(`Cannot parse a reference cycle that closes through a transform`);
		this.name = "ZodCyclicError";
	}
};
/** Keyed off the context object every schema in one parse call already shares. */
var STATE = "~memo";
var NO_ISSUES = [];
function cloneIssues(issues) {
	return issues.map((iss) => iss.path ? {
		...iss,
		path: iss.path.slice()
	} : { ...iss });
}
var recursive = /*@__PURE__*/ new WeakMap();
/** Whether this schema's subtree contains a cycle, so one parse can re-enter it. */
function isRecursive(inst, stack) {
	const cached = recursive.get(inst);
	if (cached !== void 0) return cached;
	if (stack.has(inst)) return true;
	stack.add(inst);
	let result = false;
	const check = (child) => {
		if (!result && child?._zod && isRecursive(child, stack)) result = true;
	};
	const def = inst._zod.def;
	switch (def.type) {
		case "object":
			for (const key of Reflect.ownKeys(def.shape)) check(def.shape[key]);
			check(def.catchall);
			break;
		case "array":
			check(def.element);
			break;
		case "tuple":
			for (const el of def.items) check(el);
			check(def.rest);
			break;
		case "record":
		case "map":
			check(def.keyType);
			check(def.valueType);
			break;
		case "set":
			check(def.valueType);
			break;
		case "union":
			for (const el of def.options) check(el);
			break;
		case "intersection":
			check(def.left);
			check(def.right);
			break;
		case "optional":
		case "nullable":
		case "default":
		case "prefault":
		case "catch":
		case "readonly":
		case "nonoptional":
		case "promise":
		case "success":
			check(def.innerType);
			break;
		case "pipe":
			check(def.in);
			check(def.out);
			break;
		case "function":
			check(def.input);
			check(def.output);
			break;
		case "lazy":
			check(inst._zod.innerType);
			break;
		case "template_literal":
		case "string":
		case "number":
		case "int":
		case "boolean":
		case "bigint":
		case "symbol":
		case "undefined":
		case "null":
		case "void":
		case "never":
		case "any":
		case "unknown":
		case "date":
		case "nan":
		case "enum":
		case "literal":
		case "file":
		case "transform":
		case "custom": break;
		default: for (const key in def) {
			const desc = Object.getOwnPropertyDescriptor(def, key);
			if (!desc || desc.get) continue;
			const value = desc.value;
			if (!value || typeof value !== "object") continue;
			if (value._zod) check(value);
			else if (Array.isArray(value)) for (const el of value) check(el);
		}
	}
	stack.delete(inst);
	recursive.set(inst, result);
	return result;
}
function bucketFor(state, inst) {
	let bucket = state.buckets.get(inst);
	if (!bucket) {
		bucket = /* @__PURE__ */ new Map();
		state.buckets.set(inst, bucket);
	}
	return bucket;
}
var handoff;
var open = [];
var memo = {
	alloc(_inst, payload, empty) {
		const bucket = handoff;
		if (!bucket) return empty;
		handoff = void 0;
		const entry = {
			value: empty,
			issues: null
		};
		bucket.set(payload.value, entry);
		open.push(entry);
		return empty;
	},
	guard(inst) {
		var _a;
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred.push(() => {
			const base = inst._zod.parse;
			const wrapped = (payload, ctx) => {
				if (ctx.direction !== "backward" && isBackEdge(ctx, payload.value)) throw new $ZodCyclicError();
				return base(payload, ctx);
			};
			inst._zod.parse = wrapped;
			if (inst._zod.run === base) inst._zod.run = wrapped;
		});
	},
	attach(inst) {
		var _a;
		let isRecursiveInst;
		let lastCtx;
		let lastBucket;
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred.push(() => {
			const base = inst._zod.parse;
			const wrapped = (payload, ctx) => {
				if (isRecursiveInst === void 0) {
					isRecursiveInst = isRecursive(inst, /* @__PURE__ */ new Set());
					if (!isRecursiveInst) {
						inst._zod.parse = base;
						if (inst._zod.run === wrapped) inst._zod.run = base;
						return base(payload, ctx);
					}
				}
				const input = payload.value;
				if (input === null || typeof input !== "object") return base(payload, ctx);
				let state = ctx[STATE];
				if (!state) {
					state = {
						buckets: /* @__PURE__ */ new Map(),
						backEdges: void 0
					};
					ctx[STATE] = state;
				}
				let bucket;
				if (lastCtx === ctx) bucket = lastBucket;
				else {
					bucket = bucketFor(state, inst);
					lastCtx = ctx;
					lastBucket = bucket;
				}
				const hit = bucket.get(input);
				if (hit) {
					payload.value = hit.value;
					if (hit.issues) {
						if (hit.issues.length) payload.issues.push(...cloneIssues(hit.issues));
					} else {
						payload.memo = true;
						state.backEdges ?? (state.backEdges = /* @__PURE__ */ new Set());
						state.backEdges.add(hit.value);
					}
					return payload;
				}
				handoff = bucket;
				const depth = open.length;
				const result = base(payload, ctx);
				handoff = void 0;
				const entry = open.length > depth ? open.pop() : void 0;
				if (result instanceof Promise) return result.then((r) => {
					if (entry) entry.issues = r.issues.length ? cloneIssues(r.issues) : NO_ISSUES;
					return r;
				});
				if (entry) entry.issues = result.issues.length ? cloneIssues(result.issues) : NO_ISSUES;
				return result;
			};
			inst._zod.parse = wrapped;
			if (inst._zod.run === base) inst._zod.run = wrapped;
		});
	}
};
/** The memoizer that gives containers cycle support. `zod` installs it by default; `zod/mini` opts in with `config({ memoizer: memoizer() })`. */
function memoizer() {
	return memo;
}
/** Whether this value is a node a back-edge resolved to before it finished. */
function isBackEdge(ctx, value) {
	const backEdges = ctx[STATE]?.backEdges;
	return backEdges !== void 0 && value !== null && typeof value === "object" && backEdges.has(value);
}
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/locales/en.js
var error = () => {
	const Sizable = {
		string: {
			unit: "characters",
			verb: "to have"
		},
		file: {
			unit: "bytes",
			verb: "to have"
		},
		array: {
			unit: "items",
			verb: "to have"
		},
		set: {
			unit: "items",
			verb: "to have"
		},
		map: {
			unit: "entries",
			verb: "to have"
		}
	};
	function getSizing(origin) {
		return Sizable[origin] ?? null;
	}
	const FormatDictionary = {
		regex: "input",
		email: "email address",
		url: "URL",
		emoji: "emoji",
		uuid: "UUID",
		uuidv4: "UUIDv4",
		uuidv6: "UUIDv6",
		nanoid: "nanoid",
		guid: "GUID",
		cuid: "cuid",
		cuid2: "cuid2",
		ulid: "ULID",
		xid: "XID",
		ksuid: "KSUID",
		datetime: "ISO datetime",
		date: "ISO date",
		time: "ISO time",
		duration: "ISO duration",
		ipv4: "IPv4 address",
		ipv6: "IPv6 address",
		mac: "MAC address",
		cidrv4: "IPv4 range",
		cidrv6: "IPv6 range",
		base64: "base64-encoded string",
		base64url: "base64url-encoded string",
		json_string: "JSON string",
		e164: "E.164 number",
		credit_card: "credit card number",
		jwt: "JWT",
		template_literal: "input"
	};
	const TypeDictionary = { nan: "NaN" };
	function getTypeName(type, input) {
		if (type === "number" && typeof input === "number" && !Number.isFinite(input)) return String(input);
		return TypeDictionary[type] ?? type;
	}
	return (issue) => {
		switch (issue.code) {
			case "invalid_type": return `Invalid input: expected ${getTypeName(issue.expected)}, received ${getTypeName(parsedType(issue.input), issue.input)}`;
			case "invalid_value":
				if (issue.values.length === 1) return `Invalid input: expected ${stringifyPrimitive(issue.values[0])}`;
				return `Invalid option: expected one of ${joinValues(issue.values, "|")}`;
			case "too_big": {
				const adj = issue.exact ? "exactly " : issue.inclusive ? "<=" : "<";
				const sizing = getSizing(issue.origin);
				if (sizing) return `Too big: expected ${issue.origin ?? "value"} to have ${adj}${issue.maximum.toString()} ${sizing.unit ?? "elements"}`;
				return `Too big: expected ${issue.origin ?? "value"} to be ${adj}${issue.maximum.toString()}`;
			}
			case "too_small": {
				const adj = issue.exact ? "exactly " : issue.inclusive ? ">=" : ">";
				const sizing = getSizing(issue.origin);
				if (sizing) return `Too small: expected ${issue.origin} to have ${adj}${issue.minimum.toString()} ${sizing.unit}`;
				return `Too small: expected ${issue.origin} to be ${adj}${issue.minimum.toString()}`;
			}
			case "invalid_format": {
				const _issue = issue;
				if (_issue.format === "starts_with") return `Invalid string: must start with "${_issue.prefix}"`;
				if (_issue.format === "ends_with") return `Invalid string: must end with "${_issue.suffix}"`;
				if (_issue.format === "includes") return `Invalid string: must include "${_issue.includes}"`;
				if (_issue.format === "regex") return `Invalid string: must match pattern ${_issue.pattern}`;
				return `Invalid ${FormatDictionary[_issue.format] ?? issue.format}`;
			}
			case "not_multiple_of": return `Invalid number: must be a multiple of ${issue.divisor}`;
			case "unrecognized_keys": return `Unrecognized key${issue.keys.length > 1 ? "s" : ""}: ${joinValues(issue.keys, ", ")}`;
			case "invalid_key": return `Invalid key in ${issue.origin}`;
			case "invalid_union":
				if (issue.options && Array.isArray(issue.options) && issue.options.length > 0) return `Invalid discriminator value. Expected ${issue.options.map((o) => `'${o}'`).join(" | ")}`;
				if (issue.inclusive === false) return "Invalid input: more than one option matched";
				return "Invalid input";
			case "invalid_element": return `Invalid value in ${issue.origin}`;
			default: return `Invalid input`;
		}
	};
};
function en_default() {
	return { localeError: error() };
}
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/api.js
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
	return new Class({
		type: "string",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link _cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
// @__NO_SIDE_EFFECTS__
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
	return new Class({
		type: "number",
		checks: [],
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn, params) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				if (!("input" in _issue)) _issue.input = payload.value;
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	}, params);
	return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/to-json-schema.js
function assignProps(target, ...sources) {
	for (const source of sources) for (const key of Reflect.ownKeys(source)) if (Object.prototype.propertyIsEnumerable.call(source, key)) assignProp(target, key, source[key]);
	return target;
}
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		sharedDefsExtractedFor: void 0,
		sharedEmitDoneFor: void 0,
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		intersections: [],
		deferred: [],
		external: params?.external ?? void 0
	};
}
/**
* Applies the `unrepresentable` setting at a site that has no JSON Schema equivalent. Throws
* `message` unless the setting (or the handler's return value) says otherwise. Returns `true` if a
* custom JSON Schema was written into `json`, in which case the caller must not write its own.
*/
function handleUnrepresentable(schema, ctx, json, params, message) {
	const result = typeof ctx.unrepresentable === "function" ? ctx.unrepresentable({
		zodSchema: schema,
		path: params.path,
		message
	}) : ctx.unrepresentable;
	if (result === "any") return false;
	if (result === void 0 || result === "throw") throw new Error(message);
	Object.assign(json, result);
	return true;
}
function process$1(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	ctx.sharedDefsExtractedFor = void 0;
	ctx.sharedEmitDoneFor = void 0;
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			process$1(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) assignProps(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && "_prefault" in result.schema) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function encodeJSONPointerSegment(segment) {
	return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	if (ctx.external && ctx.sharedDefsExtractedFor === ctx.external) return;
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${encodeJSONPointerSegment(id)}`
			};
		}
		const uriPrefix = `#`;
		const defUriPrefix = `${uriPrefix}/${defsSegment}/`;
		if (entry[1] === root && !entry[1].schema.id) return { ref: uriPrefix };
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + encodeJSONPointerSegment(defId)
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") {
				extractToDef(entry);
				continue;
			}
		}
	}
	if (ctx.external) ctx.sharedDefsExtractedFor = ctx.external;
}
/** Rewrites `anyOf: [{type: "a"}, {type: "b"}]` to `type: ["a", "b"]`, which every JSON Schema draft treats as equivalent and most consumers render far better for the nullable case. Only branches that are a bare type assertion qualify — anything carrying a constraint, `$ref`, `const` or metadata is left alone. Runs after `flattenRef`, so a branch an override decorated or `$defs` extraction turned into a `$ref` is no longer bare and correctly stays in `anyOf`. `oneOf` is excluded: `integer` and `number` overlap, so "exactly one" and "at least one" are not the same there. OpenAPI 3.0 is excluded: its `type` must be a single string. */
function compactTypeUnion(schema) {
	const options = schema.anyOf;
	if (!Array.isArray(options) || options.length === 0 || schema.type !== void 0) return;
	const types = [];
	for (const option of options) {
		if (!option || typeof option !== "object") return;
		compactTypeUnion(option);
		const keys = Object.keys(option);
		if (keys.length !== 1 || keys[0] !== "type") return;
		const type = option.type;
		for (const member of Array.isArray(type) ? type : [type]) {
			if (typeof member !== "string") return;
			if (!types.includes(member)) types.push(member);
		}
	}
	delete schema.anyOf;
	schema.type = types.length === 1 ? types[0] : types;
}
/** Keywords `foldIntersection` knows how to combine. Anything else — `$ref`, `patternProperties`,
* an annotation like `description` — makes a member unfoldable, so a constraint this does not
* understand leaves the `allOf` alone instead of being silently dropped or misattributed. */
var FOLDABLE_KEYS = /* @__PURE__ */ new Set([
	"type",
	"properties",
	"required",
	"additionalProperties"
]);
var UNION_KEYS = ["oneOf", "anyOf"];
/** A member's constraint on a key it does not declare itself. A `catchall` states one; `false`, an absent `additionalProperties`, and the empty schema a loose object emits state nothing. */
function undeclaredConstraint(member) {
	const extra = member.additionalProperties;
	if (extra === void 0 || extra === false || typeof extra !== "object" || extra === null) return null;
	return Object.keys(extra).length ? extra : null;
}
/** Combines object members into the single object they describe together, or returns `null` if any of them carries a keyword outside {@link FOLDABLE_KEYS}. */
function foldObjects(members) {
	const objects = [];
	for (const member of members) {
		if (typeof member !== "object" || member.type !== "object") return null;
		for (const key in member) if (!FOLDABLE_KEYS.has(key)) return null;
		objects.push(member);
	}
	const properties = {};
	const required = /* @__PURE__ */ new Set();
	for (const object of objects) {
		for (const key in object.properties) {
			if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
			const parts = [];
			for (const other of objects) {
				const part = other.properties?.[key] ?? undeclaredConstraint(other);
				if (part === null || part === void 0) continue;
				if (!parts.some((seen) => JSON.stringify(seen) === JSON.stringify(part))) parts.push(part);
			}
			assignProp(properties, key, parts.length === 1 ? parts[0] : foldObjects(parts) ?? { allOf: parts });
		}
		for (const key of object.required ?? []) required.add(key);
	}
	const folded = {
		type: "object",
		properties
	};
	if (required.size) folded.required = [...required];
	if (objects.every((object) => object.additionalProperties === false)) folded.additionalProperties = false;
	else {
		const constraints = [];
		for (const object of objects) {
			const constraint = undeclaredConstraint(object);
			if (constraint && !constraints.some((seen) => JSON.stringify(seen) === JSON.stringify(constraint))) constraints.push(constraint);
		}
		if (constraints.length === 1) folded.additionalProperties = constraints[0];
		else if (constraints.length > 1) folded.additionalProperties = { allOf: constraints };
	}
	return folded;
}
/** `additionalProperties` in an `allOf` member sees only that member's own `properties`, so two
* closed object members reject each other's keys and the schema validates nothing. Zod's parser
* pools the key sets instead — `handleIntersectionResults` reports a key as unrecognized only when
* *every* side rejects it — so the emitted schema has to pool them too, and folding the members
* into one object is the encoding that says so on every target.
*
* This runs from `finalize`, after `extractDefs`, which is what keeps it clear of the `$ref`
* machinery: a member extracted into `$defs` is already a `$ref` by now and declines to fold, so it
* keeps its reference and its own closedness rather than being inlined as a stale copy. */
function foldIntersection(json) {
	const allOf = json.allOf;
	if (!Array.isArray(allOf) || allOf.length < 2) return;
	for (const key of FOLDABLE_KEYS) if (key in json) return;
	const unions = allOf.filter((m) => UNION_KEYS.some((k) => Array.isArray(m[k])));
	let folded = null;
	if (!unions.length) folded = foldObjects(allOf);
	else {
		const union = unions[0];
		const keyword = UNION_KEYS.find((k) => Array.isArray(union[k]));
		if (Object.keys(union).length !== 1) return;
		const rest = allOf.filter((m) => m !== union);
		const branches = union[keyword].map((branch) => foldObjects([...rest, branch]));
		if (branches.some((b) => !b)) return;
		folded = { [keyword]: branches };
	}
	if (!folded) return;
	delete json.allOf;
	assignProps(json, folded);
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else assignProps(schema, refSchema);
			assignProps(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) {
		for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
		if (ctx.target !== "openapi-3.0") for (const entry of ctx.seen.entries()) compactTypeUnion(entry[1].def ?? entry[1].schema);
		for (const rewrite of ctx.deferred) rewrite();
		if (ctx.intersections.length) {
			const carriers = /* @__PURE__ */ new Map();
			for (const seen of ctx.seen.values()) for (const json of [seen.schema, seen.def]) {
				const allOf = json?.allOf;
				if (!Array.isArray(allOf)) continue;
				const existing = carriers.get(allOf);
				if (existing) existing.push(json);
				else carriers.set(allOf, [json]);
			}
			for (const allOf of ctx.intersections) for (const json of carriers.get(allOf) ?? []) foldIntersection(json);
		}
	}
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	assignProps(result, root.defId ? root.schema : root.def ?? root.schema);
	const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
	if (rootMetaId !== void 0 && result.id === rootMetaId) delete result.id;
	const defs = ctx.external?.defs ?? {};
	if (!ctx.external || ctx.sharedEmitDoneFor !== ctx.external) for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) {
			if (seen.def.id === seen.defId) delete seen.def.id;
			assignProp(defs, seen.defId, seen.def);
		}
	}
	if (ctx.external) ctx.sharedEmitDoneFor = ctx.external;
	if (ctx.external) {} else if (Object.keys(defs).length > 0) {
		if (ctx.target === "draft-2020-12") result.$defs = defs;
		else result.definitions = defs;
	}
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault" || def.type === "catch") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") {
		if (_schema._zod.traits.has("$ZodCodec")) return true;
		return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	}
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/core/json-schema-processors.js
var formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
var stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding, laxFormat } = schema._zod.bag;
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time" || laxFormat) delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const patternList = [...patterns];
		if (patternList.length === 1) json.pattern = patternList[0].source;
		else if (patternList.length > 1) json.allOf = [...patternList.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
var numberProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
	if (typeof format === "string" && format.includes("int")) json.type = "integer";
	else json.type = "number";
	const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
	const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
	const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
	if (exMin) {
		if (legacy) {
			json.minimum = exclusiveMinimum;
			json.exclusiveMinimum = true;
		} else json.exclusiveMinimum = exclusiveMinimum;
	} else if (typeof minimum === "number") json.minimum = minimum;
	if (exMax) {
		if (legacy) {
			json.maximum = exclusiveMaximum;
			json.exclusiveMaximum = true;
		} else json.exclusiveMaximum = exclusiveMaximum;
	} else if (typeof maximum === "number") json.maximum = maximum;
	if (typeof multipleOf === "number") {
		if (Number.isFinite(multipleOf) && multipleOf !== 0) json.multipleOf = Math.abs(multipleOf);
		else handleUnrepresentable(schema, ctx, json, params, `A multipleOf divisor of ${multipleOf} cannot be represented in JSON Schema`);
	}
};
var neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
var enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.length === 0) {
		json.not = {};
		return;
	}
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
var customProcessor = (schema, ctx, json, params) => {
	handleUnrepresentable(schema, ctx, json, params, "Custom types cannot be represented in JSON Schema");
};
var transformProcessor = (schema, ctx, json, params) => {
	handleUnrepresentable(schema, ctx, json, params, "Transforms cannot be represented in JSON Schema");
};
var arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = schema._zod.bag;
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = process$1(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
function inputOptin(schema) {
	const def = schema._zod.def;
	if (def.type === "pipe" && def.in._zod.traits.has("$ZodTransform")) return inputOptin(def.out);
	if (def.type === "catch") return inputOptin(def.innerType);
	return schema._zod.optin;
}
var objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const shape = def.shape;
	if (Object.getOwnPropertySymbols(shape).length && handleUnrepresentable(schema, ctx, json, params, "Symbol keys cannot be represented in JSON Schema")) return;
	json.type = "object";
	json.properties = {};
	for (const key in shape) assignProp(json.properties, key, process$1(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	}));
	const allKeys = new Set(Object.keys(shape));
	const requiredKeys = new Set([...allKeys].filter((key) => {
		const field = def.shape[key];
		if (ctx.io === "input") return inputOptin(field) === void 0;
		else return field._zod.optout === void 0;
	}));
	if (requiredKeys.size > 0) json.required = Array.from(requiredKeys);
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = process$1(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
var unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => process$1(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
var intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = process$1(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = process$1(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	const allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
	json.allOf = allOf;
	ctx.intersections.push(allOf);
};
var nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
/** Round-trips a default value through JSON so the emitted schema is guaranteed to be valid JSON.
* A BigInt has no reliable encoding, so it goes through `unrepresentable` like any other
* unrepresentable value. Returns a sentinel when the caller must not write a default of its own. */
var UNREPRESENTABLE_DEFAULT = Symbol();
function serializeDefaultValue(value, schema, ctx, json, params) {
	let unrepresentable = false;
	const serialized = JSON.stringify(value, (_, val) => {
		if (typeof val !== "bigint") return val;
		unrepresentable = true;
		return null;
	});
	if (!unrepresentable) return JSON.parse(serialized);
	handleUnrepresentable(schema, ctx, json, params, "BigInt defaults cannot be represented in JSON Schema");
	return UNREPRESENTABLE_DEFAULT;
}
var defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
	if (value !== UNREPRESENTABLE_DEFAULT) json.default = value;
};
var prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io !== "input") return;
	const value = serializeDefaultValue(def.defaultValue, schema, ctx, json, params);
	if (value !== UNREPRESENTABLE_DEFAULT) json._prefault = value;
};
var catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		handleUnrepresentable(schema, ctx, json, params, "Dynamic catch values are not supported in JSON Schema");
		return;
	}
	json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const inIsTransform = def.in._zod.traits.has("$ZodTransform");
	const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
	process$1(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
var optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/classic/errors.js
var _installedErrorProtos = /* @__PURE__ */ new WeakSet([Object.prototype, Error.prototype]);
function _lazyMethod(proto, key, make) {
	Object.defineProperty(proto, key, {
		configurable: true,
		enumerable: false,
		get() {
			const value = make(this);
			Object.defineProperty(this, key, {
				value,
				configurable: true,
				writable: true
			});
			return value;
		},
		set(value) {
			Object.defineProperty(this, key, {
				value,
				configurable: true,
				writable: true
			});
		}
	});
}
var initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	const proto = Object.getPrototypeOf(inst);
	if (_installedErrorProtos.has(proto)) return;
	_installedErrorProtos.add(proto);
	_lazyMethod(proto, "format", (self) => (mapper) => formatError(self, mapper));
	_lazyMethod(proto, "flatten", (self) => (mapper) => flattenError(self, mapper));
	_lazyMethod(proto, "addIssue", (self) => (issue) => {
		self.issues.push(issue);
		self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
	});
	_lazyMethod(proto, "addIssues", (self) => (issues) => {
		self.issues.push(...issues);
		self.message = JSON.stringify(self.issues, jsonStringifyReplacer, 2);
	});
	Object.defineProperty(proto, "isEmpty", {
		configurable: true,
		enumerable: false,
		get() {
			return this.issues.length === 0;
		}
	});
};
var ZodRealError = /*@__PURE__*/ $constructor("ZodError", initializer, void 0, { Parent: Error });
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/classic/parse.js
var parse = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
//#endregion
//#region ../delivery-workspace-plugins/node_modules/.pnpm/zod@4.5.4/node_modules/zod/v4/classic/schemas.js
function _ensureDefaultLocale() {
	if (!globalConfig.localeError) config(en_default());
}
function _ensureDefaultMemoizer() {
	if (!globalConfig.memoizer) config({ memoizer: memoizer() });
}
var ZodType = /*@__PURE__*/ $constructor("ZodType", (inst, def) => {
	_ensureDefaultLocale();
	$ZodType.init(inst, def);
	inst.def = def;
	inst.type = def.type;
	return inst;
}, {
	check(...chks) {
		const def = this.def;
		return this.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...chks.map((ch) => typeof ch === "function" ? { _zod: {
			check: ch,
			def: { check: "custom" },
			onattach: []
		} } : ch)] }), { parent: true });
	},
	with(...chks) {
		return this.check(...chks);
	},
	clone(def, params) {
		return clone(this, def, params);
	},
	brand() {
		return this;
	},
	register(reg, meta) {
		reg.add(this, meta);
		return this;
	},
	refine(check, params) {
		return this.check(refine(check, params));
	},
	superRefine(refinement, params) {
		return this.check(superRefine(refinement, params));
	},
	overwrite(fn) {
		return this.check(/* @__PURE__ */ _overwrite(fn));
	},
	optional() {
		return optional(this);
	},
	exactOptional() {
		return exactOptional(this);
	},
	nullable() {
		return nullable(this);
	},
	nullish() {
		return optional(nullable(this));
	},
	nonoptional(params) {
		return nonoptional(this, params);
	},
	array() {
		return array(this);
	},
	or(arg) {
		return union([this, arg]);
	},
	and(arg) {
		return intersection(this, arg);
	},
	transform(tx) {
		return pipe(this, transform(tx));
	},
	default(d) {
		return _default(this, d);
	},
	prefault(d) {
		return prefault(this, d);
	},
	catch(params) {
		return _catch(this, params);
	},
	pipe(target) {
		return pipe(this, target);
	},
	readonly() {
		return readonly(this);
	},
	describe(description) {
		const cl = this.clone();
		globalRegistry.add(cl, { description });
		return cl;
	},
	meta(...args) {
		if (args.length === 0) return globalRegistry.get(this);
		const cl = this.clone();
		globalRegistry.add(cl, args[0]);
		return cl;
	},
	isOptional() {
		return this.safeParse(void 0).success;
	},
	isNullable() {
		return this.safeParse(null).success;
	},
	apply(fn, ...args) {
		return args.length === 0 ? fn(this) : fn(this, ...args);
	},
	get "~standard"() {
		return hide(this, "~standard", {
			...standardProps(this),
			jsonSchema: {
				input: createStandardJSONSchemaMethod(this, "input"),
				output: createStandardJSONSchemaMethod(this, "output")
			}
		});
	},
	set "~standard"(value) {
		own(this, "~standard", value);
	},
	parse: function _parse(data, params) {
		return parse(this, data, params, { callee: _parse });
	},
	parseAsync: async function _parseAsync(data, params) {
		return await parseAsync(this, data, params, { callee: _parseAsync });
	},
	safeParse(data, params) {
		return safeParse(this, data, params);
	},
	async safeParseAsync(data, params) {
		return safeParseAsync(this, data, params);
	},
	get spa() {
		return this?.safeParseAsync;
	},
	set spa(value) {
		own(this, "spa", value);
	},
	encode: function _encode(data, params) {
		return encode(this, data, params, { callee: _encode });
	},
	decode: function _decode(data, params) {
		return decode(this, data, params, { callee: _decode });
	},
	encodeAsync: async function _encodeAsync(data, params) {
		return await encodeAsync(this, data, params, { callee: _encodeAsync });
	},
	decodeAsync: async function _decodeAsync(data, params) {
		return await decodeAsync(this, data, params, { callee: _decodeAsync });
	},
	safeEncode(data, params) {
		return safeEncode(this, data, params);
	},
	safeDecode(data, params) {
		return safeDecode(this, data, params);
	},
	async safeEncodeAsync(data, params) {
		return safeEncodeAsync(this, data, params);
	},
	async safeDecodeAsync(data, params) {
		return safeDecodeAsync(this, data, params);
	},
	toJSONSchema(params) {
		return createToJSONSchemaMethod(this, {})(params);
	},
	get description() {
		return globalRegistry.get(this)?.description;
	},
	get _def() {
		return this._zod.def;
	}
});
/** @internal */
var _ZodString = /*@__PURE__*/ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
	const bag = inst._zod.bag;
	inst.format = bag.format ?? null;
	inst.minLength = bag.minimum ?? null;
	inst.maxLength = bag.maximum ?? null;
}, {
	regex(...args) {
		return this.check(/* @__PURE__ */ _regex(...args));
	},
	includes(...args) {
		return this.check(/* @__PURE__ */ _includes(...args));
	},
	startsWith(...args) {
		return this.check(/* @__PURE__ */ _startsWith(...args));
	},
	endsWith(...args) {
		return this.check(/* @__PURE__ */ _endsWith(...args));
	},
	min(...args) {
		return this.check(/* @__PURE__ */ _minLength(...args));
	},
	max(...args) {
		return this.check(/* @__PURE__ */ _maxLength(...args));
	},
	length(...args) {
		return this.check(/* @__PURE__ */ _length(...args));
	},
	nonempty(...args) {
		return this.check(/* @__PURE__ */ _minLength(1, ...args));
	},
	lowercase(params) {
		return this.check(/* @__PURE__ */ _lowercase(params));
	},
	uppercase(params) {
		return this.check(/* @__PURE__ */ _uppercase(params));
	},
	trim() {
		return this.check(/* @__PURE__ */ _trim());
	},
	normalize(...args) {
		return this.check(/* @__PURE__ */ _normalize(...args));
	},
	toLowerCase() {
		return this.check(/* @__PURE__ */ _toLowerCase());
	},
	toUpperCase() {
		return this.check(/* @__PURE__ */ _toUpperCase());
	},
	slugify() {
		return this.check(/* @__PURE__ */ _slugify());
	}
});
var ZodString = /*@__PURE__*/ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
}, {
	email(params) {
		return this.check(/* @__PURE__ */ _email(ZodEmail, params));
	},
	url(params) {
		return this.check(/* @__PURE__ */ _url(ZodURL, params));
	},
	jwt(params) {
		return this.check(/* @__PURE__ */ _jwt(ZodJWT, params));
	},
	emoji(params) {
		return this.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
	},
	guid(params) {
		return this.check(/* @__PURE__ */ _guid(ZodGUID, params));
	},
	uuid(params) {
		return this.check(/* @__PURE__ */ _uuid(ZodUUID, params));
	},
	uuidv4(params) {
		return this.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
	},
	uuidv6(params) {
		return this.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
	},
	uuidv7(params) {
		return this.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
	},
	nanoid(params) {
		return this.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
	},
	cuid(params) {
		return this.check(/* @__PURE__ */ _cuid(ZodCUID, params));
	},
	cuid2(params) {
		return this.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
	},
	ulid(params) {
		return this.check(/* @__PURE__ */ _ulid(ZodULID, params));
	},
	base64(params) {
		return this.check(/* @__PURE__ */ _base64(ZodBase64, params));
	},
	base64url(params) {
		return this.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
	},
	xid(params) {
		return this.check(/* @__PURE__ */ _xid(ZodXID, params));
	},
	ksuid(params) {
		return this.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
	},
	ipv4(params) {
		return this.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
	},
	ipv6(params) {
		return this.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
	},
	cidrv4(params) {
		return this.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
	},
	cidrv6(params) {
		return this.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
	},
	e164(params) {
		return this.check(/* @__PURE__ */ _e164(ZodE164, params));
	},
	datetime(params) {
		return this.check(/* @__PURE__ */ _isoDateTime(ZodISODateTime, params));
	},
	date(params) {
		return this.check(/* @__PURE__ */ _isoDate(ZodISODate, params));
	},
	time(params) {
		return this.check(/* @__PURE__ */ _isoTime(ZodISOTime, params));
	},
	duration(params) {
		return this.check(/* @__PURE__ */ _isoDuration(ZodISODuration, params));
	}
});
function string(params) {
	return /* @__PURE__ */ _string(ZodString, params);
}
var ZodStringFormat = /*@__PURE__*/ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
var ZodISODateTime = /*@__PURE__*/ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodISODate = /*@__PURE__*/ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodISOTime = /*@__PURE__*/ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodISODuration = /*@__PURE__*/ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodEmail = /*@__PURE__*/ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodGUID = /*@__PURE__*/ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodUUID = /*@__PURE__*/ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodURL = /*@__PURE__*/ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodEmoji = /*@__PURE__*/ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodNanoID = /*@__PURE__*/ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var ZodCUID = /*@__PURE__*/ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /*@__PURE__*/ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodULID = /*@__PURE__*/ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodXID = /*@__PURE__*/ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodKSUID = /*@__PURE__*/ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /*@__PURE__*/ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /*@__PURE__*/ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /*@__PURE__*/ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /*@__PURE__*/ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodBase64 = /*@__PURE__*/ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /*@__PURE__*/ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodE164 = /*@__PURE__*/ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodJWT = /*@__PURE__*/ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodNumber = /*@__PURE__*/ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	const bag = inst._zod.bag;
	inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
	inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
	inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? .5);
	inst.isFinite = true;
	inst.format = bag.format ?? null;
}, {
	gt(value, params) {
		return this.check(/* @__PURE__ */ _gt(value, params));
	},
	gte(value, params) {
		return this.check(/* @__PURE__ */ _gte(value, params));
	},
	min(value, params) {
		return this.check(/* @__PURE__ */ _gte(value, params));
	},
	lt(value, params) {
		return this.check(/* @__PURE__ */ _lt(value, params));
	},
	lte(value, params) {
		return this.check(/* @__PURE__ */ _lte(value, params));
	},
	max(value, params) {
		return this.check(/* @__PURE__ */ _lte(value, params));
	},
	int(params) {
		return this.check(int(params));
	},
	safe(params) {
		return this.check(int(params));
	},
	positive(params) {
		return this.check(/* @__PURE__ */ _gt(0, params));
	},
	nonnegative(params) {
		return this.check(/* @__PURE__ */ _gte(0, params));
	},
	negative(params) {
		return this.check(/* @__PURE__ */ _lt(0, params));
	},
	nonpositive(params) {
		return this.check(/* @__PURE__ */ _lte(0, params));
	},
	multipleOf(value, params) {
		return this.check(/* @__PURE__ */ _multipleOf(value, params));
	},
	step(value, params) {
		return this.check(/* @__PURE__ */ _multipleOf(value, params));
	},
	finite() {
		return this;
	}
});
function number(params) {
	return /* @__PURE__ */ _number(ZodNumber, params);
}
var ZodNumberFormat = /*@__PURE__*/ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int(params) {
	return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
var ZodUnknown = /*@__PURE__*/ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => void 0;
});
function unknown() {
	return /* @__PURE__ */ _unknown(ZodUnknown);
}
var ZodNever = /*@__PURE__*/ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return /* @__PURE__ */ _never(ZodNever, params);
}
var ZodArray = /*@__PURE__*/ $constructor("ZodArray", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
}, {
	min(n, params) {
		return this.check(/* @__PURE__ */ _minLength(n, params));
	},
	nonempty(params) {
		return this.check(/* @__PURE__ */ _minLength(1, params));
	},
	max(n, params) {
		return this.check(/* @__PURE__ */ _maxLength(n, params));
	},
	length(n, params) {
		return this.check(/* @__PURE__ */ _length(n, params));
	},
	unwrap() {
		return this.element;
	}
});
function array(element, params) {
	return /* @__PURE__ */ _array(ZodArray, element, params);
}
var ZodObject = /*@__PURE__*/ $constructor("ZodObject", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	installLazyProp(inst, "shape", (self) => self._zod.def.shape, false);
}, {
	keyof() {
		return _enum(Object.keys(this._zod.def.shape));
	},
	catchall(catchall) {
		return this.clone({
			...this._zod.def,
			catchall
		});
	},
	passthrough() {
		return this.clone({
			...this._zod.def,
			catchall: unknown()
		});
	},
	loose() {
		return this.clone({
			...this._zod.def,
			catchall: unknown()
		});
	},
	strict() {
		return this.clone({
			...this._zod.def,
			catchall: never()
		});
	},
	strip() {
		return this.clone({
			...this._zod.def,
			catchall: void 0
		});
	},
	extend(incoming) {
		return extend(this, incoming);
	},
	safeExtend(incoming) {
		return safeExtend(this, incoming);
	},
	merge(other) {
		return merge(this, other);
	},
	pick(mask) {
		return pick(this, mask);
	},
	omit(mask) {
		return omit(this, mask);
	},
	partial(...args) {
		return partial(ZodOptional, this, args[0]);
	},
	exactPartial(...args) {
		return partial(ZodExactOptional, this, args[0], "exactPartial");
	},
	required(...args) {
		return required(ZodNonOptional, this, args[0]);
	}
});
function object(shape, params) {
	return new ZodObject({
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	});
}
var ZodUnion = /*@__PURE__*/ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
var ZodIntersection = /*@__PURE__*/ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
var ZodEnum = /*@__PURE__*/ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = Object.values(def.entries);
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	return new ZodEnum({
		type: "enum",
		entries: Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values,
		...normalizeParams(params)
	});
}
var ZodTransform = /*@__PURE__*/ $constructor("ZodTransform", (inst, def) => {
	_ensureDefaultMemoizer();
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				if (!("input" in _issue)) _issue.input = payload.value;
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			return payload;
		});
		payload.value = output;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
var ZodOptional = /*@__PURE__*/ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
var ZodExactOptional = /*@__PURE__*/ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
var ZodNullable = /*@__PURE__*/ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
var ZodDefault = /*@__PURE__*/ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
var ZodPrefault = /*@__PURE__*/ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
var ZodNonOptional = /*@__PURE__*/ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
var ZodCatch = /*@__PURE__*/ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : constantCatch(catchValue)
	});
}
var ZodPipe = /*@__PURE__*/ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
var ZodReadonly = /*@__PURE__*/ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
var ZodCustom = /*@__PURE__*/ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
	return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
	return /* @__PURE__ */ _superRefine(fn, params);
}
//#endregion
//#region plugins/go-learning/types.ts
var goCommandActions = [
	"run",
	"test",
	"race",
	"vet",
	"fmt",
	"version"
];
var goProgressUpdateSchema = object({
	currentDay: number().int().min(1).max(7).optional(),
	toggleChecklistId: string().trim().min(1).max(80).optional(),
	toggleExerciseId: string().trim().min(1).max(80).optional(),
	note: object({
		day: number().int().min(1).max(7),
		content: string().max(5e4)
	}).optional()
}).strict();
var goSandboxInitSchema = object({ snapshot: _enum([
	"day1",
	"day2",
	"day3",
	"day4",
	"day5",
	"day6",
	"day7",
	"day7-graduation"
]) }).strict();
var goSandboxSaveFileSchema = object({
	filePath: string().trim().min(1).max(260).regex(/^[a-zA-Z0-9_./-]+$/),
	content: string().max(2e5)
}).strict();
var goSandboxRunSchema = object({
	action: _enum(goCommandActions),
	args: array(string().max(120)).max(6).optional()
}).strict();
var goHttpDebugSchema = object({
	method: _enum([
		"GET",
		"POST",
		"PATCH",
		"DELETE"
	]),
	path: string().trim().min(1).max(200).startsWith("/tasks"),
	body: string().max(1e4).optional()
}).strict();
//#endregion
//#region plugins/go-learning/application.ts
async function createPlugin(host) {
	const service = await createGoLearningService(host.dataDirectory, { rootDir: host.workspaceDirectory });
	async function sandboxResult(result) {
		const sandbox = await service.readSandboxFiles();
		return {
			...result === void 0 ? {} : { result },
			sandboxFiles: sandbox.files,
			tasksJsonContent: sandbox.tasksJsonContent
		};
	}
	return {
		async close() {
			stopGoLearningProcesses();
			await service.close();
		},
		async request(method, raw) {
			if (method === "overview" || method === "day") {
				const value = raw?.day;
				const day = value === void 0 ? void 0 : Number(value);
				if (day !== void 0 && (!Number.isInteger(day) || day < 1 || day > 7)) throw new Error("请选择第 1～7 天");
				return method === "overview" ? service.overview(day) : service.getDay(day || 1);
			}
			if (method === "progress") return { progress: await service.updateProgress(goProgressUpdateSchema.parse(raw)) };
			if (method === "sandbox/init") {
				const input = goSandboxInitSchema.parse(raw);
				await service.applySnapshot(input.snapshot);
				return {
					...await sandboxResult(),
					activeSnapshot: input.snapshot,
					progress: (await service.overview()).progress
				};
			}
			if (method === "sandbox/save-file") {
				const input = goSandboxSaveFileSchema.parse(raw);
				await service.saveSandboxFile(input.filePath, input.content);
				return sandboxResult();
			}
			if (method === "sandbox/run") {
				const input = goSandboxRunSchema.parse(raw);
				return sandboxResult(await service.runCommand(input.action, input.args || []));
			}
			if (method === "sandbox/http-debug") return sandboxResult(await service.debugHttpEndpoint(goHttpDebugSchema.parse(raw)));
			throw new Error("Go 实训操作不存在");
		}
	};
}
//#endregion
export { createPlugin };
