#!/bin/sh
# 데스크톱 앱 설치본을 만든다. 데몬과 CLI 가 앱 실행 파일 옆에, 원격 접속 웹 화면과 claude 플러그인이 앱 리소스에 들어간다.
# macOS: target/release/bundle/macos/thuminal.app
# Linux: target/release/bundle/{deb,appimage}/ (apt 의 libwebkit2gtk-4.1-dev · libgtk-3-dev · librsvg2-dev 가 있어야 빌드된다)
set -eu
cd "$(dirname "$0")/.."
# mise 가 있으면 mise 로(Zig 버전을 맞춘다), 없으면(CI · 컨테이너) PATH 의 도구로
if command -v mise >/dev/null 2>&1; then RUN="mise exec --"; else RUN=; fi
scripts/prepare-sidecars.sh release
pnpm install --frozen-lockfile
# 원격 접속 웹 화면 (번들 Resources/web). Android SDK 가 있으면 안드로이드 앱도 같이 넣는다 (/download/thuminal.apk)
if [ -d "${ANDROID_HOME:-$HOME/Library/Android/sdk}" ]; then scripts/build-android.sh; else echo "Android SDK 가 없어 안드로이드 앱은 빼고 만든다"; fi
pnpm -C apps/web build
# 업데이트 파일(.app.tar.gz · AppImage · NSIS 의 .sig)은 서명 키로 서명한다. 키가 ~/.tauri 에 있으면 쓰고(암호는 macOS 키체인),
# 없으면 업데이트 파일 없이 만든다
if [ -z "${TAURI_SIGNING_PRIVATE_KEY-}" ] && [ -f "$HOME/.tauri/thuminal.key" ]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.tauri/thuminal.key")"
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -a thuminal -s thuminal-updater-key -w 2>/dev/null || true)"
  export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi
if [ -z "${TAURI_SIGNING_PRIVATE_KEY-}" ]; then
  echo "업데이트 서명 키가 없어 업데이트 파일은 빼고 만든다"
  set -- --config '{"bundle":{"createUpdaterArtifacts":false}}'
else
  set --
fi
case "$(uname -s)" in
  Darwin)
    (cd apps/desktop && $RUN pnpm tauri build --bundles app "$@")
    echo "만듦: target/release/bundle/macos/thuminal.app" ;;
  Linux)
    # 설치본 종류는 tauri.linux.conf.json 의 bundle.targets 를 따른다
    (cd apps/desktop && $RUN pnpm tauri build "$@")
    echo "만듦: target/release/bundle/deb, target/release/bundle/appimage" ;;
  *)
    echo "이 OS 는 아직 빌드 스크립트가 없다: $(uname -s)" >&2
    exit 1 ;;
esac
