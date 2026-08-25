#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SWIFT_PACKAGE_DIR="${REPO_ROOT}/native/audio-capture"
OUTPUT_DIR="${REPO_ROOT}/build/audio-capture/darwin-arm64"
OUTPUT_PATH="${OUTPUT_DIR}/counternote-audio-capture"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'ERROR: this script must run on macOS' >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo 'ERROR: this script must run on an Apple Silicon host' >&2
  exit 1
fi

for tool in swift file otool; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' is not installed" >&2
    exit 1
  fi
done

if [[ ! -d "$SWIFT_PACKAGE_DIR" ]]; then
  echo "ERROR: Swift package not found at '${SWIFT_PACKAGE_DIR}'" >&2
  exit 1
fi

cd "$SWIFT_PACKAGE_DIR"

swift build --configuration release --product CounterNoteAudioCapture 2>&1

BUILT_BINARY="${SWIFT_PACKAGE_DIR}/.build/arm64-apple-macosx/release/CounterNoteAudioCapture"

if [[ ! -f "$BUILT_BINARY" ]]; then
  echo "ERROR: expected build output not found at '${BUILT_BINARY}'" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
ATTEMPT_PATH="${OUTPUT_PATH}.tmp.$$"
cp "$BUILT_BINARY" "$ATTEMPT_PATH"
chmod 755 "$ATTEMPT_PATH"
mv "$ATTEMPT_PATH" "$OUTPUT_PATH"

"${REPO_ROOT}/scripts/verify-audio-capture-sidecar.sh" "$OUTPUT_PATH"

echo "OK: audio capture helper built and verified at '${OUTPUT_PATH}'"
