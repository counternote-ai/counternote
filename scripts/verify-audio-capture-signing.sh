#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'ERROR: this script must run on macOS' >&2
  exit 1
fi

if [[ $# -ne 2 ]]; then
  echo 'USAGE: verify-audio-capture-signing.sh <app-path> <unsigned-local|signed-release>' >&2
  exit 1
fi

APP_PATH="$1"
MODE="$2"

if [[ "$MODE" != "unsigned-local" && "$MODE" != "signed-release" ]]; then
  echo "ERROR: mode must be 'unsigned-local' or 'signed-release'" >&2
  exit 1
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "ERROR: '${APP_PATH}' is not a directory" >&2
  exit 1
fi

HELPER_EMBEDDED_PATH="${APP_PATH}/Contents/Resources/audio-capture/bin/counternote-audio-capture"

if [[ ! -f "$HELPER_EMBEDDED_PATH" ]]; then
  echo "ERROR: helper not found at expected embedded path: '${HELPER_EMBEDDED_PATH}'" >&2
  exit 1
fi

if [[ ! -x "$HELPER_EMBEDDED_PATH" ]]; then
  echo "ERROR: helper at '${HELPER_EMBEDDED_PATH}' is not executable" >&2
  exit 1
fi

# Verify arm64 architecture
FILE_INFO="$(file "$HELPER_EMBEDDED_PATH")"
if [[ "$FILE_INFO" != *'Mach-O'* ]]; then
  echo "ERROR: helper is not a Mach-O binary" >&2
  exit 1
fi
if [[ "$FILE_INFO" != *'arm64'* ]]; then
  echo "ERROR: helper is not an arm64 binary" >&2
  exit 1
fi

# Verify helper hash
HELPER_HASH="$(shasum -a 256 "$HELPER_EMBEDDED_PATH" | cut -d' ' -f1)"
echo "INFO: helper SHA-256: ${HELPER_HASH}"

if [[ "$MODE" == "unsigned-local" ]]; then
  echo "INFO: unsigned-local mode"
  echo "WARNING: signing is unverified"
  echo "WARNING: notarization is unverified"
  echo "WARNING: TCC attribution is unverified"
  echo "WARNING: permission ownership is unverified"
  echo "OK: unsigned-local verification passed for '${APP_PATH}'"
  exit 0
fi

# signed-release mode
for tool in codesign spctl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' is not installed" >&2
    exit 1
  fi
done

# Verify parent app signature
if ! codesign --verify --deep --strict "$APP_PATH" 2>&1; then
  echo "ERROR: parent app codesign verification failed" >&2
  exit 1
fi

# Verify helper signature
if ! codesign --verify --deep --strict "$HELPER_EMBEDDED_PATH" 2>&1; then
  echo "ERROR: helper codesign verification failed" >&2
  exit 1
fi

# Check parent app has Authority
PARENT_SIGN_INFO="$(codesign -dvv "$APP_PATH" 2>&1)"
if [[ "$PARENT_SIGN_INFO" != *'Authority='* ]]; then
  echo "ERROR: parent app has no Authority in signature" >&2
  exit 1
fi

# Check parent app has hardened runtime
if ! codesign -dvv "$APP_PATH" 2>&1 | grep -q 'runtime'; then
  echo "ERROR: parent app does not have hardened runtime" >&2
  exit 1
fi

# Check helper has Authority
HELPER_SIGN_INFO="$(codesign -dvv "$HELPER_EMBEDDED_PATH" 2>&1)"
if [[ "$HELPER_SIGN_INFO" != *'Authority='* ]]; then
  echo "ERROR: helper has no Authority in signature" >&2
  exit 1
fi

# Check helper has hardened runtime
if ! codesign -dvv "$HELPER_EMBEDDED_PATH" 2>&1 | grep -q 'runtime'; then
  echo "ERROR: helper does not have hardened runtime" >&2
  exit 1
fi

# Extract and verify parent entitlements
PARENT_ENTITLEMENTS="$(codesign -d --entitlements - "$APP_PATH" 2>&1)"
if [[ "$PARENT_ENTITLEMENTS" != *'com.apple.security.device.audio-input'* ]]; then
  echo "ERROR: parent app entitlements missing com.apple.security.device.audio-input" >&2
  exit 1
fi

# Extract and verify helper entitlements
HELPER_ENTITLEMENTS="$(codesign -d --entitlements - "$HELPER_EMBEDDED_PATH" 2>&1)"
if [[ "$HELPER_ENTITLEMENTS" != *'com.apple.security.device.audio-input'* ]]; then
  echo "ERROR: helper entitlements missing com.apple.security.device.audio-input" >&2
  exit 1
fi

# Run spctl assessment
if ! spctl --assess --type execute "$APP_PATH" 2>&1; then
  echo "ERROR: spctl assessment failed for parent app" >&2
  exit 1
fi

echo "OK: signed-release verification passed for '${APP_PATH}'"
