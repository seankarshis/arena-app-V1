#!/usr/bin/env bash
#
# deploy.sh — Build Docker images, push to ECR, and update Fargate services.
#
# Usage:
#   ./scripts/deploy.sh              # Build & push both images, then CDK deploy
#   ./scripts/deploy.sh --api-only   # Build & push API image only
#   ./scripts/deploy.sh --fe-only    # Build & push frontend image only
#   ./scripts/deploy.sh --skip-cdk   # Build & push images without CDK deploy
#
# Prerequisites:
#   - AWS CLI configured with appropriate credentials
#   - Docker running
#   - AWS CDK CLI installed (for CDK deploy step)
#
# Environment variables (auto-detected from AWS if not set):
#   AWS_ACCOUNT_ID  — AWS account ID
#   AWS_REGION      — AWS region (default: us-east-1)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Configuration ──────────────────────────────────────────────────────────────
AWS_REGION="${AWS_REGION:-${CDK_DEFAULT_REGION:-us-east-1}}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")}"

if [[ -z "$AWS_ACCOUNT_ID" ]]; then
  echo "ERROR: Could not determine AWS account ID. Ensure AWS CLI is configured." >&2
  exit 1
fi

ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
API_REPO="arena-api"
FRONTEND_REPO="arena-frontend"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# ── Parse flags ────────────────────────────────────────────────────────────────
BUILD_API=true
BUILD_FRONTEND=true
RUN_CDK=true

for arg in "$@"; do
  case "$arg" in
    --api-only)    BUILD_FRONTEND=false ;;
    --fe-only)     BUILD_API=false ;;
    --skip-cdk)    RUN_CDK=false ;;
    --help|-h)
      head -16 "$0" | tail -14
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg" >&2
      exit 1
      ;;
  esac
done

# ── ECR Login ──────────────────────────────────────────────────────────────────
echo "==> Authenticating Docker to ECR ($ECR_REGISTRY)..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"

# ── Build & Push API ──────────────────────────────────────────────────────────
if [[ "$BUILD_API" == "true" ]]; then
  echo "==> Building API image..."
  docker build \
    --platform linux/amd64 \
    -t "${API_REPO}:${IMAGE_TAG}" \
    -f "$REPO_ROOT/api/Dockerfile" \
    "$REPO_ROOT/api"

  echo "==> Tagging API image for ECR..."
  docker tag "${API_REPO}:${IMAGE_TAG}" "${ECR_REGISTRY}/${API_REPO}:${IMAGE_TAG}"

  echo "==> Pushing API image to ECR..."
  docker push "${ECR_REGISTRY}/${API_REPO}:${IMAGE_TAG}"
  echo "    Pushed: ${ECR_REGISTRY}/${API_REPO}:${IMAGE_TAG}"
fi

# ── Build & Push Frontend ─────────────────────────────────────────────────────
if [[ "$BUILD_FRONTEND" == "true" ]]; then
  echo "==> Building Frontend image..."
  docker build \
    --platform linux/amd64 \
    -t "${FRONTEND_REPO}:${IMAGE_TAG}" \
    -f "$REPO_ROOT/frontend/Dockerfile" \
    "$REPO_ROOT/frontend"

  echo "==> Tagging Frontend image for ECR..."
  docker tag "${FRONTEND_REPO}:${IMAGE_TAG}" "${ECR_REGISTRY}/${FRONTEND_REPO}:${IMAGE_TAG}"

  echo "==> Pushing Frontend image to ECR..."
  docker push "${ECR_REGISTRY}/${FRONTEND_REPO}:${IMAGE_TAG}"
  echo "    Pushed: ${ECR_REGISTRY}/${FRONTEND_REPO}:${IMAGE_TAG}"
fi

# ── Force Fargate service redeployment ────────────────────────────────────────
# When the image tag stays "latest", ECS won't redeploy unless we force it.
echo "==> Forcing ECS service redeployment..."
aws ecs update-service \
  --cluster arena-cluster \
  --service "$(aws ecs list-services --cluster arena-cluster --query 'serviceArns[?contains(@, `ApiService`)]' --output text)" \
  --force-new-deployment \
  --region "$AWS_REGION" \
  --no-cli-pager > /dev/null 2>&1 || echo "    (API service force-deploy skipped — service may not exist yet)"

aws ecs update-service \
  --cluster arena-cluster \
  --service "$(aws ecs list-services --cluster arena-cluster --query 'serviceArns[?contains(@, `FrontendService`)]' --output text)" \
  --force-new-deployment \
  --region "$AWS_REGION" \
  --no-cli-pager > /dev/null 2>&1 || echo "    (Frontend service force-deploy skipped — service may not exist yet)"

# ── CDK Deploy ─────────────────────────────────────────────────────────────────
if [[ "$RUN_CDK" == "true" ]]; then
  echo "==> Deploying ComputeStack via CDK..."
  cd "$REPO_ROOT/infrastructure"
  npx cdk deploy ArenaComputeStack --require-approval never
fi

echo ""
echo "==> Deployment complete."
