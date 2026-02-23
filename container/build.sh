#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

# Download GitHub CLI binary for linux/arm64 if not already present.
# Apple Container builds have no network access, so we pre-download
# the binary on the host and COPY it in via the Dockerfile.
GH_VERSION="2.67.0"
GH_BIN="gh"
if [ ! -f "$GH_BIN" ]; then
  echo "Downloading GitHub CLI v${GH_VERSION} for linux/arm64..."
  GH_TAR="gh_${GH_VERSION}_linux_arm64.tar.gz"
  curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_TAR}" -o "/tmp/${GH_TAR}"
  tar -xzf "/tmp/${GH_TAR}" -C /tmp
  cp "/tmp/gh_${GH_VERSION}_linux_arm64/bin/gh" "$GH_BIN"
  rm -rf "/tmp/${GH_TAR}" "/tmp/gh_${GH_VERSION}_linux_arm64"
  echo "GitHub CLI downloaded."
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
