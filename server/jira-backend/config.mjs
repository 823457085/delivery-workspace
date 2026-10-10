/** 分享版本的本地配置；业务资料和凭据由使用者配置，源码不携带个人工作区。 */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const sourceDataRoot = process.env.DELIVERY_SOURCE_DATA_DIR || path.join(repositoryRoot, ".data", "source");
export const catchupDataRoot = process.env.APEX_CATCHUP_DATA_ROOT || path.join(sourceDataRoot, "catchup");
const packagedSkillsRoot = path.join(repositoryRoot, "support", "skills");
export const skillsRoot = process.env.DELIVERY_SKILLS_ROOT || (fs.existsSync(packagedSkillsRoot)
  ? packagedSkillsRoot : path.join(process.env.CODEX_HOME || path.join(homedir(), ".codex"), "skills"));
export const gitBinary = process.env.DELIVERY_GIT_BIN || "git";

export function readOptionalJson(filename, fallback) {
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error(`本地配置无效：${path.basename(filename)}`);
  }
}
