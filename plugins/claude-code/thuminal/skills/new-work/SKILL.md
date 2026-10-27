---
name: new-work
description: >-
  thuminal 안에서, 현재 작업 중인 프로젝트 기준으로 새 브랜치 + 저장소 옆 워크트리를 만들고
  그 워크트리에 thuminal 탭 1개를 열어 claude 를 띄운 뒤 작업 지시서를 넘기는 고정 절차.
  Use when the user says "/new-work", "/thuminal:new-work", "새 작업 따줘", "워크트리 따서 claude한테 시켜",
  "새 브랜치에서 작업시켜", "이 작업 다른 claude한테 넘겨". thuminal 셸 안(`THUMINAL_CLI` 가
  있다)이면 orca-new-work 대신 이 스킬을 쓴다. "이슈 따서 / 티켓 발급해서" 요청 시 트래커 불문
  새 이슈 발급 옵션 지원 (base 브랜치는 사용자에게 질문). 브랜치·티켓 미지정이면 새 티켓을 딸지
  먼저 사용자에게 묻는다. "칸 N개로 나눠서" 요청 시 한 탭을 나눠 claude 여러 개 실행도 지원.
  기존 워크트리에 탭/칸만 열어 명령·에이전트를 실행해 달라는 요청에도 이 파일의 명령을 재사용한다
  (맨 아래 응용 절). 이 파일이 전체 절차다.
argument-hint: "[작업 내용] [브랜치·티켓·base 지정 (선택)]"
---

# new-work — 새 워크트리 + thuminal 탭 + claude 작업 지시

이 스킬은 자체 완결 레시피다. 아래 명령은 thuminal CLI 의 실제 도움말과 출력, 따로 띄운
데몬에서 처음부터 끝까지 돌려 본 결과(2026-10-26)로 썼다. **추측으로 바꾸지 말고 그대로 실행한다.**

## 절대 규칙

1. **CLI 는 `"$THUMINAL_CLI"` 로 부른다.** `thuminal` 은 PATH 에 없다. thuminal 셸 안이면
   데몬이 이 변수와 `THUMINAL_HOME` 을 넣어 주므로 그 데몬에 바로 닿는다. 변수가 비어 있으면
   thuminal 밖이다 — 중단하고 사용자에게 알린다 (Orca 안이면 orca-new-work 를 쓴다).
   아래 명령의 `$T` 는 `"$THUMINAL_CLI"` 를 줄여 쓴 것이다 (Bash 호출마다 셸이 새로 뜨므로
   매번 `T="$THUMINAL_CLI";` 를 앞에 붙인다).
2. **`git` 과 `$T` 는 처음부터 `dangerouslyDisableSandbox: true` 로 실행한다** (git 은 이 PC
   샌드박스에 막히고, `$T` 는 데몬 유닉스 소켓에 붙는다).
3. **`tab new` 는 전 과정에서 정확히 1회만 부른다.** 결과가 애매하면 다시 만들지 말고
   `$T wt ps` 로 확인한다. 칸을 더 띄울 때는 `pane split` 만 쓴다 (맨 아래 "여러 칸 모드").
4. **이름·경로 규칙은 고정이다.**
   - 워크트리는 `$T wt new` 로 만든다. 경로는 thuminal 규칙대로 저장소와 **같은 층**
     `<repo>-thm-wt-<branch-slug>` 에 생긴다 (`git worktree add` 로 직접 만들지 않는다).
   - 탭 이름: DISPLAY_NAME (`tab new --title`). thuminal 은 탭에 붙인 이름을 claude 가 바꾸는
     터미널 제목보다 앞에 보이므로 `/rename` 은 하지 않는다.
   - 브랜치 이름: repo 관례 추론 (아래 "브랜치명 추론 규칙"). 스킬 고유 접두어 금지.
5. **claude 는 `-- claude` 로만 띄운다. `--dangerously-skip-permissions` 를 붙이지 않는다.**
   thuminal 셸의 `claude` 는 실행기(`shell/claude-launch`)를 거쳐 권한 옵션·에이전트 팀(가짜
   tmux)·훅 플러그인을 사용자의 에이전트 설정대로 붙인다. 옵션을 직접 붙이면 그 설정을 덮어쓴다.
6. **긴 지시서를 `term send` 로 보내지 않는다.** 지시서는 파일(`WORK_ORDER.md`)로 쓰고,
   send 는 한 줄짜리 킥오프만 보낸다.
7. **사전 분석 최소화 — 넘기기는 가볍게.** 메인 세션의 조사는 워크트리를 만드는 데 필요한
   최소한(BRANCH·BASE 결정, 이슈 키·브랜치 관례 확인, 입력 파일 존재 확인, 중복 검사)에서
   멈춘다. 입력 파일 파싱, 이슈 본문 심층 분석, 브랜치 간 코드 대조 같은 상세 분석은 워커
   claude 의 몫이다 — WORK_ORDER 에 분석 **결과**를 적지 말고 "무엇을 어떻게 분석하라"는
   **지시**로 적는다 (2026-08 사용자 피드백).

## 입력 결정

- **TASK**: 작업 지시 내용. 사용자 대화/인자에서 확보. 없으면 사용자에게 묻고 중단.
- **BRANCH**: 사용자가 브랜치명·티켓번호를 지정했으면 그대로 쓴다. 지정이 없으면 **새 티켓을
  딸지 먼저 사용자에게 묻는다** — 딴다고 하면 "옵션: 새 이슈 발급"으로 들어가고 (BRANCH 는 그
  절차 I-3 이 정한다), 안 딴다고 하면 "브랜치명 추론 규칙"으로 키 없이 정한다 (slug 는 작업 내용
  3~5 낱말 영문 kebab-case).
- **BASE**: 사용자가 지정한 base 브랜치/커밋. 없으면 현재 체크아웃의 HEAD.
  - **develop 규칙 (2026-10-01 사용자 지시)** — BASE 가 `develop` 또는 `origin/develop` 이면,
    또는 BASE 미지정인데 현재 체크아웃 브랜치(`git -C "$PWD" branch --show-current`)가 `develop`
    이면 **DEVELOP_BASE** 다. DEVELOP_BASE 는 로컬 develop 이 아니라 **방금 받은 최신
    `origin/develop`** 에서 따고 (Step 2), 부모 워크트리를 붙이지 않는다 (Step 4) — develop 만의
    예외다.
- **DISPLAY_NAME**: 사이드바 워크트리 이름(`wt new --name`)과 탭 이름(`tab new --title`)에 **같은
  값**을 쓴다. **최대한 짧게** 짓는다 (2026-10-16 사용자 지시) — 이슈 키가 있으면
  `{티켓 숫자}-{짧은 내용}`, 없으면 `{짧은 내용}` (예: `123-로그인 오류 수정`,
  `빌드 캐시 분리`).
  - 티켓은 **숫자만** 쓴다 — 프로젝트 접두어(`PROJ-`)는 뺀다.
  - 짧은 내용은 2~4 낱말(대략 10자 안팎). 한글 위주, 영문 식별자·약어는 꼭 필요한 것만.
    문장·설명·괄호 부연을 붙이지 않는다.
- **MODEL**: 사용자가 지정했으면 그대로 쓰고, 없으면 비워 둔다 — Step 5 에서 `--model` 째 뺀다.
  작업 성격을 보고 에이전트가 모델을 고르지 않는다 (2026-09-23 사용자 지시).
- 사용자가 "이슈 따서 / 티켓 발급해서 / 새 이슈로"를 말했거나 BRANCH 질문에서 발급을 골랐으면
  Step 0 앞에 "옵션: 새 이슈 발급"을 한다 — 그 절차가 BRANCH·BASE 를 대신 정한다.

## 브랜치명 추론 규칙 (티켓 유무 공통)

BRANCH 를 사용자가 직접 주지 않았으면 **repo 의 기존 관례에서 패턴을 추론**한다.

1. 관례 확인 (가벼운 조회만 — 절대 규칙 7):
   `git -C "$MAIN_REPO" branch -a --sort=-committerdate | head -20`,
   `git -C "$MAIN_REPO" log --oneline -20`, repo 관례 문서(CLAUDE.md·CONTRIBUTING·개발 사이클
   문서)의 브랜치 규칙.
2. 패턴을 그대로 재현한다 — 접두어(`feature/`·`fix/`), 이슈 키 자리, 구분자, slug 언어까지.
   관례가 `feature/<KEY>-<slug>` 면 티켓 있음 → `feature/<KEY>-<slug>`, 티켓 없음 →
   `feature/<slug>` (구분자 남기지 않음).
3. 관례를 못 찾거나 후보가 여럿이면 후보를 내놓고 사용자에게 묻는다.

## 옵션: 새 이슈 발급 (트래커 불문)

발급 수단은 그 세션에서 찾는다. 트래커별 필드 관례는 트래커 전용 스킬 소관이다.

### I-1. 발급 수단 판별 (우선순위)

1. 이슈 발급을 맡는 트래커 전용 스킬이 있으면 (예: 이슈 트래커 플러그인의 스킬) 그 스킬에 위임한다.
2. 없으면 세션 도구에서 찾는다 — MCP 도구명에 jira/redmine/issue, GitHub repo 면
   `gh issue create`, GitLab 이면 `glab issue create`. 본문 형식은 repo 관례 문서, 없으면
   무엇을/왜/완료 기준 3절.
3. 둘 다 없거나 애매하면 사용자에게 묻는다. "직접 발급하고 키만 알려 달라" 폴백도 함께 낸다.

### I-2. 초안 검수 → 발급

- 제목·본문 초안을 사용자에게 보여 확인받은 뒤 등록한다. "바로 발급"을 말했으면 생략.
- **할당자는 기본적으로 요청한 사용자 본인.** 계정 식별자를 모르면 사용자가 담당자인 기존
  이슈 하나를 조회해 형식을 확인한다. 할당 실패 시 1회 재시도. 유형·필드 오류는 유효한 값을
  조회하거나 묻고, 권한 오류는 보고 후 중단 — 임의 값으로 우겨넣지 않는다.
- **에픽은 붙이지 않는다** (묻지도 않는다, 2026-09-14). 사용자가 명시했을 때만 연결.
- **스프린트는 활성 스프린트에 넣는다** (2026-09-17). "백로그로/스프린트 빼고/다음 스프린트로"
  를 말하면 따른다. 활성 스프린트를 단정할 수 없으면 백로그로 두고 Step 9 보고에 한 줄 남긴다.

### I-3. 발급 결과 → 입력 결정 반영

- **ISSUE_KEY**: 발급된 식별자. URL 과 함께 기록.
- **BASE**: 이 옵션에서는 **반드시 사용자에게 묻는다** — 현재 체크아웃 브랜치 / repo 기본
  브랜치(develop·main) / 직접 입력. 이 값이 PR 대상 브랜치다.
- **BRANCH**: "브랜치명 추론 규칙"으로 (ISSUE_KEY 를 키 자리에).
- **지시서 추가 항목**: 이슈 키·URL, 커밋 메시지의 이슈 키 표기 관례, PR 대상 브랜치(BASE).

## 절차

### Step 0 — repo 위치 계산 + 등록

```bash
git -C "$PWD" rev-parse --path-format=absolute --git-common-dir
```

- 결과에서 끝의 `/.git` 을 뗀 것이 **MAIN_REPO**. repo 가 아니면 중단하고 어느 프로젝트인지 묻는다.
- `REPO_NAME` = basename(MAIN_REPO), `PARENT` = dirname(MAIN_REPO)
- `BRANCH_SLUG` = BRANCH 에서 영문·숫자·`-_.` 밖의 글자를 모두 `-` 로 바꾼 것 (thuminal 규칙)
- `WT_PATH` = `$PARENT/${REPO_NAME}-thm-wt-${BRANCH_SLUG}`
- 저장소를 thuminal 에 등록하고 id 를 받는다 (이미 등록돼 있으면 그 id 가 그대로 나온다):

```bash
T="$THUMINAL_CLI"; "$T" repo add "$MAIN_REPO"
```

출력 `9fbc6f88  proj  /경로` 의 첫 칸이 **REPO_ID**.

### Step 1 — 중복 검사

```bash
git -C "$MAIN_REPO" rev-parse --verify --quiet "refs/heads/$BRANCH" && echo BRANCH_EXISTS; test -e "$WT_PATH" && echo PATH_EXISTS; true
```

둘 중 하나라도 있으면 **아무것도 만들지 말고** 사용자에게 보고 후 지시를 기다린다.

### Step 2 — 워크트리 만들기

```bash
T="$THUMINAL_CLI"; "$T" wt new "$BRANCH" --repo "$REPO_ID" --base "$BASE" --name "$DISPLAY_NAME"
```

- 출력 한 줄이 만든 경로다. Step 0 의 WT_PATH 와 같은지 본다 (다르면 출력 쪽을 쓴다).
- BASE 미지정이면 `--base` 째 뺀다 (지금 HEAD 에서 딴다).

**DEVELOP_BASE 면 위 명령 대신 아래 세 단계** (2026-10-01 사용자 지시 — 로컬 develop 이
낡았어도 항상 최신 origin/develop 기준):

1. origin 의 develop 을 먼저 받는다. `git -C "$MAIN_REPO" fetch origin develop` 로 받는다.
   **fetch 가 실패하면 낡은 develop 으로 대신 만들지 말고 중단 후 보고한다** (VPN 등).
2. 받은 `origin/develop` 에서 따고, 기준 커밋을 **BASE_SHA** 로 기록한다:

   ```bash
   T="$THUMINAL_CLI"; "$T" wt new "$BRANCH" --repo "$REPO_ID" --base origin/develop --name "$DISPLAY_NAME" && git -C "$MAIN_REPO" rev-parse --short origin/develop
   ```

3. **upstream 을 뗀다.** `wt new` 는 `git worktree add -b` 를 그대로 부르므로 원격 브랜치에서
   따면 새 브랜치의 upstream 이 develop 으로 잡혀 pull·push 가 develop 을 향한다:

   ```bash
   git -C "$WT_PATH" branch --unset-upstream 2>/dev/null; git -C "$WT_PATH" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo NO_UPSTREAM
   ```

   `NO_UPSTREAM` 이 나와야 한다. 메인 체크아웃의 로컬 develop 은 건드리지 않는다.

### Step 2.5 — repo 부트스트랩 (스크립트가 있을 때만)

새 워크트리는 gitignore 된 것(`.env`·`.venv`·`node_modules`·로컬 DB 등)을 물려받지 않는다.
repo 이름으로 된 부트스트랩 스크립트가 있으면 돌린다:

```bash
BOOTSTRAP="$HOME/.claude/scripts/worktree-bootstrap/${REPO_NAME}.sh"
test -x "$BOOTSTRAP" && "$BOOTSTRAP" "$WT_PATH" || echo "부트스트랩 스크립트 없음 — 건너뜀"
```

- 없으면 조용히 건너뛴다. 실패하면 출력을 그대로 보고하되 나머지 절차는 계속한다.

### Step 3 — 작업 지시서 파일 작성

Write 도구로 `$WT_PATH/WORK_ORDER.md` 를 만든다. 본체는 **사용자 프롬프트의 충실한 릴레이**다:
워크트리·브랜치·base 같은 셋업 지시(이 스킬이 이미 소화한 부분)만 걷어내고, 남는 "거기서 할
작업"은 의역·재구성·확장 없이 원문에 가깝게 담는다. 받는 claude 는 이 대화를 볼 수 없으니 대화에
이미 있던 보조 사실(이슈 키·URL, 입력 파일 경로, 재현 방법)은 보태되, 메인 세션이 새로 조사한
분석 결과는 담지 않는다 (절대 규칙 7). **"## 팀원 활용" 절은 항상 그대로 넣는다** — 워커가
Agent 에 `name` 을 안 주면 팀원 없이 백그라운드 서브에이전트만 쓰게 된다 (2026-10-02 실측).

```markdown
# 작업 지시서

## 작업 요청 (사용자 원문)
(사용자 프롬프트에서 셋업 지시만 제거하고 최대한 그대로. 의역·확장 금지)

## 배경 / 컨텍스트
(대화에 이미 있던 보조 사실만. 새로 조사한 분석 결과 금지. 없으면 절 생략)

## 분석 지시
(워커가 직접 할 조사 — 결과가 아니라 지시로. 없으면 절 생략)

## 팀원 활용 (Agent Teams — 이 탭의 claude 는 thuminal 에서 팀 기능을 켠 채 떠 있다)
- 띄우기: Agent 도구에 **`name` 을 반드시 준다** (예 `name: "be-worker"`) → 팀원이 thuminal 터미널로 떠서, 이 칸 위 팀 패널(팀원 목록 → 팀원 터미널)에 보인다. `name` 이 없으면 백그라운드 서브에이전트라 팀원이 아니다. 팀 생성 도구(TeamCreate)는 없다 — 세션마다 팀이 하나 이미 있고 `team_name` 인자는 무시된다.
- 확인: `ListAgents` 의 Teammates 줄에 보이면 정상.
- 지시 · 결과: 팀원 프롬프트에 "끝나면 팀 리더에게 SendMessage 로 결과 파일 경로 + 요약을 보내고 대기" 를 적는다 (대량 결과는 파일로). 추가 지시는 `SendMessage(to: "<name>")`.
- 끄기: `TaskStop(task_id: "<name>")`. 끈 뒤 늦게 오는 `idle_notification` 은 무시한다.

## 제약
- 브랜치: <BRANCH> (base <BASE> 에서 이미 체크아웃돼 있음. 브랜치 이동 금지)
  (DEVELOP_BASE 면 `base origin/develop <BASE_SHA> — 최신으로 받은 뒤 땀, PR 대상 develop`)
- ...

## 완료 기준
- (사용자 요청에서 도출되는 것만. 없으면 절 생략)

---
주의: 이 파일(WORK_ORDER.md)은 작업 산출물이 아니다. 커밋하지 말 것.
```

이슈 키가 있으면 제약 절에 넣는다: "작업 시작 시 이슈 <ISSUE_KEY> 가 아직 시작 전 상태(할 일/To
Do 등)면 **진행 중으로 전이**할 것. 이미 진행 중이거나 그 뒤 상태면 건드리지 않는다."

### Step 4 — 부모 워크트리 붙이기 (best-effort)

새 워크트리를 **BASE 브랜치를 체크아웃한 워크트리의 하위**로 붙여 사이드바에서 그 밑에 들여
보이게 한다 (디스크 경로는 그대로이고 thuminal 메타데이터만 바뀐다):

```bash
T="$THUMINAL_CLI"; "$T" wt set "$WT_PATH" --parent "$BASE"
```

- **DEVELOP_BASE 면 건너뛴다** (2026-10-01, develop 만의 예외). main 등 다른 기본 브랜치는 붙인다.
- BASE 가 미지정이거나 커밋 SHA 면 건너뛴다.
- 실패해도(그 브랜치를 체크아웃한 워크트리가 없다 등) 무시하고 진행한다.
- 떼려면 `wt set "$WT_PATH" --no-parent`.

### Step 5 — 탭 만들기 + claude 띄우기 (1회만!)

```bash
T="$THUMINAL_CLI"; "$T" tab new --in "$WT_PATH" --title "$DISPLAY_NAME" -- claude --model "$MODEL"
```

- **MODEL 이 비어 있으면 `--model` 째 뺀다** (`-- claude`).
- 출력은 `t3 p7 s12` (탭, 칸, 세션). 셋째 칸 **SESSION**(`s12`)을 이후 모든 명령에 쓴다.
  PANE(`p7`)은 여러 칸 모드에서 쓴다.
- `--` 뒤 명령은 새 셸에 입력된다. 그래서 셸 함수 `claude` → 실행기를 탄다 (절대 규칙 5).
- 출력이 없거나 오류가 애매하면 **다시 부르지 말고** 확인한다:

```bash
T="$THUMINAL_CLI"; "$T" wt ps | grep -A5 -F "$WT_PATH"
```

### Step 6 — claude 부팅 대기

```bash
T="$THUMINAL_CLI"; "$T" term wait "$SESSION" --agent idle --timeout 90; echo "exit $?"
```

- claude 의 `SessionStart` 훅이 데몬에 닿으면 `idle` 을 찍고 끝난다 (보통 몇 초). 화면 변화를
  추측하는 것이 아니라 훅 상태라 바로 다음 단계로 가도 된다 (2026-10-26 실측: 부팅 직후 보낸
  지시도 들어갔다).
- **exit 124(시간 넘음)면 화면을 읽는다** (`"$T" term read "$SESSION" --tail 15`).
  - `trust this folder` 창이면 claude 가 이 폴더를 믿을지 묻는 중이다 (메인 저장소를 아직 믿은
    적이 없을 때 뜬다. 믿은 저장소의 워크트리는 뜨지 않는다). 훅은 이 창을 넘기기 전엔 오지 않는다.
    **사용자에게 확인받고**, 믿는다고 하면 아래로 "Yes" 를 고른 뒤 Step 6 을 다시 한다:

    ```bash
    T="$THUMINAL_CLI"; "$T" term send "$SESSION" $'\e[B' && "$T" term send "$SESSION" "" --enter
    ```

  - 셸 프롬프트만 보이면 claude 가 뜨지 못한 것이다 — 화면 그대로 사용자에게 보고하고 멈춘다.

### Step 7 — 킥오프 보내기 + 받았는지 확인

```bash
T="$THUMINAL_CLI"; "$T" term send "$SESSION" "WORK_ORDER.md 파일을 읽고 그 작업 지시서대로 작업을 시작해 주세요. WORK_ORDER.md 자체는 커밋하지 마세요." --enter && "$T" term wait "$SESSION" --agent working --timeout 30; echo "exit $?"
```

- `working` 이 찍히면 claude 가 프롬프트를 받아 일을 시작한 것이다 (`UserPromptSubmit` 훅).
  턴이 끝날 때까지 기다리지 않는다.
- exit 124 면 `"$T" term read "$SESSION" --tail 15` 로 본다. 킥오프가 대화에 올라가 있고
  claude 가 답했으면 턴이 이미 끝난 것이니 그대로 Step 8 로 간다. 킥오프 글이 입력창(`❯` 줄)에
  그대로 남아 있으면 Enter 만 한 번 더 보내고 다시 `--agent working` 으로 확인한다:

  ```bash
  T="$THUMINAL_CLI"; "$T" term send "$SESSION" "" --enter && "$T" term wait "$SESSION" --agent working --timeout 30
  ```

  (`--enter` 는 글을 보낸 뒤 300ms 쉬고, 화면에 글이 찍힐 때까지(최대 3초) 기다렸다가 Enter 를
  따로 친다. idle 직후의 claude 는 바빠서 글과 Enter 를 한 번에 읽고, 붙여넣기로 받아 Enter 를
  줄바꿈으로 넣었다 — 2026-10-27 고침. 그래도 남으면 `$'\e[13u'`(kitty 방식 Enter)를 보내면 제출된다.)

### Step 8 — 사용자 보고

다음을 한 번에 보고하고 끝낸다 (워크트리를 지켜보거나 결과를 기다리지 않는다):

- 브랜치 / 표시 이름 / 워크트리 경로 / 탭·칸·세션 번호(`t3 p7 s12`) (여러 칸이면 칸마다 번호와
  담당 범위) / 부모 워크트리 (DEVELOP_BASE 면 "최상위, develop 예외") / base 커밋 (DEVELOP_BASE 면
  `origin/develop <BASE_SHA>`) / 워커 모델 (지정했으면)
- 넘긴 작업 지시 한 줄 요약
- 진행 확인: `"$THUMINAL_CLI" term read s12 --tail 15`, 턴 끝 대기: `"$THUMINAL_CLI" term wait s12 --agent idle`
- 정리 명령: `"$THUMINAL_CLI" wt rm "$WT_PATH" --force --delete-branch` (그 워크트리의 세션을
  끝내고 워크트리를 지운다. 합치지 않은 커밋이 있으면 브랜치는 남기고 알린다 — 그래도 지우려면
  `--force-branch`, push 안 한 커밋이 있으면 먼저 사용자에게 알린다)

참고: thuminal 에는 Orca 의 카드 메모·진행 상태 칸이 없다. 그 단계는 하지 않는다.

## 여러 칸 모드 (명시 요청 시에만)

사용자가 "칸 N개로 나눠서", "화면 나눠서 여러 개" 등을 말했을 때만 쓴다. 기본은 탭 1개 + 칸 1개
+ claude 1개.

**주의:** 한 탭의 칸들은 **같은 워크트리(같은 체크아웃·같은 브랜치)를 함께 쓴다.** 서로 독립적인
병렬 작업(각자 브랜치 필요)이면 이 모드가 아니라 이 스킬 절차를 N회 해 워크트리 N개를 만드는 것이
맞다 — 요청이 그쪽에 가까우면 먼저 사용자에게 확인한다.

기본 절차와 다른 점:

- **Step 3**: 지시서를 `WORK_ORDER-1.md` … `WORK_ORDER-N.md` 로 나눠 쓴다. 각 파일에 (a) 담당
  범위, (b) "담당 범위 밖 파일 수정 금지", (c) 같은 체크아웃에서 다른 claude 가 함께 일한다는
  사실을 적는다.
- **Step 5 직후**: 칸을 더 띄울 때는 `tab new` 가 아니라 `pane split` 으로 (칸마다 1회):

  ```bash
  T="$THUMINAL_CLI"; "$T" pane split "$PANE" --right --no-focus -- claude --model "$MODEL"
  ```

  출력 `p8 s13` 의 세션 번호를 칸 번호와 함께 기록한다. `--right` = 좌우, `--down` = 위아래 —
  3개 이상이면 새로 생긴 칸을 번갈아 나눠 격자에 가깝게 만든다. MODEL 처리는 Step 5 와 같다.
- **Step 6~7**: 칸마다 부팅 대기 → 자기 번호의 `WORK_ORDER-<n>.md` 를 읽으라는 한 줄 → working
  확인을 한다.

## 응용: 기존 워크트리에 탭/칸만 열기

"저 워크트리에서 FE/BE 를 새 탭에 칸 나눠서 각각 실행해 줘" 같은 요청은 이 파일의 명령을 다시
쓴다. 절대 규칙(CLI 경로, 샌드박스 해제, `tab new` 1회 + 더 띄울 칸은 `pane split`)은 그대로다.

- **워크트리 확인**: `"$T" wt ls --repo "$REPO_ID"` (또는 `--repo` 없이 전체). `--in` 은 워크트리
  경로나 브랜치 이름을 받는다.
- **탭 만들기**: Step 5 명령에서 `--title` 과 `--` 뒤 명령만 바꾼다 (예: `--title FE -- npm run dev`).
- **칸 더하기**: 여러 칸 모드의 split 명령에서 `--` 뒤 명령만 바꾼다.
- **건너뛰는 단계**: 브랜치/워크트리 만들기(Step 0~2, 4), WORK_ORDER(Step 3), 킥오프(Step 7).
  claude 를 띄워 지시까지 넘기는 요청이면 Step 3·6·7 을 그대로 쓴다.
- dev 서버처럼 계속 도는 명령에는 `--agent` 대기를 쓰지 않는다 (claude 전용). 필요하면
  `"$T" term wait "$SESSION" --match "<기동 문구>" --timeout 60` 이나 `term read --tail 15` 로 본다.
