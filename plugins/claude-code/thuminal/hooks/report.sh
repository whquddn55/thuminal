#!/bin/sh
# claude 훅 알림을 thuminal 데몬에 전한다.
# thuminal 세션 밖이면(THUMINAL_SESSION_ID 가 없으면) 아무것도 하지 않는다.
# 표준 출력에 아무것도 쓰지 않는다 (SessionStart 훅의 출력은 claude 문맥에 들어간다).
if [ -z "$THUMINAL_SESSION_ID" ] || [ -z "$THUMINAL_CLI" ] || [ ! -x "$THUMINAL_CLI" ]; then
  cat >/dev/null 2>&1
  exit 0
fi
"$THUMINAL_CLI" agent report --kind claude >/dev/null 2>&1 || true
exit 0
