#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'ERROR: this script must run on macOS' >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo 'ERROR: this script must run on an Apple Silicon host' >&2
  exit 1
fi

for tool in curl tar cmake file otool; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' is not installed" >&2
    exit 1
  fi
done

WHISPER_COMMIT='f049fff95a089aa9969deb009cdd4892b3e74916'
ARCHIVE_URL="https://github.com/ggml-org/whisper.cpp/archive/${WHISPER_COMMIT}.tar.gz"
OUTPUT_PATH="${REPO_ROOT}/build/whisper/darwin-arm64/whisper-cli"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

SOURCE_DIR="${WORK_DIR}/whisper.cpp-${WHISPER_COMMIT}"
BUILD_DIR="${WORK_DIR}/build"

curl --fail --location --retry 3 --output "${WORK_DIR}/whisper.tar.gz" "$ARCHIVE_URL"
tar -xzf "${WORK_DIR}/whisper.tar.gz" -C "$WORK_DIR"

cmake -S "$SOURCE_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF

cmake --build "$BUILD_DIR" --config Release --target whisper-cli --parallel

mkdir -p "$(dirname "$OUTPUT_PATH")"
ATTEMPT_PATH="${OUTPUT_PATH}.tmp.$$"
cp "${BUILD_DIR}/bin/whisper-cli" "$ATTEMPT_PATH"
chmod 755 "$ATTEMPT_PATH"
mv "$ATTEMPT_PATH" "$OUTPUT_PATH"

"${REPO_ROOT}/scripts/verify-whisper-sidecar.sh" "$OUTPUT_PATH"
