#!/usr/bin/env bash
#
# lambda-build-deploy.sh — Build, package, and deploy CI agent Lambda functions.
#
# Usage:
#   ./scripts/lambda-build-deploy.sh              # Build + deploy all 7 agents
#   ./scripts/lambda-build-deploy.sh --skip-build  # Package + deploy without recompiling TS
#   ./scripts/lambda-build-deploy.sh --dry-run     # Build + package only, don't deploy
#   ./scripts/lambda-build-deploy.sh linting security  # Deploy only named agents
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LAMBDA_DIR="$REPO_ROOT/infrastructure/lambdas"
DIST_DIR="$LAMBDA_DIR/dist"
PKG_DIR="/tmp/lambda-packages"
AWS_REGION="us-east-2"

ALL_AGENTS=(linting security speed unit-tests documentation api-contracts synthesis)

SKIP_BUILD=false
DRY_RUN=false
SELECTED_AGENTS=()

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=true ;;
    --dry-run)    DRY_RUN=true ;;
    --help|-h)    head -10 "$0" | tail -8; exit 0 ;;
    *)
      if printf '%s\n' "${ALL_AGENTS[@]}" | grep -qx "$arg"; then
        SELECTED_AGENTS+=("$arg")
      else
        echo "ERROR: Unknown agent or flag: $arg" >&2
        echo "Valid agents: ${ALL_AGENTS[*]}" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ ${#SELECTED_AGENTS[@]} -eq 0 ]]; then
  SELECTED_AGENTS=("${ALL_AGENTS[@]}")
fi

echo "==> Agents: ${SELECTED_AGENTS[*]} | Region: $AWS_REGION"

if [[ "$SKIP_BUILD" == "false" ]]; then
  echo "==> Compiling TypeScript..."
  cd "$LAMBDA_DIR" && npx tsc
  echo "    Build complete."
fi

echo "==> Fixing require paths..."
for agent in "${SELECTED_AGENTS[@]}"; do
  handler="$DIST_DIR/agent-$agent/handler.js"
  if [[ -f "$handler" ]]; then
    sed -i 's|require("\.\./shared/|require("./shared/|g' "$handler"
    echo "    Fixed: agent-$agent"
  fi
done

echo "==> Packaging zips..."
for agent in "${SELECTED_AGENTS[@]}"; do
  pkg="$PKG_DIR/ci-agent-$agent"
  rm -rf "$pkg" && mkdir -p "$pkg"
  cp -r "$DIST_DIR/agent-$agent/"* "$pkg/"
  cp -r "$DIST_DIR/shared" "$pkg/shared"
  cp -r "$LAMBDA_DIR/node_modules" "$pkg/node_modules"
  cd "$pkg" && rm -f "$PKG_DIR/ci-agent-$agent.zip"
  zip -rq "$PKG_DIR/ci-agent-$agent.zip" .
  cd "$LAMBDA_DIR"
  echo "    Packaged ci-agent-$agent ($(du -sh "$PKG_DIR/ci-agent-$agent.zip" | cut -f1))"
done

if [[ "$DRY_RUN" == "true" ]]; then
  echo "==> Dry run complete. Zips in $PKG_DIR/"
  exit 0
fi

echo "==> Deploying..."
ERRORS=0
for agent in "${SELECTED_AGENTS[@]}"; do
  echo -n "    ci-agent-$agent... "
  if aws lambda update-function-code \
    --function-name "ci-agent-$agent" \
    --zip-file "fileb://$PKG_DIR/ci-agent-$agent.zip" \
    --region "$AWS_REGION" --no-cli-pager > /dev/null 2>&1; then
    echo "OK"
  else
    echo "FAILED"; ERRORS=$((ERRORS + 1))
  fi
done

echo "==> Verifying handler config..."
for agent in "${SELECTED_AGENTS[@]}"; do
  H=$(aws lambda get-function-configuration --function-name "ci-agent-$agent" \
    --region "$AWS_REGION" --query Handler --output text --no-cli-pager)
  if [[ "$H" != "handler.handler" ]]; then
    aws lambda update-function-configuration --function-name "ci-agent-$agent" \
      --handler handler.handler --region "$AWS_REGION" --no-cli-pager > /dev/null
    echo "    Fixed handler for ci-agent-$agent"
  fi
done

echo "==> Smoke test..."
sleep 3
echo '{"pr_number":0,"repo":"smoke-test","files":[]}' > /tmp/smoke-payload.json
aws lambda invoke --function-name ci-agent-linting --region "$AWS_REGION" \
  --payload fileb:///tmp/smoke-payload.json --no-cli-pager \
  /tmp/smoke-response.json > /tmp/smoke-meta.json 2>&1
if jq -e '.FunctionError' /tmp/smoke-meta.json > /dev/null 2>&1; then
  echo "    FAIL"; cat /tmp/smoke-response.json; ERRORS=$((ERRORS + 1))
else
  echo "    PASS"
fi

echo ""
[[ $ERRORS -eq 0 ]] && echo "==> Done. ${#SELECTED_AGENTS[@]} agent(s) deployed." || { echo "==> $ERRORS error(s)."; exit 1; }
