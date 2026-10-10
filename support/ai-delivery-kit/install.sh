#!/usr/bin/env bash
# Install AI Delivery Kit as local AI skills plus a readable rules/templates/prompts package.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="${PKG}/skills/manifest.tsv"

TARGET="both"
MODE="copy"
DRY_RUN=0
VALIDATE=0
UNINSTALL=0
WRITE_AGENTS_DIR=""
FORCE_AGENTS=0
WRITE_CURSOR_RULES_DIR=""
FORCE_CURSOR_RULES=0
WORKSPACE_DIR=""

CODEX_HOME_DIR="${CODEX_HOME:-${HOME}/.codex}"
CODEX_SKILLS_DEST="${CODEX_SKILLS_DIR:-${CODEX_HOME_DIR}/skills}"
CODEX_PACKAGE_DEST="${AI_DELIVERY_KIT_CODEX_DEST:-${CODEX_HOME_DIR}/ai-delivery-kit}"

CURSOR_SKILLS_DIR_WAS_SET="${CURSOR_SKILLS_DIR+x}"
AI_DELIVERY_KIT_CURSOR_DEST_WAS_SET="${AI_DELIVERY_KIT_CURSOR_DEST+x}"
CURSOR_SKILLS_DEST="${CURSOR_SKILLS_DIR:-${ROOT}/.cursor/skills}"
CURSOR_PACKAGE_DEST="${AI_DELIVERY_KIT_CURSOR_DEST:-${ROOT}/.cursor/ai-delivery-kit}"

usage() {
  cat <<'USAGE'
Usage:
  ./install.sh [cursor|codex|both] [options]

Options:
  --mode copy|link        Install by copying files, or symlink to this repo. Default: copy.
  --validate             Validate skill metadata and required AI Delivery Kit resources.
  --dry-run              Print operations without changing files.
  --uninstall            Remove manifest-listed skills and installed AI Delivery Kit package.
  --write-codex-agents DIR
                          Write DIR/AGENTS.md so Codex can locate the package.
  --write-agents DIR     Alias of --write-codex-agents.
  --force-agents         Overwrite AGENTS.md when writing Codex instructions.
  --write-cursor-rules DIR
                          Write DIR/.cursor/rules/ai-delivery-kit.mdc.
  --force-cursor-rules   Overwrite Cursor rule when used with --write-cursor-rules.
  --workspace DIR        Install project-local Cursor package and write both Codex
                          AGENTS.md and Cursor rules for DIR unless explicit write
                          dirs are provided.
  -h, --help             Show this help.

Environment:
  CODEX_HOME                       Defaults to ~/.codex.
  CODEX_SKILLS_DIR                 Defaults to $CODEX_HOME/skills.
  AI_DELIVERY_KIT_CODEX_DEST       Defaults to $CODEX_HOME/ai-delivery-kit.
  CURSOR_SKILLS_DIR                Defaults to this repo's .cursor/skills.
  AI_DELIVERY_KIT_CURSOR_DEST      Defaults to this repo's .cursor/ai-delivery-kit.
USAGE
}

log() {
  printf '%s\n' "$*"
}

run_mkdir() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: mkdir -p $1"
  else
    mkdir -p "$1"
  fi
}

run_rm() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: rm -rf $1"
  else
    rm -rf "$1"
  fi
}

run_cp_dir() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: cp -R $1 $2"
  else
    cp -R "$1" "$2"
  fi
}

run_ln() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: ln -s $1 $2"
  else
    ln -s "$1" "$2"
  fi
}

parse_args() {
  if [[ "${1:-}" == "cursor" || "${1:-}" == "codex" || "${1:-}" == "both" ]]; then
    TARGET="$1"
    shift
  fi

  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --mode)
        MODE="${2:-}"
        shift 2
        ;;
      --validate)
        VALIDATE=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --uninstall)
        UNINSTALL=1
        shift
        ;;
      --write-codex-agents|--write-agents)
        WRITE_AGENTS_DIR="${2:-}"
        shift 2
        ;;
      --force-agents)
        FORCE_AGENTS=1
        shift
        ;;
      --write-cursor-rules)
        WRITE_CURSOR_RULES_DIR="${2:-}"
        shift 2
        ;;
      --force-cursor-rules)
        FORCE_CURSOR_RULES=1
        shift
        ;;
      --workspace)
        WORKSPACE_DIR="${2:-}"
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

  case "$TARGET" in
    cursor|codex|both) ;;
    *)
      echo "Invalid target: ${TARGET}" >&2
      exit 2
      ;;
  esac

  case "$MODE" in
    copy|link) ;;
    *)
      echo "Invalid --mode: ${MODE}" >&2
      exit 2
      ;;
  esac
}

apply_workspace_defaults() {
  local workspace="$WORKSPACE_DIR"

  if [[ -z "$workspace" ]]; then
    return
  fi

  if [[ -d "$workspace" ]]; then
    workspace="$(cd "$workspace" && pwd)"
  fi
  workspace="${workspace%/}"

  if [[ -z "$WRITE_AGENTS_DIR" ]]; then
    WRITE_AGENTS_DIR="$workspace"
  fi
  if [[ -z "$WRITE_CURSOR_RULES_DIR" ]]; then
    WRITE_CURSOR_RULES_DIR="$workspace"
  fi
  if [[ -z "$CURSOR_SKILLS_DIR_WAS_SET" ]]; then
    CURSOR_SKILLS_DEST="${workspace}/.cursor/skills"
  fi
  if [[ -z "$AI_DELIVERY_KIT_CURSOR_DEST_WAS_SET" ]]; then
    CURSOR_PACKAGE_DEST="${workspace}/.cursor/ai-delivery-kit"
  fi
}

load_skills() {
  local requested="$1"
  local skill targets role summary
  SKILLS=()

  if [[ ! -f "$MANIFEST" ]]; then
    echo "Missing skills manifest: ${MANIFEST}" >&2
    exit 1
  fi

  while IFS=$'\t' read -r skill targets role summary; do
    [[ -z "${skill:-}" || "${skill:0:1}" == "#" ]] && continue
    if [[ "$requested" == "both" || ",${targets}," == *",${requested},"* ]]; then
      SKILLS+=("$skill")
    fi
  done < "$MANIFEST"
}

validate_source() {
  local failed=0
  local skill file
  local required_files=(
    "kit.yaml"
    "README.md"
    "core/gates.md"
    "core/gate-policy.md"
    "artifacts/templates/PRD.md"
    "artifacts/templates/prd-self-check.md"
    "artifacts/schemas/gate-result-schema.md"
    "prompts/gate-review.md"
    "prompts/R0-prd-self-check.md"
    "adapters/codex/AGENTS.md.template"
    "adapters/cursor/rules/ai-delivery-kit.mdc.template"
  )

  for file in "${required_files[@]}"; do
    if [[ ! -f "${PKG}/${file}" ]]; then
      echo "validate failed: missing ${file}" >&2
      failed=1
    fi
  done

  for skill in "${SKILLS[@]}"; do
    file="${PKG}/skills/${skill}/SKILL.md"
    if [[ ! -f "$file" ]]; then
      echo "validate failed: missing ${skill}/SKILL.md" >&2
      failed=1
      continue
    fi
    if ! grep -q "^name:[[:space:]]*${skill}[[:space:]]*$" "$file"; then
      echo "validate failed: ${skill}/SKILL.md has missing or mismatched name" >&2
      failed=1
    fi
    if ! grep -q "^description:[[:space:]]." "$file"; then
      echo "validate failed: ${skill}/SKILL.md missing description" >&2
      failed=1
    fi
  done

  if [[ -f "${PKG}/tests/validate-package.sh" ]]; then
    bash "${PKG}/tests/validate-package.sh"
  fi

  if [[ "$failed" == "1" ]]; then
    exit 1
  fi
  log "validated: AI Delivery Kit resources and ${#SKILLS[@]} skills"
}

install_package_to() {
  local dest="$1"
  run_mkdir "$(dirname "$dest")"
  run_rm "$dest"
  if [[ "$MODE" == "link" ]]; then
    run_ln "$PKG" "$dest"
  else
    run_cp_dir "$PKG" "$dest"
  fi
  log "installed package: ${dest}"
}

install_skills_to() {
  local dest="$1"
  local skill
  run_mkdir "$dest"
  for skill in "${SKILLS[@]}"; do
    run_rm "${dest}/${skill}"
    if [[ "$MODE" == "link" ]]; then
      run_ln "${PKG}/skills/${skill}" "${dest}/${skill}"
    else
      run_cp_dir "${PKG}/skills/${skill}" "${dest}/${skill}"
    fi
    log "installed skill: ${skill} -> ${dest}"
  done
}

uninstall_from() {
  local skills_dest="$1"
  local package_dest="$2"
  local skill
  for skill in "${SKILLS[@]}"; do
    run_rm "${skills_dest}/${skill}"
    log "removed skill: ${skills_dest}/${skill}"
  done
  run_rm "$package_dest"
  log "removed package: ${package_dest}"
}

write_agents() {
  local workspace="$1"
  local package_root="$2"
  local template="${PKG}/adapters/codex/AGENTS.md.template"
  local dest="${workspace%/}/AGENTS.md"
  local content

  if [[ -z "$workspace" ]]; then
    return
  fi
  if [[ ! -f "$template" ]]; then
    echo "Missing AGENTS template: ${template}" >&2
    exit 1
  fi
  if [[ -f "$dest" && "$FORCE_AGENTS" != "1" ]]; then
    log "skipped AGENTS.md: ${dest} already exists; use --force-agents to overwrite"
    return
  fi

  content="$(<"$template")"
  content="${content//__AI_DELIVERY_KIT_PACKAGE__/$package_root}"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: write ${dest}"
  else
    mkdir -p "$workspace"
    printf '%s\n' "$content" > "$dest"
  fi
  log "wrote Codex workspace instructions: ${dest}"
}

write_cursor_rules() {
  local workspace="$1"
  local package_root="$2"
  local template="${PKG}/adapters/cursor/rules/ai-delivery-kit.mdc.template"
  local dest="${workspace%/}/.cursor/rules/ai-delivery-kit.mdc"
  local content

  if [[ -z "$workspace" ]]; then
    return
  fi
  if [[ ! -f "$template" ]]; then
    echo "Missing Cursor rule template: ${template}" >&2
    exit 1
  fi
  if [[ -f "$dest" && "$FORCE_CURSOR_RULES" != "1" ]]; then
    log "skipped Cursor rule: ${dest} already exists; use --force-cursor-rules to overwrite"
    return
  fi

  content="$(<"$template")"
  content="${content//__AI_DELIVERY_KIT_PACKAGE__/$package_root}"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "dry-run: write ${dest}"
  else
    mkdir -p "$(dirname "$dest")"
    printf '%s\n' "$content" > "$dest"
  fi
  log "wrote Cursor project rule: ${dest}"
}

main() {
  parse_args "$@"
  apply_workspace_defaults
  load_skills "$TARGET"

  if [[ "$VALIDATE" == "1" ]]; then
    validate_source
  fi

  if [[ "$UNINSTALL" == "1" ]]; then
    if [[ "$TARGET" == "codex" || "$TARGET" == "both" ]]; then
      uninstall_from "$CODEX_SKILLS_DEST" "$CODEX_PACKAGE_DEST"
    fi
    if [[ "$TARGET" == "cursor" || "$TARGET" == "both" ]]; then
      uninstall_from "$CURSOR_SKILLS_DEST" "$CURSOR_PACKAGE_DEST"
    fi
    log "Done. AI Delivery Kit uninstalled for ${TARGET}"
    return
  fi

  if [[ "$TARGET" == "codex" || "$TARGET" == "both" ]]; then
    install_package_to "$CODEX_PACKAGE_DEST"
    install_skills_to "$CODEX_SKILLS_DEST"
  fi
  if [[ "$TARGET" == "cursor" || "$TARGET" == "both" ]]; then
    install_package_to "$CURSOR_PACKAGE_DEST"
    install_skills_to "$CURSOR_SKILLS_DEST"
  fi

  if [[ -n "$WRITE_AGENTS_DIR" ]]; then
    write_agents "$WRITE_AGENTS_DIR" "$CODEX_PACKAGE_DEST"
  fi
  if [[ -n "$WRITE_CURSOR_RULES_DIR" ]]; then
    write_cursor_rules "$WRITE_CURSOR_RULES_DIR" "$CURSOR_PACKAGE_DEST"
  fi

  log "Done. ai-delivery-kit installed for ${TARGET} (${MODE})"
  log "Skills manifest: ${MANIFEST}"
  log "Codex package: ${CODEX_PACKAGE_DEST}"
  log "Cursor package: ${CURSOR_PACKAGE_DEST}"
}

main "$@"
