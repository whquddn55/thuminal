#!/bin/sh
# 앱 번들에 넣을 데몬(thuminald)과 CLI(thuminal)를 빌드해 Tauri externalBin 자리에 둔다.
# 사용법: scripts/prepare-sidecars.sh [debug|release]   (기본 release)
# mise 가 있으면 mise 로(Zig 버전을 맞춘다), 없으면(CI · 컨테이너) PATH 의 cargo 로 빌드한다. CARGO_TARGET_DIR 을 따른다.
set -eu
cd "$(dirname "$0")/.."
PROFILE="${1:-release}"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if command -v mise >/dev/null 2>&1; then CARGO="mise exec -- cargo"; else CARGO=cargo; fi
if [ "$PROFILE" = release ]; then
  $CARGO build --release -p thuminald -p thuminal-cli
else
  $CARGO build -p thuminald -p thuminal-cli
fi
case "$TRIPLE" in *windows*) EXE=.exe ;; *) EXE= ;; esac
TARGET_DIR="${CARGO_TARGET_DIR:-target}"
OUT=apps/desktop/src-tauri/binaries
mkdir -p "$OUT"
for b in thuminald thuminal; do
  cp "$TARGET_DIR/$PROFILE/$b$EXE" "$OUT/$b-$TRIPLE$EXE"
done
echo "준비함: $OUT ($PROFILE, $TRIPLE)"
