#!/bin/sh
# thuminal.app 을 만든다. 데몬과 CLI 가 번들 안(Contents/MacOS)에, 원격 접속 웹 화면이 Contents/Resources/web 에 들어간다.
set -eu
cd "$(dirname "$0")/.."
scripts/prepare-sidecars.sh release
pnpm install --frozen-lockfile
# 원격 접속 웹 화면 (번들 Resources/web). Android SDK 가 있으면 안드로이드 앱도 같이 넣는다 (/download/thuminal.apk)
if [ -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}" ]; then scripts/build-android.sh; else echo "Android SDK 가 없어 안드로이드 앱은 빼고 만든다"; fi
pnpm -C apps/web build
(cd apps/desktop && mise exec -- pnpm tauri build --bundles app)
echo "만듦: target/release/bundle/macos/thuminal.app"
