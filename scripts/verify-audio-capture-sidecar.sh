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

MINIMUM_SYSTEM_VERSION="$(otool -l "$HELPER_PATH" | awk '
  /LC_BUILD_VERSION/ { in_build_version = 1; next }
  in_build_version && $1 == "minos" { print $2; exit }
')"

if [[ "$MINIMUM_SYSTEM_VERSION" != '13.0' ]]; then
  echo "ERROR: '${HELPER_PATH}' targets macOS ${MINIMUM_SYSTEM_VERSION:-unknown}; expected 13.0" >&2
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
