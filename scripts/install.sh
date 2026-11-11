#!/bin/sh
# macOS 에 thuminal 을 설치하거나 새 버전으로 바꾼다.
#   curl -fsSL https://raw.githubusercontent.com/whquddn55/thuminal/main/scripts/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- 0.1.6     # 버전을 골라 설치
#
# 설치본은 Apple 공증을 받지 않았다. 브라우저로 받은 .dmg 에는 격리 표시(com.apple.quarantine)가 붙어
# Gatekeeper 가 "악성 코드가 없음을 확인할 수 없습니다" 를 띄우고 막는다. curl 로 받은 파일에는 이 표시가 붙지 않는다.
# 그 뒤 버전은 앱 안 업데이트로 받는다 (앱이 직접 받으므로 역시 표시가 붙지 않는다).
#
# 떠 있는 데몬은 옛 버전 그대로 남으므로, 물어보고 SIGTERM 으로 내린다. 세션은 화면 저장본으로 되살아나고
# claude 는 --resume 으로 이어진다 (앱 안 업데이트와 같다). 터미널 안에서 돌던 다른 프로그램은 끝난다.
set -eu

REPO="whquddn55/thuminal"
APP_DIR="${THUMINAL_APP_DIR:-/Applications}"
APP="$APP_DIR/thuminal.app"
VERSION="${1:-}"

say() { printf '%s\n' "$*"; }
die() { printf 'thuminal 설치: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "macOS 에서만 쓴다. 다른 OS 는 https://github.com/$REPO/releases 에서 받는다"
# Rosetta 로 돈 셸은 x86_64 로 보이므로 하드웨어를 직접 본다
[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ] || die "Apple Silicon(arm64) Mac 만 지원한다"

if [ -n "$VERSION" ]; then
  URL="https://github.com/$REPO/releases/download/v${VERSION#v}/thuminal_aarch64.app.tar.gz"
else
  URL="https://github.com/$REPO/releases/latest/download/thuminal_aarch64.app.tar.gz"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "받는 중: $URL"
curl -fL --progress-bar -o "$TMP/thuminal.app.tar.gz" "$URL" || die "받지 못했다: $URL"
tar -xzf "$TMP/thuminal.app.tar.gz" -C "$TMP"
[ -d "$TMP/thuminal.app" ] || die "받은 파일에 thuminal.app 이 없다"
NEW_VERSION="$(defaults read "$TMP/thuminal.app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?')"

# 앱이 떠 있으면 끈다
if pgrep -f "$APP/Contents/MacOS/thuminal-desktop" >/dev/null 2>&1; then
  say "thuminal 앱을 끈다"
  osascript -e 'tell application id "dev.thuminal.app" to quit' >/dev/null 2>&1 || true
  i=0
  while pgrep -f "$APP/Contents/MacOS/thuminal-desktop" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 20 ] || die "앱이 꺼지지 않는다. 앱을 끄고 다시 실행한다"
    sleep 0.5
  done
fi

# 옛 데몬을 내린다. curl | sh 는 표준 입력이 파이프라서 대답은 터미널(/dev/tty)에서 받는다
DAEMON_PIDS="$(pgrep -f "$APP/Contents/MacOS/thuminald --home" 2>/dev/null || true)"
if [ -n "$DAEMON_PIDS" ]; then
  OLD="$("$APP/Contents/MacOS/thuminal" daemon status --json 2>/dev/null | sed -n 's/.*"daemon_version": *"\([^"]*\)".*/\1/p' || true)"
  if [ "$OLD" = "$NEW_VERSION" ]; then
    DAEMON_PIDS=""
  else
    answer=n
    if [ -r /dev/tty ]; then
      printf '데몬(%s)을 새 버전(%s)으로 다시 시작한다. 세션과 claude 는 이어지고, 터미널 안에서 돌던 다른 프로그램은 끝난다. 할까? [Y/n] ' "${OLD:-?}" "$NEW_VERSION" >/dev/tty
      read -r answer </dev/tty || answer=n
      [ -n "$answer" ] || answer=y
    fi
    case "$answer" in
      [Yy]*)
        say "데몬을 내린다 (세션은 다음에 앱을 열면 되살아난다)"
        # shellcheck disable=SC2086
        kill -TERM $DAEMON_PIDS 2>/dev/null || true
        i=0
        while pgrep -f "$APP/Contents/MacOS/thuminald --home" >/dev/null 2>&1; do
          i=$((i + 1))
          [ "$i" -le 40 ] || die "데몬이 내려가지 않는다"
          sleep 0.25
        done
        ;;
      *) say "데몬은 옛 버전(${OLD:-?})으로 둔다. 다음에 앱 안 업데이트를 하거나 이 스크립트를 다시 돌리면 바뀐다" ;;
    esac
  fi
fi

# 바꿔 넣는다. /Applications 에 쓸 수 없으면 sudo 로
SUDO=""
[ -w "$APP_DIR" ] && { [ ! -e "$APP" ] || [ -w "$APP" ]; } || SUDO="sudo"
$SUDO rm -rf "$APP"
$SUDO mv "$TMP/thuminal.app" "$APP"
# curl 로 받은 파일엔 붙지 않지만, 예전에 브라우저로 받은 설치본에서 옮겨 온 표시가 있으면 지운다
$SUDO xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

say "설치했다: $APP ($NEW_VERSION)"
say "앞으로 새 버전은 앱 안 업데이트로 받는다 (사이드바 아래 '업데이트')"
open "$APP"
