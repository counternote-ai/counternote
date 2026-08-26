#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo 'usage: verify-release-artifact.sh <CounterNote.app> <CounterNote.dmg>' >&2
  exit 64
fi

APP_PATH="$1"
DMG_PATH="$2"
EXPECTED_VERSION='0.1.0-beta.1'
EXPECTED_MINIMUM_SYSTEM_VERSION='13.0'

for tool in file hdiutil plutil shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' is not installed" >&2
    exit 1
  fi
done

if [[ ! -d "$APP_PATH" ]]; then
  echo "ERROR: app bundle not found at $APP_PATH" >&2
  exit 1
fi
if [[ ! -f "$DMG_PATH" ]]; then
  echo "ERROR: DMG not found at $DMG_PATH" >&2
  exit 1
fi

INFO_PLIST="$APP_PATH/Contents/Info.plist"
APP_EXECUTABLE="$APP_PATH/Contents/MacOS/CounterNote"
RESOURCES="$APP_PATH/Contents/Resources"
ASAR_PATH="$RESOURCES/app.asar"

APP_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$INFO_PLIST")"
MINIMUM_SYSTEM_VERSION="$(plutil -extract LSMinimumSystemVersion raw -o - "$INFO_PLIST")"
if [[ "$APP_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "ERROR: expected app version $EXPECTED_VERSION, found $APP_VERSION" >&2
  exit 1
fi
if [[ "$MINIMUM_SYSTEM_VERSION" != "$EXPECTED_MINIMUM_SYSTEM_VERSION" ]]; then
  echo "ERROR: expected macOS minimum $EXPECTED_MINIMUM_SYSTEM_VERSION, found $MINIMUM_SYSTEM_VERSION" >&2
  exit 1
fi

if ! file "$APP_EXECUTABLE" | grep -q 'Mach-O 64-bit executable arm64'; then
  echo 'ERROR: CounterNote executable is not arm64-only' >&2
  file "$APP_EXECUTABLE" >&2
  exit 1
fi

for required_file in \
  "$RESOURCES/LICENSE.txt" \
  "$RESOURCES/THIRD_PARTY_NOTICES.md" \
  "$RESOURCES/LICENSE.electron.txt" \
  "$RESOURCES/LICENSES.chromium.html" \
  "$RESOURCES/whisper/bin/whisper-cli" \
  "$RESOURCES/audio-capture/bin/counternote-audio-capture"; do
  if [[ ! -f "$required_file" ]]; then
    echo "ERROR: required packaged file missing: $required_file" >&2
    exit 1
  fi
done

if [[ -e "$RESOURCES/app-update.yml" ]]; then
  echo 'ERROR: app-update.yml is present even though auto-update is out of scope' >&2
  exit 1
fi

ASAR_LIST="$(node_modules/.bin/asar list "$ASAR_PATH")"
if grep -Eq '(^/node_modules/|__tests__|\.d\.[cm]?ts(?:\.map)?$|\.map$)' <<<"$ASAR_LIST"; then
  echo 'ERROR: development-only file found in app.asar' >&2
  grep -E '(^/node_modules/|__tests__|\.d\.[cm]?ts(?:\.map)?$|\.map$)' <<<"$ASAR_LIST" >&2
  exit 1
fi

if grep -Eqi '(Groq integration|api\.groq\.com|ffmpeg-static)' \
  "$RESOURCES/THIRD_PARTY_NOTICES.md"; then
  echo 'ERROR: Groq integration or FFmpeg reference found in packaged notices' >&2
  exit 1
fi

hdiutil imageinfo "$DMG_PATH" >/dev/null

echo "OK: app version $APP_VERSION"
echo "OK: minimum macOS $MINIMUM_SYSTEM_VERSION"
echo 'OK: architecture arm64'
echo "OK: packaged licenses and runtime files present"
echo "SHA-256: $(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
