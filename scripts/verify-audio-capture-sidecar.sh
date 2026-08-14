#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'ERROR: this script must run on macOS' >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo 'ERROR: this script must run on an Apple Silicon host' >&2
  exit 1
fi

if [[ $# -ne 1 ]]; then
  echo 'USAGE: verify-audio-capture-sidecar.sh <absolute-or-relative-helper-path>' >&2
  exit 1
fi

HELPER_PATH="$1"

if [[ ! -e "$HELPER_PATH" ]]; then
  echo "ERROR: '${HELPER_PATH}' does not exist" >&2
  exit 1
fi

if [[ ! -f "$HELPER_PATH" ]]; then
  echo "ERROR: '${HELPER_PATH}' is not a regular file" >&2
  exit 1
fi

if [[ ! -x "$HELPER_PATH" ]]; then
  echo "ERROR: '${HELPER_PATH}' is not executable" >&2
  exit 1
fi

for tool in file otool; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' is not installed" >&2
    exit 1
  fi
done

FILE_INFO="$(file "$HELPER_PATH")"

if [[ "$FILE_INFO" != *'Mach-O'* ]]; then
  echo "ERROR: '${HELPER_PATH}' is not a Mach-O binary" >&2
  exit 1
fi

if [[ "$FILE_INFO" != *'arm64'* ]]; then
  echo "ERROR: '${HELPER_PATH}' is not an arm64 binary" >&2
  exit 1
fi

# Check minimum macOS 13 load command
if otool -l "$HELPER_PATH" | grep -A5 'LC_BUILD_VERSION' | grep -q 'minos.*1[3-9]\.'; then
  : # minos 13+ found
elif otool -l "$HELPER_PATH" | grep -A5 'LC_BUILD_VERSION' | grep -q 'minos.*[2-9][0-9]\.'; then
  : # minos 20+ found
else
  echo "ERROR: '${HELPER_PATH}' does not have a minimum macOS 13 load command" >&2
  exit 1
fi

LINKS="$(otool -L "$HELPER_PATH")"

if [[ "$LINKS" == *'libAudioCaptureCore'* ]]; then
  echo "ERROR: '${HELPER_PATH}' links dynamically against AudioCaptureCore" >&2
  exit 1
fi

# Verify absence of test-fixture argument strings
STRINGS_OUTPUT="$(strings "$HELPER_PATH" 2>/dev/null || true)"
if echo "$STRINGS_OUTPUT" | grep -q '\-\-test-fixture'; then
  echo "ERROR: '${HELPER_PATH}' contains test-fixture argument strings" >&2
  exit 1
fi
if echo "$STRINGS_OUTPUT" | grep -q 'CAPTURE_TEST_SEAMS'; then
  echo "ERROR: '${HELPER_PATH}' contains CAPTURE_TEST_SEAMS" >&2
  exit 1
fi

echo "OK: '${HELPER_PATH}' is a static Mach-O arm64 audio capture helper binary"
