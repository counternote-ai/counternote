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
  echo 'USAGE: verify-whisper-sidecar.sh <absolute-or-relative-cli-path>' >&2
  exit 1
fi

CLI_PATH="$1"

if [[ ! -e "$CLI_PATH" ]]; then
  echo "ERROR: '${CLI_PATH}' does not exist" >&2
  exit 1
fi

if [[ ! -x "$CLI_PATH" ]]; then
  echo "ERROR: '${CLI_PATH}' is not executable" >&2
  exit 1
fi

for tool in file nm otool; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' is not installed" >&2
    exit 1
  fi
done

FILE_INFO="$(file "$CLI_PATH")"

if [[ "$FILE_INFO" != *'Mach-O'* ]]; then
  echo "ERROR: '${CLI_PATH}' is not a Mach-O binary" >&2
  exit 1
fi

if [[ "$FILE_INFO" != *'arm64'* ]]; then
  echo "ERROR: '${CLI_PATH}' is not an arm64 binary" >&2
  exit 1
fi

MINIMUM_SYSTEM_VERSION="$(otool -l "$CLI_PATH" | awk '
  /LC_BUILD_VERSION/ { in_build_version = 1; next }
  in_build_version && $1 == "minos" { print $2; exit }
')"

if [[ "$MINIMUM_SYSTEM_VERSION" != '13.0' ]]; then
  echo "ERROR: '${CLI_PATH}' targets macOS ${MINIMUM_SYSTEM_VERSION:-unknown}; expected 13.0" >&2
  exit 1
fi

"$CLI_PATH" --help >/dev/null

LINKS="$(otool -L "$CLI_PATH")"

if [[ "$LINKS" == *'libwhisper'* ]]; then
  echo "ERROR: '${CLI_PATH}' links dynamically against libwhisper" >&2
  exit 1
fi

if [[ "$LINKS" == *'libggml'* ]]; then
  echo "ERROR: '${CLI_PATH}' links dynamically against libggml" >&2
  exit 1
fi

if nm -u "$CLI_PATH" | grep -q 'cblas_'; then
  echo "ERROR: '${CLI_PATH}' imports BLAS symbols unavailable on macOS 13.0" >&2
  exit 1
fi

echo "OK: '${CLI_PATH}' is a static Mach-O arm64 whisper-cli binary"
