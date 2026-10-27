#!/bin/sh
# cargo run 실행기 (apps/desktop/src-tauri/.cargo/config.toml). 개발 앱(thuminal-desktop)을 target 의
# thuminal-dev.app 번들 안에서 실행한다. macOS 알림 API(UNUserNotificationCenter)는 번들 안에서 도는 프로세스만
# 쓸 수 있고, 알림 이름 · 아이콘도 번들에서 온다. 다른 실행 파일(시험 등)은 그대로 실행한다.
set -eu
bin="$1"
shift
[ "$(basename "$bin")" = thuminal-desktop ] || exec "$bin" "$@"

dir="$(cd "$(dirname "$bin")" && pwd)"
app="$dir/thuminal-dev.app"
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
# cargo 가 다시 빌드하면 새 파일이 생기므로 실행할 때마다 다시 잇는다
ln -f "$dir/thuminal-desktop" "$app/Contents/MacOS/thuminal-desktop"
cp "$root/apps/desktop/src-tauri/icons/icon.icns" "$app/Contents/Resources/icon.icns"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.thuminal.app.dev</string>
  <key>CFBundleName</key><string>thuminal dev</string>
  <key>CFBundleDisplayName</key><string>thuminal dev</string>
  <key>CFBundleExecutable</key><string>thuminal-desktop</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.0</string>
  <key>CFBundleVersion</key><string>0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
# 서명이 없거나 링커가 붙인 실행 파일 서명뿐이면(번들 id · Info.plist 가 묶이지 않는다) macOS 가 알림 허락 요청을
# 바로 거절한다 (UNErrorDomain 1). 번들째 임시 서명해 묶는다
codesign --force --sign - "$app" 2>/dev/null || echo "dev-app-runner: 번들 서명에 실패했다. 알림은 osascript 로 간다" >&2
# 데몬은 번들 안이 아니라 tauri dev 가 사이드카를 놓은 자리(target/debug/thuminald)에서 띄운다
export THUMINAL_DAEMON_BIN="${THUMINAL_DAEMON_BIN:-$dir/thuminald}"
exec "$app/Contents/MacOS/thuminal-desktop" "$@"
