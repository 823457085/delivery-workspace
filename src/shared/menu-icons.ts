import { CircleCheck, Terminal, LayoutGrid, ListChecks, Calendar, NotebookPen, FolderGit2, Braces, BookOpen, MessagesSquare, ChartNoAxesCombined, Star, Bookmark, BriefcaseBusiness, Layers, Plug, Settings2, Sun, House, Search, Bell, AlarmClock, Clock, Timer, Rocket, Bug, GitBranch, GitPullRequest, Database, Server, Cloud, Globe, Network, ShieldCheck, KeyRound, LockKeyhole, Users, UserRound, Mail, FileText, Files, Image, Video, Music, Download, Upload, Trash2, Archive, Package, Wrench, Cpu, Monitor, Smartphone, Palette, GraduationCap, Lightbulb, Zap, Heart, Target, Map, Link, Workflow, Bot, ClipboardList, Activity } from '@lucide/vue';
import type { MenuIconName } from '../../shared/workspace-navigation';
export const menuIcons = {
  grid: LayoutGrid, checklist: ListChecks, calendar: Calendar, notebook: NotebookPen,
  folder: FolderGit2, code: Braces, book: BookOpen, message: MessagesSquare,
  chart: ChartNoAxesCombined, star: Star, bookmark: Bookmark, briefcase: BriefcaseBusiness,
  layers: Layers, plug: Plug, settings: Settings2, sun: Sun,
  'home': House, 'search': Search, 'bell': Bell, 'alarm': AlarmClock, 'clock': Clock, 'timer': Timer, 'rocket': Rocket, 'terminal': Terminal, 'bug': Bug, 'git-branch': GitBranch, 'git-pull': GitPullRequest, 'database': Database, 'server': Server, 'cloud': Cloud, 'globe': Globe, 'network': Network, 'shield': ShieldCheck, 'key': KeyRound, 'lock': LockKeyhole, 'users': Users, 'user': UserRound, 'mail': Mail, 'file': FileText, 'files': Files, 'image': Image, 'video': Video, 'music': Music, 'download': Download, 'upload': Upload, 'trash': Trash2, 'archive': Archive, 'package': Package, 'wrench': Wrench, 'cpu': Cpu, 'monitor': Monitor, 'phone': Smartphone, 'palette': Palette, 'graduation': GraduationCap, 'lightbulb': Lightbulb, 'zap': Zap, 'heart': Heart, 'target': Target, 'map': Map, 'link': Link, 'workflow': Workflow, 'bot': Bot, 'clipboard': ClipboardList, 'activity': Activity,
};
export const menuIconLabels: Record<MenuIconName, string> = {
  grid: '应用', checklist: '待办', calendar: '日历', notebook: '笔记', folder: '项目', code: '代码',
  book: '知识', message: '消息', chart: '统计', star: '收藏', bookmark: '书签', briefcase: '工作',
  layers: '分层', plug: '插件', settings: '设置', sun: '今日',
  'home': '主页', 'search': '搜索', 'bell': '通知', 'alarm': '提醒', 'clock': '时间', 'timer': '计时', 'rocket': '发布', 'terminal': '终端', 'bug': '缺陷', 'git-branch': '分支', 'git-pull': '合并', 'database': '数据库', 'server': '服务器', 'cloud': '云服务', 'globe': '网站', 'network': '网络', 'shield': '安全', 'key': '密钥', 'lock': '权限', 'users': '团队', 'user': '个人', 'mail': '邮件', 'file': '文档', 'files': '文件', 'image': '图片', 'video': '视频', 'music': '音频', 'download': '下载', 'upload': '上传', 'trash': '清理', 'archive': '归档', 'package': '软件包', 'wrench': '工具', 'cpu': '计算', 'monitor': '桌面', 'phone': '手机', 'palette': '配色', 'graduation': '学习', 'lightbulb': '灵感', 'zap': '自动化', 'heart': '喜爱', 'target': '目标', 'map': '地图', 'link': '链接', 'workflow': '流程', 'bot': '助手', 'clipboard': '清单', 'activity': '监控',
};

// Keep the editor's default preview and the rendered navigation on the same registry.
export const workspaceMenuIcons: Record<string, typeof LayoutGrid> = {
  today: Sun, tasks: CircleCheck, projects: FolderGit2, execution: Terminal,
  integration: Braces, learning: BookOpen, automation: Settings2, plugins: LayoutGrid, ...menuIcons,
};
