/**
 * 跨 Git Worktree 并行冲突雷达共享数据结构（前后端通用，零 Node 依赖）
 *
 * 设计借鉴自 GitHub 开源项目：
 * - `clash-sh/clash`：跨多个 Git Worktree 的无损只读冲突探测（`git merge-tree` + 未提交行块重叠分析）
 * - `BloopAI/vibe-kanban`：多 Agent 并行工作区文件碰撞可视化预警
 */

export type WorktreeCollisionSource = 'merge-tree' | 'dirty-hunk' | 'untracked-collision';

export interface WorktreeSiblingRadarItem {
  path: string;
  folderName: string;
  branch: string;
  head: string;
  dirtyCount: number;
  aheadOfMergeBase: number;
  behindMergeBase: number;
  status: 'conflict' | 'overlap' | 'clean';
  overlappingFiles: string[];
  conflictingFiles: string[];
  conflictSources: WorktreeCollisionSource[];
}

export interface WorktreeConflictRadarReport {
  checkedAt: string;
  currentPath: string;
  currentBranch: string;
  currentHead: string;
  totalWorktrees: number;
  siblingCount: number;
  conflictCount: number;
  overlapCount: number;
  siblings: WorktreeSiblingRadarItem[];
}
