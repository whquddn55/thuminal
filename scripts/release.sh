#!/bin/sh
# 새 버전을 낸다: 버전을 올려 커밋하고 v<버전> 태그를 단다. push 하면 Release 워크플로가 세 OS 설치본을 초안 Release 에 올린다.
# 사용법: scripts/release.sh 0.2.0
# 버전이 들어가는 곳: Cargo 작업공간(데몬 · CLI · 앱 crate, `thuminal --version` · 데몬 hello), tauri.conf.json(설치본 · 업데이트 비교)
set -eu
cd "$(dirname "$0")/.."
VERSION="${1:?사용법: scripts/release.sh <버전> (예: 0.2.0)}"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "버전은 0.2.0 꼴이어야 한다: $VERSION" >&2; exit 1 ;;
esac
[ -z "$(git status --porcelain)" ] || { echo "커밋하지 않은 변경이 있다. 먼저 정리한다" >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo "main 에서만 낸다" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && { echo "태그 v$VERSION 이 이미 있다" >&2; exit 1; }

# [workspace.package] 의 version 한 줄과 tauri.conf.json 의 "version" 한 줄만 바꾼다
sed -i.bak "/^\[workspace.package\]/,/^\[/ s/^version = \".*\"/version = \"$VERSION\"/" Cargo.toml && rm Cargo.toml.bak
sed -i.bak "s/^  \"version\": \".*\",/  \"version\": \"$VERSION\",/" apps/desktop/src-tauri/tauri.conf.json && rm apps/desktop/src-tauri/tauri.conf.json.bak
if command -v mise >/dev/null 2>&1; then mise exec -- cargo update --workspace -q; else cargo update --workspace -q; fi

git add Cargo.toml Cargo.lock apps/desktop/src-tauri/tauri.conf.json
git commit -q -m "release: v$VERSION"
git tag -a "v$VERSION" -m "thuminal v$VERSION"
echo "v$VERSION 커밋 · 태그를 만들었다. 올리려면: git push origin main v$VERSION"
echo "워크플로가 끝나면 GitHub 의 초안 Release 를 게시해야 앱이 업데이트를 찾는다"
