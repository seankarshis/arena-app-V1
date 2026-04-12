#!/usr/bin/env bash
#
# sync-workflow-to-main.sh — Copy workflow and action files to main branch.
#
# GitHub Actions only reads workflow files from the default branch for PR
# triggers. This script copies the latest workflow/action files from the
# current branch to main and pushes them.
#
# Usage:
#   ./scripts/sync-workflow-to-main.sh              # Sync all workflow files
#   ./scripts/sync-workflow-to-main.sh --dry-run     # Show what would be synced
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h) head -12 "$0" | tail -10; exit 0 ;;
  esac
done

SYNC_FILES=(
  ".github/workflows/pr-pipeline.yml"
  ".github/actions/run-agent/action.yml"
)

CURRENT_BRANCH=$(git branch --show-current)
if [[ "$CURRENT_BRANCH" == "main" ]]; then
  echo "ERROR: Already on main. Run this from your feature branch." >&2
  exit 1
fi

echo "==> Syncing workflow files from '$CURRENT_BRANCH' to main"

# Stash if needed
if ! git diff --quiet || ! git diff --staged --quiet; then
  echo "    Stashing uncommitted changes..."
  git stash push -m "sync-workflow-to-main auto-stash"
  STASHED=true
else
  STASHED=false
fi

git checkout main
git pull --ff-only origin main 2>/dev/null || true

CHANGED=false
for file in "${SYNC_FILES[@]}"; do
  echo -n "    $file ... "
  if git show "$CURRENT_BRANCH:$file" > /dev/null 2>&1; then
    git checkout "$CURRENT_BRANCH" -- "$file"
    echo "copied"
    CHANGED=true
  else
    echo "not found on $CURRENT_BRANCH (skipped)"
  fi
done

if [[ "$CHANGED" == "true" ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    echo "==> Dry run — would commit:"
    git diff --staged --stat
    git checkout .
  else
    git add -A .github/
    if git diff --staged --quiet; then
      echo "    No changes (files already identical on main)"
    else
      git commit -m "Sync CI pipeline workflow from $CURRENT_BRANCH"
      git push origin main
      echo "==> Pushed updated workflows to main"
    fi
  fi
fi

git checkout "$CURRENT_BRANCH"
if [[ "$STASHED" == "true" ]]; then
  echo "    Restoring stashed changes..."
  git stash pop
fi

echo "==> Done."
