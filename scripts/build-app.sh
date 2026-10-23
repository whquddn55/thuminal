#!/bin/sh
# thuminal.app 을 만든다. 데몬과 CLI 가 번들 안(Contents/MacOS)에 함께 들어간다.
set -eu
cd "$(dirname "$0")/.."
scripts/prepare-sidecars.sh release
pnpm install --frozen-lockfile
(cd apps/desktop && mise exec -- pnpm tauri build --bundles app)
echo "만듦: target/release/bundle/macos/thuminal.app"
