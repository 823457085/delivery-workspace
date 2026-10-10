import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * 设计说明：追平看板只读取规范化事实源，避免把本地工作台变成第二套需求数据源。
 * 边界是展示范围、波次和非阻塞后续事项；功能还原统一标记为 STARTABLE，旧交付状态
 * 只进入 deliveryFollowups，不创建 Jira、Codex 队列或修改追平 JSON。
 * 不直接读取生成 Markdown 作为数据源，因为 Markdown 适合审阅，不适合稳定聚合。
 */

const domainDirectories = new Map([
  ["支付、订单与财务", "01-支付订单与财务"],
  ["设备、算法与监控", "02-设备算法与监控"],
  ["商户、会员与平台配置", "03-商户会员与平台配置"],
  ["内容、活动与工单", "04-内容活动与工单"],
  ["跨系统业务能力", "05-跨系统业务能力"]
]);

function items(value) {
  return Array.isArray(value?.items) ? value.items : [];
}

function countBy(values, key) {
  return values.reduce((counts, item) => {
    const value = String(item?.[key] || "UNKNOWN");
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {});
}

function waveNumber(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER;
}

function deliveryPlanningGaps(requirement) {
  const gaps = [];
  if (!requirement.planning?.jiraParent) gaps.push("Jira");
  if (!requirement.planning?.owner) gaps.push("Owner");
  if (!requirement.planning?.priority) gaps.push("优先级");
  if (!requirement.planning?.fixVersion) gaps.push("Fix Version");
  return gaps;
}

function deliveryFollowups(requirement, gaps) {
  const followups = [];
  if (["BLOCKED", "PARTIAL"].includes(requirement.phase1DemoApiStatus)) {
    followups.push("接口契约与联调");
  }
  if (requirement.decisionBlockers?.length) {
    followups.push(`正式 Gate 决策：${requirement.decisionBlockers.join("、")}`);
  }
  if (gaps.length > 0) followups.push(`交付信息：${gaps.join("、")}`);
  followups.push("正式 Gate 与验收");
  return followups;
}

export function buildCatchupBoard({
  manifest = {},
  requirements = {},
  workPackages = {},
  gitLandings = {},
  demoPathCoverage = {},
  decisions = {}
} = {}, { integrity = "STRUCTURE_ONLY" } = {}) {
  const requirementItems = items(requirements);
  const workPackageItems = items(workPackages);
  const landingItems = items(gitLandings);
  const demoPathItems = items(demoPathCoverage);
  const decisionsById = new Map(items(decisions).map((decision) => [decision.id, decision]));
  const workPackagesByRequirement = new Map();

  workPackageItems.forEach((workPackage) => {
    (workPackage.requirementIds || []).forEach((requirementId) => {
      workPackagesByRequirement.set(
        requirementId,
        (workPackagesByRequirement.get(requirementId) || 0) + 1
      );
    });
  });

  const acceptanceCriteria = requirementItems.reduce(
    (total, requirement) => total + (requirement.acceptanceCriteria?.length || 0),
    0
  );
  const demoClassifications = countBy(demoPathItems, "classification");
  const counts = {
    requirements: requirementItems.length,
    acceptanceCriteria,
    workPackages: workPackageItems.length,
    landings: landingItems.length,
    demoPaths: demoPathItems.length,
    runtimeRequired: demoClassifications.RUNTIME_REQUIRED || 0,
    engineeringEquivalent: demoClassifications.ENGINEERING_EQUIVALENT || 0,
    sourceOnlyExcluded: demoClassifications.SOURCE_ONLY_EXCLUDED || 0,
    runtimeMissingMapping: Number(manifest.scope?.demoPathCoverage?.runtimeMissingMapping || 0)
  };
  const countsMatch = [
    counts.requirements === manifest.entities?.requirements?.count,
    counts.workPackages === manifest.entities?.workPackages?.count,
    counts.landings === manifest.entities?.gitLandings?.count,
    counts.demoPaths === manifest.scope?.demoPathCoverage?.count,
    counts.acceptanceCriteria === manifest.scope?.frozenCounts?.acceptanceCriteria,
    decisionsById.size === manifest.entities?.decisions?.count
  ].every(Boolean);
  const allRequired = requirementItems.every((requirement) => requirement.parityObligation === "REQUIRED");
  const decisionReferencesValid = requirementItems.every((requirement) => (
    (requirement.decisionBlockers || []).every((decisionId) => decisionsById.has(decisionId))
  ));

  const normalizedRequirements = requirementItems
    .map((requirement) => {
      const gaps = deliveryPlanningGaps(requirement);
      const decisionDetails = (requirement.decisionBlockers || [])
        .map((decisionId) => decisionsById.get(decisionId))
        .filter(Boolean)
        .map((decision) => ({
          id: decision.id,
          title: decision.title,
          status: decision.status,
          impact: decision.impact,
          blocks: decision.blocks || [],
          blockingPhases: decision.blockingPhases || []
        }));
      return {
        id: requirement.id,
        slug: requirement.slug,
        title: requirement.title,
        goal: requirement.goal,
        businessDomain: requirement.businessDomain,
        wave: requirement.planning?.wave || "未分波次",
        functionalExecutionEligibility: "STARTABLE",
        parityObligation: requirement.parityObligation,
        deliveryStatus: requirement.deliveryStatus,
        pageStatus: requirement.phase1PageStatus,
        demoApiStatus: requirement.phase1DemoApiStatus,
        decisionBlockers: requirement.decisionBlockers || [],
        decisions: decisionDetails,
        gap: requirement.gap || "",
        acceptanceCriteria: requirement.acceptanceCriteria || [],
        architecturePlacement: requirement.architecturePlacement || {},
        acceptanceCriteriaCount: requirement.acceptanceCriteria?.length || 0,
        workPackageCount: workPackagesByRequirement.get(requirement.id) || 0,
        readinessGaps: gaps,
        deliveryFollowups: deliveryFollowups(requirement, gaps),
        nextAction: "功能可启动：按 Demo 还原页面、交互与业务规则；完成 AC 自测"
      };
    })
    .sort((left, right) => (
      waveNumber(left.wave) - waveNumber(right.wave)
      || left.businessDomain.localeCompare(right.businessDomain, "zh-CN")
      || left.id.localeCompare(right.id)
    ));

  return {
    apiVersion: 1,
    source: {
      updatedAt: manifest.updatedAt || null,
      integrity
    },
    scopeFrozen: manifest.scope?.scopeFrozen === true,
    evidenceStatus: manifest.scope?.scopeFrozen === true
      && countsMatch
      && allRequired
      && decisionReferencesValid
      && counts.runtimeMissingMapping === 0
      ? "PASS"
      : "CHECK",
    counts,
    deliveryStatuses: countBy(normalizedRequirements, "deliveryStatus"),
    functionalExecutionEligibilities: countBy(
      normalizedRequirements,
      "functionalExecutionEligibility"
    ),
    domains: [...new Set(normalizedRequirements.map((item) => item.businessDomain))],
    waves: [...new Set(normalizedRequirements.map((item) => item.wave))]
      .sort((left, right) => waveNumber(left) - waveNumber(right)),
    requirements: normalizedRequirements
  };
}

export async function readCatchupBoard(dataRoot) {
  try {
    const manifestBuffer = await fs.readFile(path.join(dataRoot, "manifest.json"));
    const manifest = JSON.parse(manifestBuffer.toString("utf8"));
    const filenames = [
      "requirements.json",
      "work-packages.json",
      "git-landings.json",
      "demo-path-coverage.json",
      "decisions.json"
    ];
    const buffers = await Promise.all(filenames.map((filename) => fs.readFile(path.join(dataRoot, filename))));
    const expectedHashes = new Map([
      ["requirements.json", manifest.entities?.requirements?.sha256],
      ["work-packages.json", manifest.entities?.workPackages?.sha256],
      ["git-landings.json", manifest.entities?.gitLandings?.sha256],
      ["demo-path-coverage.json", manifest.scope?.demoPathCoverage?.sha256],
      ["decisions.json", manifest.entities?.decisions?.sha256]
    ]);

    filenames.forEach((filename, index) => {
      const actual = createHash("sha256").update(buffers[index]).digest("hex");
      if (!expectedHashes.get(filename) || actual !== expectedHashes.get(filename)) {
        throw new Error("INTEGRITY_CHECK_FAILED");
      }
    });

    const [requirements, workPackages, gitLandings, demoPathCoverage, decisions] = buffers
      .map((buffer) => JSON.parse(buffer.toString("utf8")));
    return buildCatchupBoard(
      { manifest, requirements, workPackages, gitLandings, demoPathCoverage, decisions },
      { integrity: "VERIFIED" }
    );
  } catch (error) {
    if (error.code === "ENOENT" && error.path === path.join(dataRoot, "manifest.json")) return buildCatchupBoard({}, { integrity: "UNCONFIGURED" });
    if (error.message === "INTEGRITY_CHECK_FAILED") {
      throw new Error("追平事实完整性校验失败");
    }
    throw new Error("追平事实源不可用");
  }
}

export async function readCatchupDocument(dataRoot, type, requirementId = "") {
  const docsRoot = process.env.APEX_CATCHUP_DOCUMENTS_ROOT || path.join(dataRoot, "docs");
  let documentPath;

  if (type === "portal") {
    documentPath = path.join(docsRoot, "README.md");
  } else if (type === "gates") {
    documentPath = path.join(docsRoot, "04-审计证据", "Gate状态.md");
  } else if (type === "requirement" && /^REQ-(?:CU-)?\d{3}$/.test(requirementId)) {
    const board = await readCatchupBoard(dataRoot);
    const requirement = board.requirements.find((item) => item.id === requirementId);
    const directory = domainDirectories.get(requirement?.businessDomain);
    if (!directory) return null;
    documentPath = path.join(docsRoot, "01-需求明细", directory, `${requirementId}.md`);
  } else {
    return null;
  }

  const resolvedPath = path.resolve(documentPath);
  if (!resolvedPath.startsWith(`${docsRoot}${path.sep}`)) return null;
  const [realDocsRoot, realDocumentPath] = await Promise.all([
    fs.realpath(docsRoot),
    fs.realpath(resolvedPath)
  ]);
  if (!realDocumentPath.startsWith(`${realDocsRoot}${path.sep}`)) return null;
  return {
    content: await fs.readFile(realDocumentPath),
    filename: path.basename(realDocumentPath)
  };
}
