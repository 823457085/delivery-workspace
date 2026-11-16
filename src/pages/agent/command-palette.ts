import { themeOptions, type ThemePreference } from '../../shared/theme/theme';
import { computeCommandFrecencyBoost, type CommandUsageEntry } from './command-palette-history';
import type { WorkspaceSection } from './workspace-navigation';

export type CommandCategory = 'action' | 'thread' | 'bookmark' | 'port' | 'workspace' | 'theme';

export interface CommandPaletteBookmarkInput {
  id: string;
  conversationId: string;
  conversationTitle: string;
  excerpt: string;
  content: string;
  turnIndex?: number;
}

export interface CommandPaletteThread {
  id: string;
  kind: 'session' | 'group';
  title: string;
  subtitle: string;
  badge?: string;
  keywords?: string;
  active?: boolean;
}

export interface CommandPaletteItem {
  id: string;
  category: CommandCategory;
  title: string;
  subtitle: string;
  keywords: string;
  badge?: string;
  shortcut?: string;
  colors?: readonly [string, string, string];
  active?: boolean;
  pinned?: boolean;
  frequentlyUsed?: boolean;
  viewId?: string;
  themeId?: ThemePreference;
  sessionId?: string;
  groupRoomId?: string;
  bookmarkContent?: string;
  portNumber?: number;
  actionId?:
    | 'new-chat'
    | 'new-group'
    | 'open-chat'
    | 'open-accounts'
    | 'toggle-rail'
    | 'toggle-zen'
    | 'open-showcase'
    | 'refresh-page'
    | 'upload-wallpaper'
    | 'generate-wallpaper'
    | 'cycle-wallpaper'
    | 'toggle-daylight';
}

const VIEW_ALIASES: Record<string, string> = {
  today: 'today workbench 今日 工作台 待办 日程',
  overview: 'overview dashboard 总览 概览 队列 指标',
  tasks: 'jira tasks issues 任务 列表 缺陷 需求',
  calendar: 'calendar schedule 日历 排期 工期',
  stats: 'stats analytics metrics 统计 报表 图表',
  projects: 'projects git worktree repo 本地项目 仓库 分支 工作树',
  ports: 'ports listen process 端口 检测 占用 进程',
  deployments: 'deployments docker pm2 deploy 部署 服务 发布 日志',
  'integration-execution': 'refactor health audit 代码体检 重构 台账 质量',
  systems: 'systems catalog nav 系统导航 站点 入口',
  requirements: 'overseas requirements 需求管理 海外需求',
  confluence: 'confluence wiki docs 文档 知识库',
  design: 'design requirement spec prd 需求开发 方案 设计',
  'jira-fix': 'jira fix bugfix 修复 缺陷修复 补丁',
  queue: 'queue auto delivery pipeline 执行中心 自动交付 队列 流水线',
  'go-studio': 'go golang learning studio 实训 教程 沙箱 练习',
  interfaces: 'interfaces openapi swagger api 接口 联调 文档 调试',
  'sign-hub': 'sign hub checkin 签到 自动签到',
  shanlian: 'shanlian vpn proxy 闪连 网络 隧道',
  settings: 'settings config credentials 连接 策略 设置 凭据 chrome',
  plugins: 'plugins extensions mcp 功能插件 扩展 接入',
  automation: 'automation cron report 自动化 日报 周报 巡检',
  messages: 'messages wecom webhook 手动群消息 企微 通知 机器人',
};

export function buildCommandPaletteItems(options: {
  sections: WorkspaceSection[];
  currentViewId?: string;
  isChatActive: boolean;
  chatMode: 'session' | 'group';
  railCollapsed: boolean;
  zenFocusEnabled?: boolean;
  currentThemeId: string;
  daylightEnabled?: boolean;
  threads?: CommandPaletteThread[];
  bookmarks?: readonly CommandPaletteBookmarkInput[];
  ports?: readonly CommandPaletteItem[];
}): CommandPaletteItem[] {
  const items: CommandPaletteItem[] = [
    {
      id: 'action:new-chat',
      category: 'action',
      title: '发起新 AI 对话',
      subtitle: '打开空白单人 Agent 会话并聚焦输入框',
      keywords: 'new chat session conversation 新对话 新建会话 单人 ai提问',
      badge: '动作',
      actionId: 'new-chat',
    },
    {
      id: 'action:new-group',
      category: 'action',
      title: '进入团队协作群聊',
      subtitle: '多角色 Agent 接力协作（研发负责人 · 架构 · 实现 · 测试 · 审查）',
      keywords: 'team group multi agent room 团队 群聊 协作 多角色 派发',
      badge: '协作',
      active: options.isChatActive && options.chatMode === 'group' && !options.threads?.some(t => t.kind === 'group' && t.active),
      actionId: 'new-group',
    },
    {
      id: 'action:open-chat',
      category: 'action',
      title: '切换到 AI 对话主舞台',
      subtitle: '返回最近正在进行的单人或团队会话',
      keywords: 'chat studio back 返回对话 会话 主舞台',
      badge: '导航',
      active: options.isChatActive && options.chatMode === 'session' && !options.threads?.some(t => t.kind === 'session' && t.active),
      actionId: 'open-chat',
    },
    {
      id: 'action:toggle-zen',
      category: 'action',
      title: options.zenFocusEnabled ? '退出沉浸专注模式' : '进入沉浸专注模式',
      subtitle: '一键收起左右侧栏与底栏，聚焦居中主舞台阅读与编码 (⌘\\ / Ctrl+\\)',
      keywords: 'zen focus zoom distraction free 沉浸 专注 全屏 极简 居中 阅读 编码',
      badge: '专注',
      shortcut: '⌘\\',
      active: Boolean(options.zenFocusEnabled),
      actionId: 'toggle-zen',
    },
    {
      id: 'action:open-showcase',
      category: 'action',
      title: '进入壁纸时钟屏保预览',
      subtitle: '全屏欣赏摄影画幅、电影动态视频或极光壁纸，叠加磨砂时钟与运行脉搏',
      keywords: 'ambient screensaver clock showcase tabliss bonjourr 屏保 时钟 壁纸预览 全屏壁纸 待机',
      badge: '壁纸',
      actionId: 'open-showcase',
    },
    {
      id: 'action:upload-wallpaper',
      category: 'action',
      title: '上传并切换本地壁纸',
      subtitle: '选择本地 PNG / JPG / WebP / AVIF / HEIC 图片作为全屏壁纸并自动取色',
      keywords: 'wallpaper upload image custom background 上传壁纸 本地图片 换壁纸 自定义背景',
      badge: '壁纸',
      actionId: 'upload-wallpaper',
    },
    {
      id: 'action:generate-wallpaper',
      category: 'action',
      title: '随机生成流光极光壁纸',
      subtitle: '零网络生成 1080P 流光极光 SVG 壁纸并匹配 WCAG 高对比度色板',
      keywords: 'aurora gradient procedural random wallpaper 随机壁纸 流光 极光 渐变 生成壁纸',
      badge: '壁纸',
      actionId: 'generate-wallpaper',
    },
    {
      id: 'action:cycle-wallpaper',
      category: 'action',
      title: '切换下一张壁纸 / 画幅',
      subtitle: '轮换当前沉浸摄影画幅、电影动态幕次或历史自定义壁纸',
      keywords: 'next cycle switch wallpaper frame scene 下一张壁纸 切换壁纸 换一张 画幅 幕次',
      badge: '壁纸',
      actionId: 'cycle-wallpaper',
    },
    {
      id: 'action:toggle-daylight',
      category: 'action',
      title: options.daylightEnabled ? '关闭壁纸昼夜自动流转' : '开启壁纸昼夜自动流转',
      subtitle: '按破晓 / 日间 / 暮色 / 暗夜本地时段自动切换摄影画幅或电影幕次',
      keywords: 'daylight bonjourr time schedule auto wallpaper 昼夜流转 时段 自动壁纸 日夜 晨昏',
      badge: '壁纸',
      active: Boolean(options.daylightEnabled),
      actionId: 'toggle-daylight',
    },
    {
      id: 'action:open-accounts',
      category: 'action',
      title: '打开多账号与执行器管理',
      subtitle: '查看 Cursor / Codex / Claude / Antigravity 登录状态、切换账号与 API 模型',
      keywords: 'accounts login quota cursor codex claude antigravity 多账号 登录 额度 模型 切换',
      badge: '账号',
      actionId: 'open-accounts',
    },
    {
      id: 'action:toggle-rail',
      category: 'action',
      title: options.railCollapsed ? '展开左侧功能目录栏' : '收起左侧功能目录栏',
      subtitle: '切换工作面板左侧导航栏折叠状态，释放更多主舞台横向空间',
      keywords: 'sidebar rail toggle collapse expand 侧边栏 左侧栏 收起 展开 折叠',
      badge: '布局',
      actionId: 'toggle-rail',
    },
    {
      id: 'action:refresh-page',
      category: 'action',
      title: '刷新当前视图数据',
      subtitle: '触发当前工作面板的刷新按钮或同步最新状态',
      keywords: 'refresh reload sync 刷新 同步 重新加载',
      badge: '动作',
      actionId: 'refresh-page',
    },
  ];

  for (const thread of options.threads || []) {
    items.push({
      id: `thread:${thread.kind}:${thread.id}`,
      category: 'thread',
      title: thread.title,
      subtitle: thread.subtitle,
      keywords: `${thread.title} ${thread.subtitle} ${thread.keywords || ''} ${thread.kind === 'group' ? 'group room 团队群聊 协作群' : 'session thread 单人会话 历史对话'}`,
      badge: thread.badge || (thread.kind === 'group' ? '群聊' : '会话'),
      active: thread.active,
      sessionId: thread.kind === 'session' ? thread.id : undefined,
      groupRoomId: thread.kind === 'group' ? thread.id : undefined,
    });
  }

  for (const bm of options.bookmarks || []) {
    items.push({
      id: `bookmark:${bm.id}`,
      category: 'bookmark',
      title: bm.excerpt,
      subtitle: `重点收藏 · ${bm.conversationTitle}${bm.turnIndex ? ` · 第 ${bm.turnIndex} 轮` : ''}（选中一键复制）`,
      keywords: `bookmark star favorite 收藏 书签 重点 ${bm.conversationTitle} ${bm.excerpt} ${bm.content.slice(0, 320)}`,
      badge: '收藏',
      sessionId: bm.conversationId,
      bookmarkContent: bm.content,
    });
  }

  const seenViews = new Set<string>();
  for (const section of options.sections) {
    for (const view of section.items) {
      if (seenViews.has(view.id)) continue;
      seenViews.add(view.id);
      items.push({
        id: `workspace:${view.id}`,
        category: 'workspace',
        title: view.label,
        subtitle: `${section.label} · ${view.path}`,
        keywords: `${view.label} ${section.label} ${view.id} ${VIEW_ALIASES[view.id] || ''}`,
        badge: section.shortLabel || section.label,
        active: !options.isChatActive && options.currentViewId === view.id,
        viewId: view.id,
      });
    }
  }

  for (const theme of themeOptions) {
    const wallpaperKeywords = ['immersive-photo', 'cinematic-video-hero', 'custom'].includes(theme.id)
      ? ' wallpaper 壁纸 背景 画幅 全屏'
      : '';
    items.push({
      id: `theme:${theme.id}`,
      category: 'theme',
      title: `主题：${theme.name}`,
      subtitle: theme.description,
      keywords: `theme skin appearance 主题 外观 皮肤 ${theme.id} ${theme.name} ${theme.dark ? 'dark 暗色 深色 夜间' : 'light 浅色 明亮'}${wallpaperKeywords}`,
      badge: theme.dark ? '深色' : '浅色',
      colors: theme.colors,
      active: options.currentThemeId === theme.id,
      themeId: theme.id,
    });
  }

  for (const portItem of options.ports || []) {
    items.push(portItem);
  }

  return items;
}

export function filterCommandPaletteItems(
  items: CommandPaletteItem[],
  rawQuery: string,
  categoryFilter: 'all' | CommandCategory = 'all',
  usageEntries?: readonly CommandUsageEntry[],
  nowMs = Date.now(),
  pinnedIds?: readonly string[],
): CommandPaletteItem[] {
  let trimmed = rawQuery.trim();
  let effectiveCategory = categoryFilter;

  if (trimmed.startsWith('>')) {
    effectiveCategory = 'action';
    trimmed = trimmed.slice(1).trim();
  } else if (trimmed.startsWith('@')) {
    effectiveCategory = 'thread';
    trimmed = trimmed.slice(1).trim();
  } else if (trimmed.startsWith('!') || trimmed.startsWith('！')) {
    effectiveCategory = 'bookmark';
    trimmed = trimmed.slice(1).trim();
  } else if (trimmed.startsWith(':') || trimmed.startsWith('：')) {
    effectiveCategory = 'port';
    trimmed = trimmed.slice(1).trim();
  } else if (trimmed.startsWith('#')) {
    effectiveCategory = 'theme';
    trimmed = trimmed.slice(1).trim();
  } else if (trimmed.startsWith('/')) {
    effectiveCategory = 'workspace';
    trimmed = trimmed.slice(1).trim();
  }

  const usageMap = new Map<string, CommandUsageEntry>();
  for (const entry of usageEntries || []) {
    usageMap.set(entry.id, entry);
  }

  const pinnedSet = new Set(pinnedIds || []);
  const pinnedRank = new Map<string, number>();
  (pinnedIds || []).forEach((id, idx) => {
    if (!pinnedRank.has(id)) pinnedRank.set(id, idx);
  });

  const decorateItem = (item: CommandPaletteItem): CommandPaletteItem => {
    const usage = usageMap.get(item.id);
    const isPinned = pinnedSet.has(item.id);
    if (!usage && !isPinned) return item;
    return {
      ...item,
      ...(usage ? { frequentlyUsed: true } : {}),
      ...(isPinned ? { pinned: true } : {}),
    };
  };

  const sortByPinAndUsageStable = (list: CommandPaletteItem[]): CommandPaletteItem[] => {
    if (!usageMap.size && !pinnedSet.size) return list;
    return list
      .map((item, idx) => ({
        item: decorateItem(item),
        pinOrder: pinnedRank.get(item.id) ?? Number.POSITIVE_INFINITY,
        boost: computeCommandFrecencyBoost(usageMap.get(item.id), nowMs),
        idx,
      }))
      .sort((a, b) => {
        if (a.pinOrder !== b.pinOrder) return a.pinOrder - b.pinOrder;
        return (b.boost - a.boost) || (a.idx - b.idx);
      })
      .map(entry => entry.item);
  };

  const pool = effectiveCategory === 'all'
    ? items
    : items.filter(item => item.category === effectiveCategory);

  if (!trimmed) {
    if (effectiveCategory !== 'all') return sortByPinAndUsageStable(pool);
    // Default balanced view: all pinned + all actions + top 4 bookmarks + top 6 recent threads + all workspaces + top 8 curated studio themes
    const featuredThemes = new Set(['cursor', 'linear', 'vercel', 'raycast', 'holy-grail', 'supabase', 'cinematic-video-hero', 'acid']);
    let threadShown = 0;
    let bookmarkShown = 0;
    const balanced = pool.filter(item => {
      if (pinnedSet.has(item.id)) return true;
      if (item.category === 'port') return false;
      if (item.category === 'bookmark') return bookmarkShown++ < 4;
      if (item.category === 'thread') return threadShown++ < 6;
      if (item.category === 'theme') return !!(item.themeId && featuredThemes.has(item.themeId));
      return true;
    });
    return sortByPinAndUsageStable(balanced);
  }

  const tokens = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { item: CommandPaletteItem; score: number }[] = [];

  for (const item of pool) {
    const titleLower = item.title.toLowerCase();
    const subtitleLower = item.subtitle.toLowerCase();
    const haystack = `${titleLower} ${subtitleLower} ${item.keywords.toLowerCase()}`;
    if (!tokens.every(token => haystack.includes(token))) continue;

    let score = 0;
    const first = tokens[0];
    if (titleLower === first || String(item.portNumber || '') === first) score += 120;
    else if (titleLower.startsWith(first) || titleLower.startsWith(`:${first}`)) score += 80;
    else if (titleLower.includes(first)) score += 50;
    else if (item.viewId?.toLowerCase().startsWith(first)) score += 45;
    else if (subtitleLower.includes(first)) score += 20;
    else score += 10;

    if (pinnedSet.has(item.id)) score += 28;
    if (item.active) score += 6;
    if (item.category === 'workspace') score += 4;
    if (item.category === 'thread' || item.category === 'bookmark') score += 2;
    score += computeCommandFrecencyBoost(usageMap.get(item.id), nowMs);
    scored.push({ item: decorateItem(item), score });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.item);
}
