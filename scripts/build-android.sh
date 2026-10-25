#!/bin/sh
# thuminal 안드로이드 앱(apps/android)을 만들어 apps/web/public/download/thuminal.apk 에 둔다.
# 웹 화면을 다시 빌드하면 dist/download 에 같이 들어가고, 데몬 원격 접속이 /download/thuminal.apk 로 낸다.
# 필요: JDK 17 이상(mise 의 temurin-21 을 먼저 쓴다), Android SDK (ANDROID_HOME, 없으면 ~/Library/Android/sdk)
set -eu
cd "$(dirname "$0")/.."
# Gradle 8.14 는 JDK 24 이상에서 돌지 않는다. 지금 JAVA_HOME 이 없거나 너무 새것이면 mise 로 깐 JDK 17·21 을 쓴다
major=$("${JAVA_HOME:-/nonexistent}/bin/java" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1)
if [ -z "$major" ] || [ "$major" -ge 24 ]; then
  v=$(mise ls --installed java 2>/dev/null | awk '{print $2}' | grep -E '^temurin-(17|21)' | tail -1)
  [ -n "$v" ] || { echo "JDK 17 이나 21 이 필요하다 (mise install java@temurin-21)" >&2; exit 1; }
  JAVA_HOME=$(mise where "java@$v")
  export JAVA_HOME
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
[ -d "$ANDROID_HOME" ] || { echo "Android SDK 가 없다: $ANDROID_HOME" >&2; exit 1; }
(cd apps/android && ./gradlew -q assembleRelease)
mkdir -p apps/web/public/download
cp apps/android/app/build/outputs/apk/release/app-release.apk apps/web/public/download/thuminal.apk
echo "만듦: apps/web/public/download/thuminal.apk"
