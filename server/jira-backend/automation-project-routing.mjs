import path from "node:path";
import { repositoryIdentity } from "../jira-dev/repository-groups.mjs";

const text = (value, limit = 500) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, limit)
  : "";
const folded = (value) => text(value).toLowerCase();
const list = (value) => [...new Set((Array.isArray(value) ? value : []).map(item => text(item, 160)).filter(Boolean))];

function remoteIdentity(value) {
  if (typeof value !== "string" || /[\s\u0000-\u001f\u007f?#]/.test(value)) return null;
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      if (url.password || (["http:", "https:"].includes(url.protocol) && url.username)) return null;
    } catch { return null; }
  }
  return repositoryIdentity(value);
}

/** Undefined is the one-time legacy migration; an explicit empty list stays empty. */
export function sanitizeAutomationProjectProfiles(value, legacySettings = {}) {
  if (value === undefined) {
    if (!legacySettings.repositoryUrl) return [];
    const identity = remoteIdentity(legacySettings.repositoryUrl);
    value = [{
      id: "legacy-default",
      name: identity?.name || "原默认仓库",
      repositoryUrl: legacySettings.repositoryUrl,
      localPath: "",
      runtimeCommand: legacySettings.runtimeCommand,
      runtimeEnvironment: legacySettings.runtimeEnvironment,
      targetBranch: legacySettings.targetBranch,
      jiraProjects: [], components: [], labels: []
    }];
  }
  if (!Array.isArray(value)) throw new Error("自动执行项目配置必须是数组");
  const ids = new Set();
  return value.map(item => {
    const id = text(item?.id, 160);
    if (!id || ids.has(id)) throw new Error("自动执行项目配置 ID 不能为空或重复");
    ids.add(id);
    return {
      id,
      name: text(item.name, 160),
      repositoryUrl: text(item.repositoryUrl, 500),
      localPath: text(item.localPath, 2000),
      runtimeCommand: text(item.runtimeCommand, 500),
      runtimeEnvironment: text(item.runtimeEnvironment, 80),
      targetBranch: text(item.targetBranch, 160),
      jiraProjects: list(item.jiraProjects),
      components: list(item.components),
      labels: list(item.labels)
    };
  });
}

function profileProblem(profile) {
  if (!profile?.id) return "项目配置 ID 缺失，请重新核对";
  if (!profile || !remoteIdentity(profile.repositoryUrl)) return "项目仓库地址缺失或无效";
  if (!profile.runtimeEnvironment || !profile.runtimeCommand || !profile.targetBranch) {
    return "项目的运行环境、启动命令或目标分支尚未配置完整";
  }
  if (profile.localPath && !path.isAbsolute(profile.localPath)) return "项目本地目录必须是绝对路径";
  return "";
}

function matchesKey(project, issueKey) {
  const key = text(issueKey).toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return false;
  const segments = [project.folderName, ...String(project.path || "").split(/[\\/]/),
    ...String(project.branch || "").split("/")];
  return segments.some(value => {
    const segment = String(value || "").toUpperCase();
    return segment === key || segment.startsWith(`${key}-`);
  });
}

/** Only exact issue-key boundaries count; a child workspace takes precedence over a parent's. */
export function issueWorkspaceCandidates(issue, projects = []) {
  const own = projects.filter(project => matchesKey(project, issue?.key));
  const matches = own.length ? own : projects.filter(project => matchesKey(project, issue?.parent?.key));
  return [...new Map(matches.map(project => [project.path || project.projectId, project])).values()];
}

const workspaceIdentity = project => remoteIdentity(project?.remoteUrl || project?.repositoryUrl || "");

function descriptionText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (value.type === "hardBreak") return "\n";
  if (typeof value.text === "string") return value.text;
  return (value.content || []).map(descriptionText).join(value.type === "paragraph" ? "" : "\n");
}

function explicitRepositories(issue) {
  const references = [];
  for (const rawLine of descriptionText(issue?.description).replace(/(?:\\r)?\\n/g, "\n").split(/\r?\n/)) {
    const line = rawLine.replace(/\*/g, "").replace(/^\s*(?:-\s*|#{1,6}\s+)/, "");
    const match = /^\s*(Repository\s+(?:ID|URL|Name)|仓库(?:\s*(?:URL|ID)|地址|名称|名)?|项目范围)\s*[:：]\s*(.+)$/i.exec(line);
    if (!match) {
      // An unsupported declaration format must not silently fall through to a different project's broad rule.
      if (/(Repository\s+(?:ID|URL|Name)|仓库(?:\s*(?:URL|ID)|地址|名称|名)?)\s*[:：]/i.test(line)) {
        references.push({ kind: "unparsed", value: "" });
      }
      continue;
    }
    const kind = /ID$/i.test(match[1]) ? "id" : /URL$|地址$/i.test(match[1]) ? "url" : "name";
    for (let value of match[2].replace(/[（(]共\s*\d+\s*个项目[）)]\s*$/, "").split(/[,，、;]/)) {
      value = value.trim().replace(/^`+|`+$/g, "");
      const link = /^\[[^\]]*\]\(([^)]+)\)$/.exec(value) || /^\[[^|\]]*\|([^\]]+)\]$/.exec(value);
      if (link) value = link[1];
      if (value) references.push({ kind: remoteIdentity(value) ? "url" : kind, value });
    }
  }
  return references;
}

function matchesReference(profile, reference) {
  if (reference.kind === "unparsed") return false;
  const identity = remoteIdentity(profile.repositoryUrl);
  if (reference.kind === "url") return Boolean(identity && identity.repositoryId === remoteIdentity(reference.value)?.repositoryId);
  if (reference.kind === "id") return reference.value === profile.id || reference.value === identity?.repositoryId;
  return [profile.name, identity?.name].some(name => folded(name) === folded(reference.value));
}

function matchesRules(profile, issue) {
  const project = typeof issue?.project === "object" ? issue.project?.key : issue?.project;
  const dimensions = [
    [profile.jiraProjects, [project]],
    [profile.components, (issue?.components || []).flatMap(component => typeof component === "string" ? [component] : [component.id, component.name])],
    [profile.labels, issue?.labels || []]
  ];
  return dimensions.some(([rules]) => rules.length)
    && dimensions.every(([rules, values]) => !rules.length || rules.some(rule => values.some(value => folded(rule) === folded(value))));
}

export function resolveAutomationProject(issue, projects = [], settings = {}, boundWorkspace = null) {
  const profiles = sanitizeAutomationProjectProfiles(settings.projectProfiles, settings);
  const result = (status, reason, candidates = [], profile = null, workspace = null) => ({ status, reason, profile, candidates, workspace });
  const signals = [];
  const references = explicitRepositories(issue);
  const explicit = [...new Set(references.flatMap(reference => profiles.filter(profile => matchesReference(profile, reference))))];
  if (references.some(reference => !profiles.some(profile => matchesReference(profile, reference)))) {
    return result(explicit.length ? "ambiguous" : "unmatched", "Jira 声明的仓库尚未全部配置，需核对项目范围", explicit);
  }
  if (explicit.length) {
    if (new Set(explicit.map(profile => remoteIdentity(profile.repositoryUrl)?.repositoryId)).size > 1) {
      return result("ambiguous", "Jira 明确涉及多个仓库，需先选择执行项目", explicit);
    }
    signals.push({ reason: "Jira 仓库声明", profiles: explicit });
  }

  // 手动任务已经选定具体的来源检出，不再按路径和分支中的 Jira 编号猜测。
  const workspaces = boundWorkspace ? [boundWorkspace] : issueWorkspaceCandidates(issue, projects);
  if (workspaces.length) {
    const identities = workspaces.map(workspaceIdentity);
    const workspaceProfiles = profiles.filter(profile => identities.some(identity => identity && identity.repositoryId === remoteIdentity(profile.repositoryUrl)?.repositoryId));
    const repositoryIds = new Set(identities.filter(Boolean).map(identity => identity.repositoryId));
    if (repositoryIds.size > 1) return result("ambiguous", "同一 Jira 事项匹配多个仓库工作区，需先选择执行项目", [...new Set([...explicit, ...workspaceProfiles])]);
    if (identities.some(identity => !identity) || !workspaceProfiles.length) {
      return result("unmatched", "事项工作区的仓库未配置或无法核对，不能套用其他项目命令", explicit);
    }
    signals.push({ reason: "事项工作区", profiles: workspaceProfiles });
  }

  const ruleProfiles = profiles.filter(profile => matchesRules(profile, issue));
  if (ruleProfiles.length) signals.push({ reason: "项目匹配规则", profiles: ruleProfiles });
  if (!signals.length) return result("unmatched", "未匹配项目；请配置 Jira 项目、组件、标签规则，或在 Jira 描述中声明仓库");
  const candidates = signals.reduce((remaining, signal) => remaining.filter(profile => signal.profiles.includes(profile)), profiles);
  if (!candidates.length) return result("ambiguous", "Jira 仓库、事项工作区与项目匹配规则冲突，需核对后再执行", [...new Set(signals.flatMap(signal => signal.profiles))]);
  if (candidates.length > 1) return result("ambiguous", "多个项目配置同时匹配，需收窄规则或明确执行项目", candidates);
  const [profile] = candidates;
  const problem = profileProblem(profile);
  if (problem) return result("incomplete", problem, candidates, profile);
  const source = profile.localPath && projects.find(project => project.path === profile.localPath);
  if (source && workspaceIdentity(source)?.repositoryId !== remoteIdentity(profile.repositoryUrl).repositoryId) {
    return result("incomplete", "项目本地目录与配置仓库不一致或无法核对", candidates, profile);
  }
  if (workspaces.length > 1) return result("ambiguous", "同一事项存在多个工作区，需先确认执行目录", candidates);
  return result("matched", `已通过${signals.map(signal => signal.reason).join("、")}匹配项目`, candidates, profile, workspaces[0] || null);
}

/** Claim-time check: persisted routing is authoritative; absent/stale routing never falls back globally. */
export function automationProjectRoutingProblem(routing, settings = {}) {
  if (routing?.status !== "matched" || !routing.profile) return routing?.reason || "任务尚未保存可执行的项目路由，请重新巡检";
  const problem = profileProblem(routing.profile);
  if (problem) return problem;
  const current = sanitizeAutomationProjectProfiles(settings.projectProfiles, settings).find(profile => profile.id === routing.profile.id);
  if (!current || JSON.stringify(current) !== JSON.stringify(sanitizeAutomationProjectProfiles([routing.profile])[0])) {
    return "项目配置已变更或删除，请重新巡检后再执行";
  }
  if (routing.workspace && workspaceIdentity(routing.workspace)?.repositoryId !== remoteIdentity(current.repositoryUrl).repositoryId) {
    return "已保存工作区与项目仓库不一致或无法核对，请重新巡检";
  }
  return "";
}

export function isAutomationProjectRoutingReady(routing, settings = {}) {
  return !automationProjectRoutingProblem(routing, settings);
}
