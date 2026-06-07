#!/usr/bin/env bash
set -euo pipefail

DOCKER_USER="zackdk"
IMAGE_NAME="z-ai"

# 从 package.json 读取版本号
VERSION=$(node -p "require('./package.json').version")

# Tag 策略：
#   latest         — 最新稳定版
#   <version>      — 精确语义化版本，如 0.6.12
#   testing        — 手动构建的测试版本（传 BUILD_TYPE=testing）
#   edge-<sha>     — 开发中最新构建（传 BUILD_TYPE=edge）
BUILD_TYPE="${BUILD_TYPE:-stable}"

if [ "$BUILD_TYPE" = "testing" ]; then
  TAG="${DOCKER_USER}/${IMAGE_NAME}:testing"
  EXTRA_TAG="${DOCKER_USER}/${IMAGE_NAME}:${VERSION}-testing"
elif [ "$BUILD_TYPE" = "edge" ]; then
  SHORT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  TAG="${DOCKER_USER}/${IMAGE_NAME}:edge-${SHORT_SHA}"
  EXTRA_TAG="${DOCKER_USER}/${IMAGE_NAME}:${VERSION}-edge"
else
  TAG="${DOCKER_USER}/${IMAGE_NAME}:latest"
  EXTRA_TAG="${DOCKER_USER}/${IMAGE_NAME}:${VERSION}"
fi

echo "=== Building ${IMAGE_NAME} for linux/amd64 ==="
echo "  version: ${VERSION}"
echo "  tags:    ${TAG} , ${EXTRA_TAG}"
echo ""
docker buildx build \
  --platform linux/amd64 \
  -t "${TAG}" \
  -t "${EXTRA_TAG}" \
  --load \
  .

echo ""
echo "=== Pushing to Docker Hub ==="
docker push "${TAG}"
docker push "${EXTRA_TAG}" || true

echo ""
echo "Done! Images pushed:"
echo "  ${TAG}"
echo "  ${EXTRA_TAG}"
echo ""
echo "On NAS, run:"
echo "  docker pull ${TAG}"
echo "  docker run -d --name z-ai -p 30141:30141 \\"
echo "    -e GITHUB_CLIENT_ID=your_client_id \\"
echo "    -e GITHUB_CLIENT_SECRET=your_client_secret \\"
echo "    ${TAG}"
echo ""
echo "Or use docker-compose (recommended):"
echo "  Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET in .env file, then:"
echo "  docker compose up -d"
