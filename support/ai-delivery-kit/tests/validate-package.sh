#!/usr/bin/env bash
set -euo pipefail

KIT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILED=0

require_file() {
  local path="$1"
  if [[ ! -f "${KIT_ROOT}/${path}" ]]; then
    echo "missing required file: ${path}" >&2
    FAILED=1
  fi
}

require_dir() {
  local path="$1"
  if [[ ! -d "${KIT_ROOT}/${path}" ]]; then
    echo "missing required directory: ${path}" >&2
    FAILED=1
  fi
}

require_file "kit.yaml"
require_file "README.md"
require_file "core/gates.md"
require_file "core/gate-policy.md"
require_file "core/ai-friendly.md"
require_file "core/code-review-standard.md"
require_file "core/unit-test-standard.md"
require_file "core/api-contract-standard.md"
require_file "core/db-change-standard.md"
require_file "core/self-test-evidence-standard.md"
require_file "core/frontend-quality-standard.md"
require_file "core/artifacts.yaml"
require_file "core/deliverables.yaml"
require_file "core/checkpoints.yaml"
require_file "artifacts/templates/PRD.md"
require_file "artifacts/templates/prd-self-check.md"
require_file "artifacts/templates/gate-report.md"
require_file "artifacts/schemas/gate-result-schema.md"
require_file "prompts/gate-review.md"
require_file "prompts/R0-prd-self-check.md"
require_file "skills/manifest.tsv"
require_file "adapters/codex/AGENTS.md.template"
require_file "adapters/cursor/rules/ai-delivery-kit.mdc.template"
require_file "adapters/gate-engine/package-contract.md"
require_file "adapters/ai-delivery-hub/package-loader.md"

require_dir "core"
require_dir "artifacts/templates"
require_dir "prompts"
require_dir "skills"
require_dir "adapters"

while IFS=$'\t' read -r skill targets role summary; do
  [[ -z "${skill:-}" || "${skill:0:1}" == "#" ]] && continue
  require_file "skills/${skill}/SKILL.md"
  if [[ -f "${KIT_ROOT}/skills/${skill}/SKILL.md" ]]; then
    if ! grep -q "^name:[[:space:]]*${skill}[[:space:]]*$" "${KIT_ROOT}/skills/${skill}/SKILL.md"; then
      echo "skill name mismatch: ${skill}" >&2
      FAILED=1
    fi
  fi
done < "${KIT_ROOT}/skills/manifest.tsv"

if rg -n "[o]pencore/" "${KIT_ROOT}" >/tmp/ai-delivery-kit-validate-opencore.txt; then
  echo "found accidental opencore path replacements:" >&2
  cat /tmp/ai-delivery-kit-validate-opencore.txt >&2
  FAILED=1
fi

ACTIVE_SCAN_PATHS=(
  "README.md"
  "kit.yaml"
  "core"
  "artifacts"
  "prompts"
  "skills"
  "adapters"
)

OBSOLETE_PATTERNS=(
  "OPENSPEC_ROOT"
  "openspec_path"
  "spec_id"
  "spec_version"
  "openspec:artifact"
  "openspec_gate_runs"
  "ai-delivery-gate"
  "openspec-runner-server"
  "AI Delivery Runner"
  "OpenSpec"
  "openspec-review-hub($|[^-[:alnum:]_])"
)

for pattern in "${OBSOLETE_PATTERNS[@]}"; do
  if rg -n "${pattern}" "${ACTIVE_SCAN_PATHS[@]/#/${KIT_ROOT}/}" >/tmp/ai-delivery-kit-validate-obsolete.txt; then
    echo "found obsolete active AI Delivery Kit token: ${pattern}" >&2
    cat /tmp/ai-delivery-kit-validate-obsolete.txt >&2
    FAILED=1
  fi
done

if [[ "$FAILED" == "1" ]]; then
  exit 1
fi

echo "AI Delivery Kit package is valid."
