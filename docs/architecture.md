# thuminal 구조

thuminal 은 워크트리마다 터미널과 에이전트를 띄워 관리하는 macOS 앱이다. 앱을 끄거나 업데이트해도 터미널은 살아 있고, 재부팅 뒤에는 claude 세션을 이어 붙인다.

이 문서는 층을 어떻게 나누는지, 그리고 각 기술을 어디서 갈아끼우는지를 적는다.

## 원칙

- **바깥 기술은 모두 인터페이스 뒤에 둔다.** 터미널 엔진, PTY, 통신, git, 렌더러, 앱 껍데기는 trait(Rust) 이나 interface(TypeScript) 로 정의하고, 실제 구현은 어댑터 크레이트·패키지에 둔다. 위층은 인터페이스만 안다.
- **어댑터를 고르는 곳은 한 군데다.** 바이너리의 `main` 이나 앱 시작 코드가 어댑터를 골라 끼운다. 나머지 코드는 어떤 어댑터가 끼워졌는지 모른다.
- **데몬과 클라이언트 사이 약속은 언어와 엔진에 묶이지 않는다.** 메시지는 JSON 과 바이너리 프레임이고, 화면 저장본은 엔진 고유 형식과 VT 재생 형식 두 가지를 둔다. 그래서 데몬과 앱이 서로 다른 엔진을 써도 붙을 수 있다.
- **데몬은 앱 버전과 따로 산다.** 프로토콜 주 버전이 소켓 이름에 들어간다. 앱이 새 주 버전으로 올라가면 새 데몬을 띄우고, 옛 데몬은 자기 세션이 다 끝날 때까지 둔다.

## 층

```
apps/desktop (Tauri 껍데기) ── packages/ui (React 화면)
      │                              │
      │ HostApi 구현                   ├─ packages/term-core (인터페이스)
      │                              ├─ packages/engine-ghostty-wasm (엔진 어댑터)
      │                              ├─ packages/renderer-webgl (렌더러 어댑터)
      │                              └─ packages/themes (터미널 테마 목록, 화면 색 만들기)
      ▼
crates/thuminal-client ──── crates/thuminal-cli (thuminal 명령)
      │  (프로토콜 + 전송)
      ▼
crates/thuminal-daemon (thuminald)
      ├─ crates/thuminal-layout          (탭과 칸 트리 규칙, 배치 한 줄 문법. 입출력 없음)
      ├─ crates/thuminal-engine          (TerminalEngine 인터페이스)
      │    └─ crates/thuminal-engine-ghostty (libghostty-vt 어댑터)
      ├─ crates/thuminal-pty             (Pty 인터페이스)
      │    └─ crates/thuminal-pty-portable (portable-pty 어댑터)
      ├─ crates/thuminal-workspace       (저장소, 워크트리. Vcs 인터페이스)
      │    └─ crates/thuminal-vcs-git    (git 명령 어댑터)
      └─ crates/thuminal-protocol        (메시지, 프레이밍, 버전. 입출력 없음)

plugins/claude-code/thuminal  (Claude Code 플러그인: 훅 → `thuminal agent report` → 데몬.
                               설치하지 않고 셸 통합의 `claude --plugin-dir` 로 thuminal 안의 실행에만 얹는다)
```

| 갈아끼우는 것 | 인터페이스 | 지금 어댑터 | 다른 후보 |
|---|---|---|---|
| 데몬 터미널 엔진 | `thuminal_engine::TerminalEngine` | `thuminal-engine-ghostty` (libghostty-vt) | vt100, alacritty_terminal |
| PTY | `thuminal_pty::PtySystem` | portable-pty | 직접 forkpty |
| 데몬 통신 | `thuminal_protocol` 프레임 + 유닉스 소켓 | 유닉스 소켓 | TCP, WebSocket (원격) |
| 앱 터미널 엔진 | `term-core` 의 `TerminalEngine` | ghostty-vt.wasm | xterm.js 헤드리스 |
| 렌더러 | `term-core` 의 `Renderer` | WebGL2 글자 그림판 | WebGPU, Canvas |
| 앱 껍데기 | `term-core` 의 `HostApi` | Tauri | Electron, 브라우저 + 원격 데몬 |
| 버전 관리 | `thuminal_workspace::Vcs` | git 명령 | libgit2, jj |

## 데몬 (`thuminald`)

- **띄우기**: 클라이언트(앱, CLI)가 소켓에 붙지 못하면 데몬을 새 세션(`setsid`)으로 떼어 띄운다. 부모가 죽어도 데몬과 그 밑의 셸은 살아 있다.
- **한 개만**: 데이터 폴더의 `daemon-v{주버전}.lock` 을 `flock` 으로 잡는다. 이미 잡혀 있으면 뜨지 않는다.
- **세션**: 세션 하나는 PTY 하나와 엔진 하나다. 엔진은 세션 전용 스레드(actor)가 혼자 들고 있다. PTY 에서 읽은 바이트는 이 스레드가 엔진에 넣은 뒤 붙어 있는 클라이언트들에 보낸다. 붙기(attach)도 같은 스레드에서 처리하므로, 저장본을 만든 시점과 그 뒤 출력 사이에 빠지거나 겹치는 바이트가 없다.
- **터미널 질의 응답**: 셸이나 claude 가 커서 위치 같은 것을 물으면 데몬 엔진이 답한다. 앱이 붙어 있어도 앱 엔진은 답하지 않는다. 답이 두 번 가지 않게 하려는 것이다.
- **로그**: `logs/daemon.log` 에 JSON 한 줄씩 남긴다. 기능 사용(세션 만들기, 붙기, CLI 명령)도 `event` 필드로 남겨 나중에 어떤 기능을 많이 쓰는지 셀 수 있게 한다.

- **워크트리**: 저장소 목록(`workspace.json`)과 워크트리 만들기/지우기도 데몬이 맡는다. 그래야 CLI 로 만든 워크트리가 앱에도 바로 나타난다 (`workspace_changed` 이벤트). 새 워크트리는 저장소 옆 `<저장소>-thm-wt-<브랜치>` 에 만든다. 세션을 만들 때 시작 폴더가 워크트리 안이면 `worktree` 꼬리표를 단다.
  - 지울 때 `force` 는 워크트리에만(바뀐 파일이 있어도), `force_branch` 는 브랜치에만(합치지 않았어도 `git branch -D`) 쓴다. `force_branch` 없이는 `git branch -d` 로 지우고, git 이 거절하면 브랜치를 남긴 채 워크트리만 지우고 성공으로 답한다. 답 `text` 에 "브랜치 X 는 합치지 않은 커밋이 있어 남겼다" 같은 까닭을 싣는다 (알릴 것이 없으면 빈 글).
- **셸 통합**: 데몬이 기본 셸을 띄울 때 zsh 는 `ZDOTDIR`, bash 는 `--rcfile` 로 thuminal 파일(`shell/`)을 먼저 읽힌다. 그 파일은 사용자 설정을 그대로 다 읽은 뒤 `claude` 함수를 더한다. 함수는 `--plugin-dir` 로 thuminal claude 플러그인을 그 실행에만 얹는다.
- **에이전트**: claude 훅이 `thuminal agent report` 로 상태(일하는 중, 입력 기다림, 사용자 부름)와 claude 세션 id 를 알린다. 세션 정보의 `agent` 에 담긴다. 상태 규칙은 Orca 의 claude 훅 처리를 따른다.
  - 거는 훅: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, StopFailure, SessionEnd.
  - 일하는 중: UserPromptSubmit, PreToolUse, PostToolUse(Failure). 부름: PermissionRequest, 묻는 도구(AskUserQuestion)의 PreToolUse, Notification 의 `notification_type` 이 `permission_prompt`/`elicitation_dialog`. 기다림: Stop, StopFailure, SessionStart(compact 말고), Notification `idle_prompt`(일을 마치고 60초쯤 쉬면 온다. 부름이 아니다). 그 밖의 Notification 과 모르는 훅은 상태를 바꾸지 않는다. 권한을 승인하면 PostToolUse 가 와서 다시 일하는 중이 된다. 거절하면 훅이 오지 않아 다음 프롬프트까지 부름으로 남는다.
  - `agent` 에는 상태와 함께 마지막 프롬프트(`prompt`), 마지막 답(`last_assistant_message`, Stop 훅에 없으면 CLI 가 transcript 끝 256KB 에서 찾는다), 지금 도구(`tool_name`), 모델(`model`), 턴이 끝난 때(`turn_ended_at`)를 담는다. 글은 200자까지 자른다. `updated_at` 은 상태가 바뀐 때다. `turn_ended_at` 이 있고 idle 이면 끝남, 없이 idle 이면 막 떠서 기다리는 중이다. 바뀐 것이 있을 때만 `session_updated` 를 낸다.
  - `agent report` 는 thuminal 세션 밖이거나 데몬이 없으면 아무것도 하지 않고, 데몬에 붙기와 요청을 1초 안에 끝낸다. 에이전트를 막지 않는다.
- **벨과 알림**: 데몬 엔진이 BEL 을 받으면 세션 정보 `bell_at`(ms)을 바꾸고 `session_updated` 를, OSC 9 / OSC 777 데스크톱 알림을 받으면 `session_notification { session, title, body }` 를 낸다. 둘 다 세션마다 1초에 한 번까지다. 엔진은 `TerminalEngine::take_events` 로 벨과 알림을 내놓는다.
- **배치**: 탭과 칸 나눔(tmux 식)의 주인은 데몬이다. workspace(워크트리 경로, `floating`, `other`)마다 탭 목록이 있고, 탭마다 n갈래 칸 트리(`row` 좌우, `column` 위아래, 비율 합 1)가 있다. 칸 하나에는 터미널 세션이나 앱이 그리는 문서가 든다. 앱과 CLI 는 `layout` 요청(op)을 보내고, 데몬이 트리를 바꾸고 필요한 세션을 띄운 뒤 `layout_changed` 이벤트로 workspace 배치를 통째로 알린다. op 는 사본에서 돌려 끝까지 되면 바꿔 끼운다. 중간에 세션을 띄우지 못하면 배치는 그대로이고 그 op 가 띄운 세션은 지운다. 트리 규칙(정규화, 화면 위치로 옆 칸 찾기 등)은 `thuminal-layout` 에 있다.
  - `CreateSession` 으로 만든 세션은 꼬리표로 정한 workspace(`floating` → 플로팅, `worktree` → 그 경로, 없으면 `other`) 새 탭 끝에 들어간다. 꼬리표 `layout=none` 이면 넣지 않는다.
  - 세션을 지우면 그 칸이 빠지고, 칸을 닫으면 그 세션을 지운다. 칸을 다른 workspace 로 옮기면 세션 꼬리표도 고친다. 워크트리를 지우면 그 배치를 지운다.
  - 칸·탭 번호는 데몬 전체에서 하나씩 늘고 다시 떠도 이어 센다. 되살린 세션은 `restored_from` 으로 옛 번호를 새 번호로 바꿔 끼우고, 되살리지 못한 세션의 칸은 뺀다. 뜰 때 칸에 없는 돌고 있는 세션은 새 탭으로 넣는다.
- **터미널 색**: 앱이 테마 색(전경, 배경, 커서, 팔레트)을 `set_terminal_colors` 로 주면 데몬은 모든 세션 엔진과 앞으로 만들 엔진의 기본색으로 넣는다. 그래서 프로그램의 색 질의(OSC 4/10/11/12)에 데몬 엔진이 테마 색으로 답하고, 프로그램이 OSC 로 바꾼 색은 엔진이 지킨다. `CSI ?996n` 에는 배경이 전경보다 어두우면 dark 로 답하고, mode 2031 을 켠 세션에는 밝기가 바뀔 때만 `CSI ?997;1n`/`;2n` 을 써 준다.
- **되살리기**: 데몬은 돌고 있는 세션의 정보(`sessions-v1.json`)를 바뀔 때마다, 화면 저장본(`sessions/<번호>.vt`)을 30초마다와 종료 신호 때 남긴다. 다시 뜨면 같은 폴더에서 로그인 셸을 띄우고, 이전 화면을 먼저 그리고, claude 세션이 있었으면 `claude --resume <id>` 를 입력한다. `thuminal daemon stop` 으로 내리면 기록을 지운다.

## 프로토콜

- 프레임: `[길이 u32 BE][종류 u8][내용]`. 종류 0 은 JSON 메시지, 1 은 세션 출력(바이너리), 2 는 세션 입력(바이너리).
- 처음 주고받는 `hello` 에서 프로토콜 버전을 맞춘다. 주 버전이 다르면 끊는다.
- 화면 저장본 형식: `native`(엔진 고유, 같은 엔진끼리만), `vt`(제어 코드로 화면을 다시 그리는 바이트, 어떤 엔진이든 먹는다).

## 데이터 폴더

`~/Library/Application Support/thuminal/` (환경 변수 `THUMINAL_HOME` 으로 바꿀 수 있다. 시험은 임시 폴더를 쓴다).

```
daemon-v1.sock      데몬 소켓
daemon-v1.lock      한 개만 뜨게 하는 잠금 + pid
logs/daemon.log     JSON 한 줄 로그
workspace.json      등록한 저장소
sessions-v1.json    되살릴 세션 정보
sessions/<번호>.vt  되살릴 화면 저장본
layout-v1.json      탭과 칸 배치, 다음 칸·탭 번호 (바뀌고 1초 안에 쓴다. daemon stop 이면 지운다)
terminal-colors.json 터미널 기본색 (앱 테마)
```

## CLI (`thuminal`)

명령마다 데몬에 한 번 붙는다. 바꾸는 명령은 대상을 데몬이 풀도록 칸 번호나 세션으로 보내 요청 하나로 끝낸다 (`--in` 의 브랜치 이름이나 `.` 을 풀 때만 읽기 요청을 하나 더 한다). 기본 출력은 짧은 글, `--json` 은 데몬이 돌려준 구조 그대로다.

- `term …`: 세션 만들기, 보내기, 읽기, 기다리기, 붙기. 세션 자리에는 `12`, `s12`, 칸 `p7`(그 칸의 세션), `.` 을 쓴다
  - `term read --tail N` 은 빈 줄을 뺀 마지막 N 줄, `--json` 은 `{"session":12,"lines":[…]}` 이다
  - `term wait --agent idle|working|attention` 은 에이전트가 그 상태가 될 때까지 이벤트로 기다린다. idle 은 이미 idle 이면 막 보낸 입력의 훅이 닿을 틈(1.5초)을 지켜보고, 그 사이 일을 시작하면 턴이 끝날 때까지 기다린다. 그래서 `term send p7 "…" --enter` 뒤에 바로 불러도 된다. 기다리는 동안 세션이 끝나면 종료 코드 1, 시간이 넘으면 124
- `pane …`: `split`, `resize`, `focus`, `move`, `swap`, `zoom`, `equalize`, `break`, `close`, `ls`. 칸은 `p7`, 생략하거나 `.` 이면 이 셸이 든 칸(`THUMINAL_SESSION_ID`)이다
- `tab …`: `new`, `select`, `close`, `rename`, `move`, `join`, `ls`. 탭은 `t3`. `tab new --title T` 는 탭 이름을 붙여 만든다
- 터미널을 만드는 명령은 세션 번호도 찍어 바로 `term send/read/wait` 에 넣을 수 있다: `tab new` → `t3 p7 s12`, `pane split` → `p8 s13`, `layout apply` → 칸마다 `p7 s12` 한 줄(문서 칸은 `p7 -`). `--json` 에는 `panes: [{pane, tab, session}]` 가 더 붙는다
- `layout show` / `layout apply '<한 줄>'`: 탭 배치를 한 줄로 보고 적용한다. 예: `row(claude, col(zsh, "npm run dev"):40%)`. 칸 자리의 `p7` 은 이미 있는 칸, 그 밖의 글은 새 셸에 입력할 명령(`zsh`, `_` 은 그냥 셸)이다. `show` 의 출력은 그대로 `apply` 에 다시 넣을 수 있다
- `browser open <주소>`: 앱 안 브라우저 탭을 연다 (스킴이 없으면 http:// 를 붙인다). `--beside p7` 이나 `--right` 류를 주면 그 칸 옆을 나눠 연다. 새 칸 번호를 찍는다
- `--in <대상>`: 워크트리 경로나 브랜치 이름, `floating`, `other`, `.`(이 셸의 workspace, 기본)
- `repo …`, `wt …`: 저장소 등록, 워크트리 만들기·지우기·상태. `wt rm --force` 는 워크트리만, `--delete-branch` 는 합친 브랜치만 지우고, 합치지 않은 브랜치는 `--force-branch` 를 줘야 지운다

## 화면 (`packages/ui`)

- **스택**: React + Tailwind v4 + shadcn(new-york, Radix) + phosphor 아이콘. shadcn 컴포넌트는 `components/ui/` 에 두고 아이콘만 phosphor 로 바꿔 쓴다. 상태는 zustand 하나(`store.ts` 의 `AppModel`)에 둔다.
- **상태의 주인**: 저장소, 워크트리, 세션, 배치는 데몬 것을 받아 들고만 있다. 배치는 데몬에 `layout` 요청을 보내고, 돌아온 배치(와 `layout_changed` 이벤트)로 바꿔 끼운다. 고른 워크트리, 열린 창, 플로팅 패널 자리, 테마 설정처럼 화면에만 있는 것은 앱이 정한다.
- **그림판**: 터미널 그림판(WebGL 렌더러)은 화면 면마다 하나다. 메인 면과 플로팅 패널이 각자 하나를 가진다. 칸 자리는 DOM 이 잡고 글자는 그 위 canvas 가 그린다.
- **끌어 놓기**: 탭을 칸 가장자리에 놓으면 `join_tab`, 칸을 탭 줄에 놓으면 `break_pane`, 칸을 칸에 놓으면 `move_pane`(가운데면 `swap`), 사이드바 카드에 놓으면 그 워크트리로 보낸다. 놓을 곳은 `data-drop-*` 속성으로 찾는다 (`dnd.ts`).
- **플로팅 워크스페이스**: 워크스페이스 `floating` 의 탭과 칸을 메인 창 위 패널에 그린다. 자리와 크기는 localStorage 에 남는다. 닫아도 세션은 데몬에서 계속 돈다.
- **브라우저 칸**: 문서 칸 종류 `{"kind":"browser","url":…}` 이다. 칸 자리는 DOM 이 잡고, 껍데기(Tauri, `unstable` 자식 웹뷰)가 그 자리에 진짜 WKWebView 를 얹는다 (`apps/desktop/src-tauri/src/browser.rs`). 웹뷰는 HTML 위에 그려지므로 메뉴·창이 열려 있거나 끄는 중이거나 플로팅 패널이 덮으면 잠깐 숨긴다. 페이지를 옮겨 다니면 `update_doc` 으로 주소를 배치에 남겨 다시 켜도 그 페이지로 연다. 페이지가 키보드를 잡고 있으면 앱 단축키가 메인 웹뷰로 오지 않으므로, 페이지마다 넣은 스크립트가 ⌘ 조합을 `thuminal-key://` 이동으로 바꾸고 껍데기가 그 이동을 가로채 메인 웹뷰에 넘긴다. 페이지에는 Tauri 명령 권한을 주지 않는다 (capabilities 는 메인 웹뷰만).
- **테마**: `packages/themes` 의 터미널 테마 하나로 화면 토큰(`<html>` CSS 변수), 앱 엔진 기본색, 데몬 기본색(`set_terminal_colors`)을 함께 맞춘다. "화면 색도 터미널 테마에 맞추기"를 끄면 화면은 무채색 다크/라이트 토큰을 쓴다. 테마 색 원본은 iTerm2-Color-Schemes(MIT)이고 출처는 `packages/themes/NOTICE` 에 적었다.

## 앱 번들

`scripts/build-app.sh` 가 `thuminal.app` 을 만든다. 데몬(`thuminald`)과 CLI(`thuminal`)가 `Contents/MacOS` 에 함께 들어가고, 앱과 CLI 는 자기 옆의 `thuminald` 를 띄운다. 개발할 때는 `pnpm dev` (데이터 폴더 `~/scratch/thuminal/main/dev-home`).
