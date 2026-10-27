#!/bin/sh
# 켜진 스킬의 상시 지시를 SessionStart 문맥에 넣는다.
# 데몬이 설정에서 끈 스킬은 플러그인 폴더에서 뺀다. 그래서 스킬 폴더에 context.md 가 있을 때만 찍는다.
cat >/dev/null 2>&1
root="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/..}"
for f in "$root"/skills/*/context.md; do
  [ -f "$f" ] && cat "$f" && echo
done
exit 0
