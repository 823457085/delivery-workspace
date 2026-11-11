import { CircleCheck, Terminal, LayoutGrid, ListChecks, Calendar, NotebookPen, FolderGit2, Braces, BookOpen, MessagesSquare, ChartNoAxesCombined, Star, Bookmark, BriefcaseBusiness, Layers, Plug, Settings2, Sun } from '@lucide/vue';
import type { MenuIconName } from '../../shared/workspace-navigation';
export const menuIcons = {
  grid: LayoutGrid, checklist: ListChecks, calendar: Calendar, notebook: NotebookPen,
  folder: FolderGit2, code: Braces, book: BookOpen, message: MessagesSquare,
  chart: ChartNoAxesCombined, star: Star, bookmark: Bookmark, briefcase: BriefcaseBusiness,
  layers: Layers, plug: Plug, settings: Settings2, sun: Sun,
};
export const menuIconLabels: Record<MenuIconName, string> = {
  grid: '应用', checklist: '待办', calendar: '日历', notebook: '笔记', folder: '项目', code: '代码',
  book: '知识', message: '消息', chart: '统计', star: '收藏', bookmark: '书签', briefcase: '工作',
  layers: '分层', plug: '插件', settings: '设置', sun: '今日',
};

// Keep the editor's default preview and the rendered navigation on the same registry.
export const workspaceMenuIcons: Record<string, typeof LayoutGrid> = {
  today: Sun, tasks: CircleCheck, projects: FolderGit2, execution: Terminal,
  integration: Braces, learning: BookOpen, automation: Settings2, plugins: LayoutGrid, ...menuIcons,
};
