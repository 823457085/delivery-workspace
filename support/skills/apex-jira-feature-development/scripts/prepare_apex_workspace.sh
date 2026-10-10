#!/usr/bin/env bash
set -euo pipefail

readonly DEFAULT_REPO_URL=""

usage() {
  printf 'Usage: %s <JIRA-KEY> <BASE-REF> [BRANCH]\n' "$0" >&2
}

if [[ $# -lt 2 || $# -gt 3 ]]; then
  usage
  exit 2
fi

issue_key="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
base_ref="$2"
branch="${3:-feature/${issue_key}}"

if [[ ! "$issue_key" =~ ^[A-Z][A-Z0-9]+-[0-9]+$ ]]; then
  printf 'Invalid Jira key: %s\n' "$1" >&2
  exit 2
fi

if ! git check-ref-format --branch "$branch" >/dev/null 2>&1; then
  printf 'Invalid branch name: %s\n' "$branch" >&2
  exit 2
fi

desktop_root="${APEX_DESKTOP_ROOT:-$HOME/Desktop}"
month="${APEX_MONTH:-$(date +%m)}"
repo_url="${APEX_REPO_URL:-$DEFAULT_REPO_URL}"
if [[ -z "$repo_url" ]]; then
  printf "Set APEX_REPO_URL to your own repository URL before preparing a workspace.\n" >&2
  exit 2
fi

if [[ ! "$month" =~ ^(0[1-9]|1[0-2])$ ]]; then
  printf 'APEX_MONTH must be a two-digit month from 01 to 12: %s\n' "$month" >&2
  exit 2
fi

monthly_root="${desktop_root}/apex-${month}"
workspace="${monthly_root}/${issue_key}"

mkdir -p "$monthly_root"

if [[ -e "$workspace" ]]; then
  if [[ ! -d "$workspace" ]]; then
    printf 'Workspace path exists but is not a directory: %s\n' "$workspace" >&2
    exit 3
  fi

  if ! git -C "$workspace" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [[ -n "$(find "$workspace" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      printf 'Workspace is nonempty and is not a Git repository: %s\n' "$workspace" >&2
      exit 3
    fi
    git clone "$repo_url" "$workspace"
  fi
else
  git clone "$repo_url" "$workspace"
fi

workspace_root="$(git -C "$workspace" rev-parse --show-toplevel)"
workspace_real="$(cd "$workspace" && pwd -P)"
if [[ "$workspace_root" != "$workspace_real" ]]; then
  printf 'Workspace is not the repository root: %s\n' "$workspace" >&2
  exit 3
fi

origin_url="$(git -C "$workspace" remote get-url origin)"
if [[ "$origin_url" != "$repo_url" ]]; then
  printf 'Unexpected origin for %s\nExpected: %s\nActual:   %s\n' "$workspace" "$repo_url" "$origin_url" >&2
  exit 3
fi

git -C "$workspace" fetch origin --prune

current_branch="$(git -C "$workspace" branch --show-current)"
if [[ "$current_branch" != "$branch" && -n "$(git -C "$workspace" status --porcelain)" ]]; then
  printf 'Workspace has changes on branch %s; refusing to switch to %s\n' "$current_branch" "$branch" >&2
  exit 4
fi

if git -C "$workspace" show-ref --verify --quiet "refs/heads/${branch}"; then
  git -C "$workspace" switch "$branch"
elif git -C "$workspace" show-ref --verify --quiet "refs/remotes/origin/${branch}"; then
  git -C "$workspace" switch --track -c "$branch" "origin/${branch}"
else
  if ! git -C "$workspace" rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null; then
    printf 'Base ref does not exist in the fetched repository: %s\n' "$base_ref" >&2
    exit 5
  fi
  git -C "$workspace" switch --no-track -c "$branch" "$base_ref"
fi

printf 'WORKSPACE_PATH=%s\n' "$workspace_real"
printf 'ORIGIN=%s\n' "$origin_url"
printf 'BASE_REF=%s\n' "$base_ref"
printf 'BRANCH=%s\n' "$(git -C "$workspace" branch --show-current)"
printf 'STATUS_BEGIN\n'
git -C "$workspace" status --short
printf 'STATUS_END\n'
