#!/bin/sh
# 앱 번들에 넣을 데몬(thuminald)과 CLI(thuminal)를 빌드해 Tauri externalBin 자리에 둔다.
# 사용법: scripts/prepare-sidecars.sh [debug|release]   (기본 release)
set -eu
cd "$(dirname "$0")/.."
PROFILE="${1:-release}"
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
if [ "$PROFILE" = release ]; then
  mise exec -- cargo build --release -p thuminald -p thuminal-cli
else
  mise exec -- cargo build -p thuminald -p thuminal-cli
fi
OUT=apps/desktop/src-tauri/binaries
mkdir -p "$OUT"
for b in thuminald thuminal; do
  cp "target/$PROFILE/$b" "$OUT/$b-$TRIPLE"
done
echo "준비함: $OUT ($PROFILE, $TRIPLE)"
