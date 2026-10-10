#!/usr/bin/env bash
set -euo pipefail

# Public AI Delivery Gate Engine entrypoint placeholder.
# Real CI/Agent implementations must follow core/ai-gate-engine.md.

usage() {
  cat <<'USAGE'
Usage:
  run-ai-gate.sh --gate G2a --context-pack requirements/2026-W23-demo --kit-path ai-delivery-kit --mode advisory --output gate-report.md

Required:
  --gate           Gate id, e.g. R0, R1a, R1b, G1, G2a, G2b, G3, G5, G8, G9
  --context-pack   Context Pack directory
  --kit-path       AI Delivery Kit package directory
  --mode           advisory or blocking
  --output         Gate report output path

G3 PR 证据:
  --changed-files  PR diff file list path or inline summary
  --ci-result      CI status, log path, or URL

This script validates the contract inputs only. Plug the actual shared Agent/CI executor behind this interface.
USAGE
}

GATE=""
CONTEXT_PACK=""
KIT_PATH=""
MODE=""
OUTPUT=""
CHANGED_FILES=""
CI_RESULT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gate)
      GATE="${2:-}"
      shift 2
      ;;
    --context-pack)
      CONTEXT_PACK="${2:-}"
      shift 2
      ;;
    --kit-path)
      KIT_PATH="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --changed-files)
      CHANGED_FILES="${2:-}"
      shift 2
      ;;
    --ci-result)
      CI_RESULT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$GATE" || -z "$CONTEXT_PACK" || -z "$KIT_PATH" || -z "$MODE" || -z "$OUTPUT" ]]; then
  usage >&2
  exit 2
fi

case "$MODE" in
  advisory|blocking) ;;
  *)
    echo "--mode must be advisory or blocking" >&2
    exit 2
    ;;
esac

case "$GATE" in
  R0|R1a|R1b|G1|G2a|G2b|G3|G5|G8|G9) ;;
  *)
    echo "Unsupported gate: $GATE" >&2
    exit 2
    ;;
esac

if [[ ! -d "$CONTEXT_PACK" ]]; then
  echo "Context Pack directory not found: $CONTEXT_PACK" >&2
  exit 2
fi

if [[ ! -d "$KIT_PATH" ]]; then
  echo "AI Delivery Kit package directory not found: $KIT_PATH" >&2
  exit 2
fi

REQUIRED_FILES=(
  kit.yaml
  core/gates.md
  core/gate-policy.md
  artifacts/schemas/gate-result-schema.md
  prompts/ai-gate-engine.md
  artifacts/templates/gate-report.md
)

for required_file in "${REQUIRED_FILES[@]}"; do
  if [[ ! -f "$KIT_PATH/$required_file" ]]; then
    echo "AI Delivery Kit required file not found: $KIT_PATH/$required_file" >&2
    exit 2
  fi
done

if [[ "$GATE" == "G3" && -n "$CHANGED_FILES" && -z "$CI_RESULT" ]]; then
  echo "G3 with --changed-files also requires --ci-result" >&2
  exit 2
fi

echo "AI Delivery Gate Engine contract validated."
echo "Gate: $GATE"
echo "Context Pack: $CONTEXT_PACK"
echo "Kit Path: $KIT_PATH"
echo "Mode: $MODE"
echo "Output: $OUTPUT"
if [[ -n "$CHANGED_FILES" ]]; then
  echo "Changed Files: $CHANGED_FILES"
fi
if [[ -n "$CI_RESULT" ]]; then
  echo "CI Result: $CI_RESULT"
fi
echo
echo "Next: invoke shared Agent with prompts/ai-gate-engine.md and write gate-report.md."
