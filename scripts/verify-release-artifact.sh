#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo 'usage: verify-release-artifact.sh <CounterNote.app> <CounterNote.dmg>' >&2
  exit 64
fi

APP_PATH="$1"
DMG_PATH="$2"
EXPECTED_VERSION="$(node -p "require('./package.json').version")"
EXPECTED_MINIMUM_SYSTEM_VERSION='13.0'
EXPECTED_DMG_NAME="CounterNote-${EXPECTED_VERSION}-arm64.dmg"

for tool in cmp codesign file hdiutil lipo plutil shasum stat; do
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

if [[ "$(basename "$DMG_PATH")" != "$EXPECTED_DMG_NAME" ]]; then
  echo "ERROR: expected DMG name $EXPECTED_DMG_NAME, found $(basename "$DMG_PATH")" >&2
  exit 1
fi

validate_adhoc_signature() {
  local code_path="$1"
  local label="$2"
  local sign_info

  if ! codesign --verify --strict --verbose=2 "$code_path" 2>&1; then
    echo "ERROR: $label has an invalid code signature" >&2
    return 1
  fi

  sign_info="$(codesign -dvvv "$code_path" 2>&1)"
  if ! grep -q '^Signature=adhoc$' <<<"$sign_info"; then
    echo "ERROR: $label is not ad-hoc signed" >&2
    return 1
  fi
  if ! grep -Eq '^CodeDirectory .*flags=.*runtime' <<<"$sign_info"; then
    echo "ERROR: $label is missing the hardened runtime flag" >&2
    return 1
  fi
}

require_true_entitlement() {
  local code_path="$1"
  local label="$2"
  local entitlement="$3"
  local entitlement_path="${entitlement//./\\.}"
  local entitlement_output
  local entitlement_xml
  local entitlement_value

  entitlement_output="$(codesign -d --entitlements :- "$code_path" 2>&1)"
  if [[ "$entitlement_output" != *'<?xml'* ]]; then
    echo "ERROR: could not read $label entitlements as a property list" >&2
    return 1
  fi
  entitlement_xml="<?xml${entitlement_output#*<?xml}"
  if ! entitlement_value="$(
    printf '%s' "$entitlement_xml" |
      plutil -extract "$entitlement_path" raw -o - - 2>/dev/null
  )"; then
    echo "ERROR: $label is missing entitlement $entitlement" >&2
    return 1
  fi
  if [[ "$entitlement_value" != true ]]; then
    echo "ERROR: $label entitlement $entitlement is not enabled" >&2
    return 1
  fi
}

validate_arm64_executable() {
  local executable_path="$1"
  local label="$2"
  local mode
  local architectures

  if [[ ! -f "$executable_path" || -L "$executable_path" || ! -x "$executable_path" ]]; then
    echo "ERROR: $label is not a regular executable file: $executable_path" >&2
    return 1
  fi
  mode="$(stat -f '%Lp' "$executable_path")"
  if [[ "$mode" != 755 ]]; then
    echo "ERROR: $label must have mode 755, found $mode" >&2
    return 1
  fi
  architectures="$(lipo -archs "$executable_path")"
  if [[ "$architectures" != arm64 ]]; then
    echo "ERROR: $label must be arm64-only, found: $architectures" >&2
    return 1
  fi
}

validate_app() {
  local app_path="$1"
  local label="$2"
  local info_plist="$app_path/Contents/Info.plist"
  local app_executable="$app_path/Contents/MacOS/CounterNote"
  local resources="$app_path/Contents/Resources"
  local asar_path="$resources/app.asar"
  local code_resources="$app_path/Contents/_CodeSignature/CodeResources"
  local capture_path="$resources/audio-capture/bin/counternote-audio-capture"
  local whisper_path="$resources/whisper/bin/whisper-cli"
  local app_version
  local minimum_system_version
  local asar_list

  if [[ ! -d "$app_path" ]]; then
    echo "ERROR: $label app bundle not found at $app_path" >&2
    return 1
  fi

  app_version="$(plutil -extract CFBundleShortVersionString raw -o - "$info_plist")"
  minimum_system_version="$(plutil -extract LSMinimumSystemVersion raw -o - "$info_plist")"
  if [[ "$app_version" != "$EXPECTED_VERSION" ]]; then
    echo "ERROR: expected $label app version $EXPECTED_VERSION, found $app_version" >&2
    return 1
  fi
  if [[ "$minimum_system_version" != "$EXPECTED_MINIMUM_SYSTEM_VERSION" ]]; then
    echo "ERROR: expected $label macOS minimum $EXPECTED_MINIMUM_SYSTEM_VERSION, found $minimum_system_version" >&2
    return 1
  fi

  if [[ ! -f "$code_resources" ]]; then
    echo "ERROR: $label app is missing _CodeSignature/CodeResources" >&2
    return 1
  fi
  if ! codesign --verify --deep --strict --verbose=2 "$app_path" 2>&1; then
    echo "ERROR: $label app bundle has an invalid structural signature" >&2
    return 1
  fi
  validate_adhoc_signature "$app_path" "$label app"

  for entitlement in \
    com.apple.security.cs.allow-jit \
    com.apple.security.cs.allow-unsigned-executable-memory \
    com.apple.security.cs.disable-library-validation \
    com.apple.security.device.audio-input \
    com.apple.security.device.screen-capture; do
    require_true_entitlement "$app_path" "$label app" "$entitlement"
  done

  validate_arm64_executable "$app_executable" "$label CounterNote executable"

  for required_file in \
    "$resources/LICENSE.txt" \
    "$resources/THIRD_PARTY_NOTICES.md" \
    "$resources/LICENSE.electron.txt" \
    "$resources/LICENSES.chromium.html" \
    "$whisper_path" \
    "$capture_path"; do
    if [[ ! -f "$required_file" ]]; then
      echo "ERROR: required $label packaged file missing: $required_file" >&2
      return 1
    fi
  done

  for sidecar_path in "$capture_path" "$whisper_path"; do
    validate_arm64_executable "$sidecar_path" "$label $(basename "$sidecar_path") sidecar"
    validate_adhoc_signature "$sidecar_path" "$label $(basename "$sidecar_path") sidecar"
  done

  require_true_entitlement \
    "$capture_path" \
    "$label audio capture sidecar" \
    com.apple.security.device.audio-input

  for nested_code in \
    "$app_path/Contents/Frameworks/CounterNote Helper.app" \
    "$app_path/Contents/Frameworks/CounterNote Helper (Renderer).app" \
    "$app_path/Contents/Frameworks/CounterNote Helper (GPU).app" \
    "$app_path/Contents/Frameworks/CounterNote Helper (Plugin).app" \
    "$app_path/Contents/Frameworks/Electron Framework.framework" \
    "$app_path/Contents/Frameworks/Squirrel.framework" \
    "$app_path/Contents/Frameworks/Mantle.framework" \
    "$app_path/Contents/Frameworks/ReactiveObjC.framework" \
    "$app_path/Contents/Frameworks/Electron Framework.framework/Versions/Current/Helpers/chrome_crashpad_handler"; do
    validate_adhoc_signature "$nested_code" "$label nested code $(basename "$nested_code")"
  done

  if [[ -e "$resources/app-update.yml" ]]; then
    echo "ERROR: $label app-update.yml is present even though auto-update is out of scope" >&2
    return 1
  fi

  asar_list="$(node_modules/.bin/asar list "$asar_path")"
  if grep -Eq '(^/node_modules/|__tests__|\.d\.[cm]?ts(?:\.map)?$|\.map$)' <<<"$asar_list"; then
    echo "ERROR: development-only file found in $label app.asar" >&2
    grep -E '(^/node_modules/|__tests__|\.d\.[cm]?ts(?:\.map)?$|\.map$)' <<<"$asar_list" >&2
    return 1
  fi

  if grep -Eqi '(Groq integration|api\.groq\.com|ffmpeg-static)' \
    "$resources/THIRD_PARTY_NOTICES.md"; then
    echo "ERROR: Groq integration or FFmpeg reference found in $label packaged notices" >&2
    return 1
  fi
}

validate_app "$APP_PATH" 'unpacked'

hdiutil verify "$DMG_PATH" >/dev/null
MOUNT_POINT="$(mktemp -d "${TMPDIR:-/tmp}/counternote-release.XXXXXX")"
MOUNTED=false
cleanup() {
  if [[ "$MOUNTED" == true ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet || true
  fi
  rmdir "$MOUNT_POINT" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach "$DMG_PATH" -readonly -nobrowse -noautoopen -mountpoint "$MOUNT_POINT" >/dev/null
MOUNTED=true
MOUNTED_APP_PATH="$MOUNT_POINT/CounterNote.app"
validate_app "$MOUNTED_APP_PATH" 'DMG'

for relative_path in \
  Contents/Info.plist \
  Contents/MacOS/CounterNote \
  Contents/_CodeSignature/CodeResources \
  Contents/Resources/app.asar \
  Contents/Resources/whisper/bin/whisper-cli \
  Contents/Resources/audio-capture/bin/counternote-audio-capture; do
  if ! cmp -s "$APP_PATH/$relative_path" "$MOUNTED_APP_PATH/$relative_path"; then
    echo "ERROR: DMG app does not match unpacked app at $relative_path" >&2
    exit 1
  fi
done

echo "OK: app version $EXPECTED_VERSION"
echo "OK: minimum macOS $EXPECTED_MINIMUM_SYSTEM_VERSION"
echo 'OK: architecture arm64'
echo 'OK: ad-hoc signatures, hardened runtime, and entitlements'
echo 'OK: packaged licenses and runtime files present'
echo 'OK: DMG app matches unpacked app'
echo "SHA-256: $(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
