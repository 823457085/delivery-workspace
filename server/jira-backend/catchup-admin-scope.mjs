/** 追平范围由使用者的本地配置提供；撤销和复核仍复用原状态机门禁。 */
import path from "node:path";
import { catchupDataRoot, readOptionalJson } from "./config.mjs";

const scope = readOptionalJson(process.env.APEX_CATCHUP_SCOPE_FILE || path.join(catchupDataRoot, "scope.json"), {});
export function catchupAdminExclusionReason(requirementId) {
  return typeof scope.exclusions?.[requirementId] === "string" ? scope.exclusions[requirementId] : "";
}
export function catchupAdminScopeReviewReason(requirementId) {
  return typeof scope.reviews?.[requirementId] === "string" ? scope.reviews[requirementId] : "";
}
