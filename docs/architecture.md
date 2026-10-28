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
apps/desktop (Tauri 껍데기) ── packages/ui (React 화면, 폰 화면 MobileApp)
apps/web (브라우저 껍데기, 원격) ─┘    │
apps/android (WebView 껍데기) → apps/web 화면을 띄운다
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

plugins/claude-code/thuminal  (Claude Code 플러그인: 훅 → `thuminal agent report` → 데몬, thuminal 용 스킬 new-work · agenda-picker.
                               설치하지 않고 셸 통합의 `claude --plugin-dir` 로 thuminal 안의 실행에만 얹는다)
```

| 갈아끼우는 것 | 인터페이스 | 지금 어댑터 | 다른 후보 |
|---|---|---|---|
| 데몬 터미널 엔진 | `thuminal_engine::TerminalEngine` | `thuminal-engine-ghostty` (libghostty-vt) | vt100, alacritty_terminal |
| PTY | `thuminal_pty::PtySystem` | portable-pty | 직접 forkpty |
| 데몬 통신 | `thuminal_protocol` 프레임 + 유닉스 소켓 | 유닉스 소켓, 웹소켓(원격 접속) | TCP |
| 앱 터미널 엔진 | `term-core` 의 `TerminalEngine` | ghostty-vt.wasm | xterm.js 헤드리스 |
| 렌더러 | `term-core` 의 `Renderer` | WebGL2 글자 그림판 | WebGPU, Canvas |
| 앱 껍데기 | `term-core` 의 `HostApi` | Tauri, 브라우저(`apps/web`) | Electron |
| 버전 관리 | `thuminal_workspace::Vcs` | git 명령 | libgit2, jj |

## 데몬 (`thuminald`)

- **띄우기**: 클라이언트(앱, CLI)가 소켓에 붙지 못하면 데몬을 새 세션(`setsid`)으로 떼어 띄운다. 부모가 죽어도 데몬과 그 밑의 셸은 살아 있다.
- **한 개만**: 데이터 폴더의 `daemon-v{주버전}.lock` 을 `flock` 으로 잡는다. 이미 잡혀 있으면 뜨지 않는다.
- **세션**: 세션 하나는 PTY 하나와 엔진 하나다. 엔진은 세션 전용 스레드(actor)가 혼자 들고 있다. PTY 에서 읽은 바이트는 이 스레드가 엔진에 넣은 뒤 붙어 있는 클라이언트들에 보낸다. 붙기(attach)도 같은 스레드에서 처리하므로, 저장본을 만든 시점과 그 뒤 출력 사이에 빠지거나 겹치는 바이트가 없다.
- **터미널 질의 응답**: 셸이나 claude 가 커서 위치 같은 것을 물으면 데몬 엔진이 답한다. 앱이 붙어 있어도 앱 엔진은 답하지 않는다. 답이 두 번 가지 않게 하려는 것이다.
- **로그**: `logs/daemon.log` 에 JSON 한 줄씩 남긴다. 기능 사용(세션 만들기, 붙기, CLI 명령)도 `event` 필드로 남겨 나중에 어떤 기능을 많이 쓰는지 셀 수 있게 한다.

- **워크트리**: 저장소 목록(`workspace.json`)과 워크트리 만들기/지우기도 데몬이 맡는다. 그래야 CLI 로 만든 워크트리가 앱에도 바로 나타난다 (`workspace_changed` 이벤트). 새 워크트리는 저장소 옆 `<저장소>-thm-wt-<브랜치>` 에 만든다. 세션을 만들 때 시작 폴더가 워크트리 안이면 `worktree` 꼬리표를 단다.
  - 밖에서 바꾼 워크트리(`git worktree add` · `remove`, 폴더 지우기)는 데몬이 10초마다 목록을 견주어 알아채고 `workspace_changed` 를 낸다 (`daemon/src/worktree_watch.rs`). 폴더가 없는 워크트리는 목록에서 빼고, 거기 열려 있던 탭은 워크트리 밖(`other`)으로 옮기며 이름 기록을 지운다. 세션은 끝내지 않는다 (자기 워크트리를 지운 claude 가 그 탭에서 아직 돌 수 있다). 보던 워크트리가 없어지면 화면은 워크트리 밖으로 간다.
  - **하위 워크트리**: 워크트리마다 부모 워크트리를 기억한다 (`workspace.json` 의 워크트리 `parent`, `WorktreeInfo.parent`). `create_worktree { parent }` 나 `update_worktree { parent }`(빈 글이면 뗀다)로 정하고, 자기나 자기 밑의 워크트리를 부모로 삼으면 거절한다. 부모를 지우면 그 자식은 할아버지 밑으로 옮긴다. 사이드바는 자식을 부모 카드 밑에 들여 그리고 "N개 하위" 단추로 접는다. Orca 의 `worktreeLineageById` 도 가져온다. CLI 는 `thuminal wt new <브랜치> --parent <워크트리>`, 나중에 바꾸려면 `wt set <워크트리> --parent …`/`--no-parent`.
  - **워크스페이스**(사이드바 프로젝트 묶음, 코드·프로토콜에서는 `group`. `WorkspaceId` 와 다르다): `workspace.json` 의 `groups`(id, 이름, 든 저장소 id 차례)다. `list_groups` 로 읽고 `set_groups` 로 통째로 바꾸며, 바뀌면 `workspace_changed` 를 낸다. 데몬은 읽고 쓸 때마다 저장소 목록에 맞춘다: 기본 워크스페이스(`default`)는 늘 있고 지우지 못하며, 프로젝트는 꼭 한 워크스페이스에 들고, 어디에도 없는 프로젝트(새로 등록한 것, 지운 워크스페이스에 들었던 것)는 기본 끝에 붙는다. 프로젝트를 빼면 워크스페이스에서도 뺀다. 옛 파일에는 `groups` 가 없고 그때는 기본 하나에 모든 프로젝트다.
  - 지울 때 `force` 는 워크트리에만(바뀐 파일이 있어도), `force_branch` 는 브랜치에만(합치지 않았어도 `git branch -D`) 쓴다. `force_branch` 없이는 `git branch -d` 로 지우고, git 이 거절하면 브랜치를 남긴 채 워크트리만 지우고 성공으로 답한다. 답 `text` 에 "브랜치 X 는 합치지 않은 커밋이 있어 남겼다" 같은 까닭을 싣는다 (알릴 것이 없으면 빈 글).
- **셸 통합**: 데몬이 기본 셸을 띄울 때 zsh 는 `ZDOTDIR`, bash 는 `--rcfile` 로 thuminal 파일(`shell/`)을 먼저 읽힌다. 그 파일은 사용자 설정을 그대로 다 읽은 뒤 `claude` 함수를 더한다. 함수는 실행기 `shell/claude-launch` 를 부르고, 실행기가 `--plugin-dir` 로 thuminal claude 플러그인을 그 실행에만 얹는다. 실행기는 에이전트 설정(`agent-settings.json`, 설정 창 · 에이전트)이 바뀔 때마다 다시 쓴다: 권한 확인 없이(`--dangerously-skip-permissions`, 기본 켬), 에이전트 팀(기본 켬), 끈 스킬(`disabled_skills`). 실행기는 원본 플러그인 대신 데몬이 짠 `shell/claude-plugin` 을 얹는다. 그 폴더는 원본 항목마다 링크이고, `skills` 만 켠 스킬을 링크한 `skills.<번호>` 를 가리키는 링크다. 설정이 바뀌면 `skills` 링크만 바꿔 끼워 떠 있는 claude 의 훅 경로가 끊기지 않는다. `term new -- claude …` 도 실행기로 띄운다.
- **에이전트 팀**: 실행기가 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 과 함께 `TMUX`·`TMUX_PANE=%<세션>` 을 넣고 가짜 `tmux`(`shell/teams-bin/tmux` → `thuminal tmux`)를 claude 의 PATH 앞에 둔다 (진짜 tmux 안이면 그대로 둔다). claude 는 tmux 안이라고 믿고 팀원마다 `split-window … -- cat` → `set-option window-style fg=<색>` → `select-pane -T <이름>` → `respawn-pane -k -- <팀원 claude>` 를, 끝나면 `kill-pane` 을 부른다. 데몬(`teams.rs`)은 이것을 팀원 세션으로 흉내 낸다. 팀원은 칸 트리에 넣지 않고(`layout=none`) 꼬리표 `team.leader`·`team.pane`(claude 가 아는 칸 번호, 다시 띄워도 그대로)·`team.name`·`team.color` 로 리더에 묶는다. 리더 세션을 지우면 팀원도 지우고, 팀원이 코드 0 으로 끝나면 지운다. 팀원은 되살리지 않는다. 화면은 리더 터미널 폭을 그대로 두고, [팀원 N] 단추로 리더 칸 위에 팝업을 띄운다: 팀원 이름 목록 → 이름을 누르면 그 팀원 터미널 → [← 목록] (`ui/src/TeamPanel.tsx`). 팝업 안 터미널은 렌더러의 위층(`RenderTarget.layer`)이라, 아래층 리더가 다시 그린 프레임에는 겹치는 위층을 이어 다시 그린다.
- **에이전트**: claude 훅이 `thuminal agent report` 로 상태(일하는 중, 입력 기다림, 사용자 부름)와 claude 세션 id 를 알린다. 세션 정보의 `agent` 에 담긴다. 상태 규칙은 Orca 의 claude 훅 처리를 따른다.
  - 거는 훅: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, StopFailure, SessionEnd.
  - 일하는 중: UserPromptSubmit, PreToolUse, PostToolUse(Failure). 부름: PermissionRequest, 묻는 도구(AskUserQuestion)의 PreToolUse, Notification 의 `notification_type` 이 `permission_prompt`/`elicitation_dialog`. 기다림: Stop, StopFailure, SessionStart(compact 말고), Notification `idle_prompt`(일을 마치고 60초쯤 쉬면 온다. 부름이 아니다). 그 밖의 Notification 과 모르는 훅은 상태를 바꾸지 않는다. 권한을 승인하면 PostToolUse 가 와서 다시 일하는 중이 된다. 거절하면 훅이 오지 않아 다음 프롬프트까지 부름으로 남는다.
  - `agent` 에는 상태와 함께 마지막 프롬프트(`prompt`), 마지막 답(`last_assistant_message`, Stop 훅에 없으면 CLI 가 transcript 끝 256KB 에서 찾는다), 지금 도구(`tool_name`), 모델(`model`), 턴이 끝난 때(`turn_ended_at`)를 담는다. 글은 200자까지 자른다. `updated_at` 은 상태가 바뀐 때다. `turn_ended_at` 이 있고 idle 이면 끝남, 없이 idle 이면 막 떠서 기다리는 중이다. 바뀐 것이 있을 때만 `session_updated` 를 낸다.
  - `agent report` 는 thuminal 세션 밖이거나 데몬이 없으면 아무것도 하지 않고, 데몬에 붙기와 요청을 1초 안에 끝낸다. 에이전트를 막지 않는다.
- **찾기·파일 목록·줄 수**: `search_text`(git grep, 글 그대로, 무시하는 파일은 빼고, 500곳까지), `list_files`(`git ls-files -co --exclude-standard`), `git_line_counts`(`git diff --numstat` 작업 폴더·스테이지). 오래 걸릴 수 있어 `is_slow` 로 따로 돈다.
- **Orca 에서 가져오기**: `scan_orca` 요청으로 데몬이 Orca 상태 파일(`~/Library/Application Support/orca/profiles/<프로필>/profile-state.db`, 옛 판은 `orca-data.json`)을 `sqlite3 -readonly` 로 읽기만 한다 (`daemon/src/orca.rs`). 저장소, 워크트리 표시 이름·메모, 탭과 잠재운 에이전트 기록의 claude 세션 id 를 돌려준다. 세션은 `~/.claude/projects/*/<id>.jsonl` 이 있어야 하고 그 기록의 `cwd` 에서 이어 붙인다. `~/.claude/sessions/<pid>.json` 의 pid 가 살아 있으면 `running` 이다. 고른 것을 등록하고 새 탭에서 `claude --resume <id>` 를 치는 일은 앱이 한다 (사이드바 · Orca 에서 가져오기). 떠 있는 세션은 고를 때 "복사본"(`--fork-session`, Orca 쪽은 그대로) 이나 "옮겨 오기"(`stop_claude_session` 으로 그 claude 에 SIGTERM, 0.2초쯤에 기록을 남기고 끝난다) 중 하나로 가져온다.
- **벨과 알림**: 데몬 엔진이 BEL 을 받으면 세션 정보 `bell_at`(ms)을 바꾸고 `session_updated` 를, OSC 9 / OSC 777 데스크톱 알림을 받으면 `session_notification { session, title, body }` 를 낸다. 둘 다 세션마다 1초에 한 번까지다. 엔진은 `TerminalEngine::take_events` 로 벨과 알림을 내놓는다. 화면은 보고 있지 않은 칸이면 운영체제 알림을 띄운다. 데스크톱 앱은 `UNUserNotificationCenter` 로 직접 보내고(앱 이름 · 아이콘, 앱이 앞에 있어도 배너), 누르면 요청 id `thuminal-<세션>-<차례>` 의 세션 번호를 `thuminal://notification-click` 으로 화면에 넘겨 그 칸으로 간다. 이 API 는 서명된 `.app` 번들 안에서만 되므로 개발 앱은 cargo 실행기(`scripts/dev-app-runner.sh`)가 `target/debug/thuminal-dev.app`(번들 id `dev.thuminal.app.dev`)으로 묶어 임시 서명한 뒤 실행한다. 번들 밖에서 돌면 `osascript` 로 보낸다 (스크립트 편집기 이름으로 뜨고 눌러도 칸으로 가지 않는다).
- **리소스 · 포트** (`daemon/src/procs.rs`, minor 6): `list_processes` 가 `ps -A -o pid=,ppid=,pcpu=,rss=,args=` 한 번으로 부모 표를 만들어 세션마다 셸과 자손의 CPU · RSS 합계와 프로세스 목록(깊이 우선, 다른 세션 셸 밑은 그 세션 것)을, `lsof -nP -iTCP -sTCP:LISTEN -F pcn` 과 그 pid 들의 `lsof -d cwd` 로 LISTEN 포트를 낸다 (Orca 와 같다. 명령마다 4초 제한, 포트 읽기가 시간을 넘기면 15초 쉰다, 0.9초 안에 다시 물으면 앞서 읽은 것을 쓴다, 포트는 200개까지). 포트는 연 프로세스가 세션 셸의 자손이면 그 세션(`via: tree`, 워크트리는 그 세션 꼬리표), 아니면 작업 폴더가 워크트리 안(`cwd`), 명령줄에 워크트리 경로가 낱말로 든 것(`command`) 순으로 가장 긴 워크트리에 붙이고, 둘 다 아니면 밖(`external`)이다. 워크트리 목록은 등록한 저장소의 워크트리와 세션 꼬리표다. `stop_process { pid, port }` 는 다시 읽어 그 pid 가 아직 그 포트에서 LISTEN 이고 밖이 아닐 때만 SIGTERM 을 보낸다 (데몬 자신 · 다른 thuminald 는 거절).
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

## 원격 접속

폰이나 다른 컴퓨터 브라우저가 Tailscale 로 이 컴퓨터 데몬에 붙는다. Orca 의 웹 클라이언트·모바일 짝짓기와 같은 자리다.

- **서버는 데몬 안에 있다** (`daemon/src/remote.rs`). 앱을 꺼도 받는다. HTTP 하나가 웹 화면 파일(`apps/web` 빌드 결과, 앱 번들은 `Resources/web`)과 웹소켓 `/ws` 를 같이 낸다. 기본 포트 6780.
- **웹소켓 메시지 하나 = 프레임 하나**에서 길이 머리를 뗀 것(`[종류 u8][내용]`)이다. 데몬 안에서 파이프로 이어 유닉스 소켓 연결과 똑같이 처리하므로(`Server::serve_stream`) 원격 전용 프로토콜이 없다. 웹 껍데기(`apps/web/src/web-host.ts`)가 같은 요청을 TS 로 보낸다.
- **받는 주소**: 기본은 Tailscale 주소(100.64.0.0/10, fd7a:115c:a1e0::/48)와 127.0.0.1 만. Tailscale(WireGuard)이 길을 암호화하므로 TLS 를 두지 않는다 (Orca 는 같은 망에서도 쓰려고 웹소켓 안에 따로 암호화를 넣었다). "같은 Wi‑Fi 에서도 받기"를 켜면 0.0.0.0 에서 받고, 그때는 같은 망에서 내용이 보인다. Tailscale 이 나중에 켜지거나 주소가 바뀌면 15초 안에 맞춘다.
- **접속 토큰**: 컴퓨터마다 토큰(24바이트) 하나를 `remote.json`(0600)에 둔다. 주소는 `http://<Tailscale 주소>:6780/#token=…` 이고 설정 창이 늘 QR 과 함께 보인다. [토큰 바꾸기](`rotate_remote_token`)는 새 토큰을 만들고 붙어 있던 원격 연결을 모두 끊는다. 예전에 기기마다 만든 토큰(`devices`)도 토큰을 바꾸기 전까지는 받는다. 웹 화면은 토큰을 그 브라우저 localStorage 에 옮기고 주소에서 지운다. 웹소켓·`/api/*` 는 토큰이 맞아야 열고, 화면 파일은 토큰 없이 낸다. 예전 기기 토큰을 지우면 그 연결을 바로 끊는다. 원격 연결은 원격 설정 요청(`set_remote`, `pair_remote`, `rotate_remote_token`, `remove_remote_device`)을 받지 않는다.
- **브라우저 칸 대리**: 웹 · 폰 · 다른 PC 앱은 데스크톱의 브라우저 칸 웹뷰를 볼 수 없으므로, 칸 주소가 데몬 컴퓨터의 http `localhost` 개발 서버면 데몬이 대신 받아 넘긴다 (`daemon/src/browser_proxy.rs`, 요청 `browser_proxy`). 대상마다 원격 접속 포트 다음의 빈 포트를 같은 받는 주소에 열고(경로를 붙이지 않아 페이지의 절대 경로가 그대로 맞는다), `Host` · `Origin` 을 원래 주소로 바꿔 넘기며 웹소켓(HMR)도 잇는다. 처음 열 때 주소의 `thuminal_proxy=<기기 토큰>` 을 같은 이름의 쿠키로 바꿔 두고, 쿠키가 맞아야 넘긴다. 칸 안에 띄우도록 응답의 `X-Frame-Options` · CSP `frame-ancestors` 를 뺀다. 웹 · 폰은 칸 자리에 iframe 으로 띄우고(`BrowserPane` `FramePane`), 다른 PC 앱은 웹뷰가 대리 주소를 열고 알려 온 주소를 원래 주소로 되돌려 남긴다 (`tauri-host.ts`). 공개 https 주소는 대리 없이 그대로 연다.
- **파일 내용**: `/api/file?worktree=…&file=…` 이 워크트리 안 파일을 낸다 (웹 화면의 그림 · 영상 · 소리). `Range` 를 받으면 그 구간만 206 으로 내고, 경로 검사는 데몬 요청 `read_file_bytes` 와 같다.
- **글꼴**: 폰에는 Nerd Font 가 없어 프롬프트 기호가 깨지므로 `/api/fonts`·`/api/font/<열쇠>` 가 데스크톱에 설치된 글꼴 파일을 낸다. 열쇠는 파일 경로 · 크기 · 고친 때로 만들어 데몬이 다시 떠도 같아서, 브라우저가 글꼴을 오래 캐시한다 (`immutable`). 글꼴과 웹 화면 파일은 gzip 으로 줄여 보낸다.
- **화면**: 넓으면 데스크톱과 같은 화면, 좁으면 폰 화면(`ui/src/MobileApp.tsx`: 에이전트 목록 → 워크트리 → 터미널, 키 줄·입력 줄). `?ui=mobile|desktop` 으로 고정한다. 안드로이드 키보드는 모든 키를 keyCode 229 로 보내므로 지우기·Enter 를 `input` 이벤트(`deleteContentBackward`, `insertLineBreak`)로 받는다.
- **세션 크기**: 마지막으로 입력한(누른) 화면 크기를 따른다 (tmux `window-size latest`). 다른 화면이 크기를 가져가면 데스크톱 칸 오른쪽 위에 "다른 기기 크기로 그려지는 중 · 되돌리기"가 뜬다.
- **안드로이드 앱**(`apps/android`, Java, 의존성은 Play 서비스 QR 찍기 하나): WebView 로 웹 화면을 띄우는 얇은 껍데기다. QR 찍기·주소 붙여 넣기·`thuminal://open?url=…` 로 주소를 받아 남기고, 뒤로 가기·클립보드·접속 정보 지우기를 `window.ThuminalApp` 으로 이어 준다. Orca 는 Expo(React Native) 앱이지만 터미널은 그 안 WebView 의 xterm.js 이고 화면 일부도 데스크톱이 내는 웹 묶음을 WebView 로 그린다. thuminal 은 그 웹 부분만 남겨 데스크톱이 화면을 모두 내게 했다 (앱을 다시 깔지 않아도 화면이 바뀐다). `scripts/build-android.sh` 가 만들어 `apps/web/public/download/thuminal.apk` 에 두고, 데몬이 `/download/thuminal.apk` 로 낸다.

### 원격 호스트 (데스크톱 앱이 다른 컴퓨터 데몬에 붙기)

데스크톱 앱이 Tailscale 로 다른 맥의 데몬에 붙는다. 폰 웹 화면과 같은 `/ws` 와 토큰을 쓴다 (원격 컴퓨터에서 이 앱을 기기로 등록한다).

- **전송**: `thuminal-client` 의 `Client::connect_ws(base, token)` 가 웹소켓 메시지를 바이트 줄(duplex)로 바꿔 유닉스 소켓과 같은 `Client` 를 만든다 (`client/src/ws.rs`). 데몬 핑이 60초 동안 없으면 끊는다. hello 에서 주 판이 다르면 거절(`VersionMismatch`), 부 판이 다르면 `version_warning`.
- **다시 붙기**: `link::Link` 가 호스트마다 감독 작업을 돌린다. 0.25초에서 30초까지 두 배씩 기다리며 다시 붙고, 토큰이 틀리면(401) 멈추고, 주 판이 다르면 30초마다 본다. 붙을 때마다 `generation` 이 는다.
- **등록**: 원격의 짝짓기 주소(`http://100.x.y.z:6780/#token=…`)를 설정 창 · 원격 컴퓨터에 붙여 넣는다. Tailscale 주소(100.64.0.0/10, fd7a:115c:a1e0::/48)와 시험용 127.0.0.1 만 받는다 (`ws::parse_pair_url`). 붙어 보고 되면 데이터 폴더 `hosts.json`(0600)에 id·이름·주소·토큰을 남긴다.
- **Tauri**: `AppState` 가 로컬 `Client` 와 원격 호스트 id → `Link` 맵을 든다. 데몬에 닿는 명령은 `host`(없으면 로컬)를 받고, 붙기·이벤트 채널도 호스트마다 따로다. 원격이 다시 붙으면 그 호스트 채널에 `daemon_reconnected` 를 보낸다. 호스트 관리는 `hosts_list|subscribe|add|remove|reconnect`.
- **화면 쪽 API**: 로컬 `TauriHostApi` 의 `hosts`(term-core `RemoteHostsApi`)가 목록·등록·지우기·상태를 맡고, `hosts.forHost(id)` 가 그 호스트로 보내는 `HostApi`(`isRemote` true, `hostId`)를 준다. 원격이면 Finder·기본 앱·폴더 고르기는 오류이고, 터미널 색은 보내지 않는다 (원격 설정 그대로). 알림·배지·글꼴·배율·파일 끌어 놓기는 창 하나의 기능이라 로컬과 같다. 브라우저 칸은 칸 번호가 호스트마다 따로라 웹뷰 이름(`browser-<호스트>-<칸>`)과 이벤트 이름(`thuminal://browser/<호스트>`)에 호스트를 넣는다. 웹뷰는 이 컴퓨터에 뜨므로 원격 칸의 `localhost` 는 이 컴퓨터를 가리킨다.
- **한 창에 여러 호스트**: 세션·칸·탭 번호와 워크트리 경로는 호스트마다 따로 센다. 그래서 화면은 호스트마다 `AppModel` 을 하나씩 둔다 (로컬이 root, 원격은 root 가 `hosts.onChange` 에 맞춰 만들고 없앤다). 창 전체 상태(`WINDOW_KEYS`: 테마·글꼴·배율·플로팅·키보드 자리·열린 창·알림 설정·사이드바·오른쪽 패널·읽은 때·최근 목록·고른 호스트·원격 목록·오류 띠)는 root 가 들고 자식 store 에 그대로 비추며, 자식이 그 키를 바꾸면 root 로 보낸다. 고른 곳은 (`activeHost`, 그 모델의 `active`) 이고, 읽은 때·최근 목록·방문 기록 키는 `placeKey`(원격은 `<호스트>|<워크스페이스>`)다. 화면은 `ModelContext` 를 호스트별로 감싼다 (사이드바 원격 칸은 그 호스트 모델, 메인 면·오른쪽 사이드바는 고른 호스트 모델, 열린 창은 연 호스트 모델). 끌어 놓기는 가장 가까운 `data-host` 가 같을 때만 된다. 플로팅 패널은 로컬 것만이다. 알림은 root 껍데기로 띄우고, 원격 세션은 따로 센 번호(10억부터)를 실어 누르면 그 호스트 세션으로 간다. 원격이 처음 붙으면 그 모델이 읽고, 다시 붙으면(`daemon_reconnected`) 터미널을 모두 놓고 저장본으로 다시 그린다.

## 데이터 폴더

`~/Library/Application Support/thuminal/` (환경 변수 `THUMINAL_HOME` 으로 바꿀 수 있다. 시험은 임시 폴더를 쓴다).

```
daemon-v1.sock      데몬 소켓
daemon-v1.lock      한 개만 뜨게 하는 잠금 + pid
logs/daemon.log     JSON 한 줄 로그
workspace.json      등록한 저장소, 워크트리 이름·고정·부모, 사이드바 워크스페이스(groups)
sessions-v1.json    되살릴 세션 정보
sessions/<번호>.vt  되살릴 화면 저장본
layout-v1.json      탭과 칸 배치, 다음 칸·탭 번호 (바뀌고 1초 안에 쓴다. daemon stop 이면 지운다)
terminal-colors.json 터미널 기본색 (앱 테마)
agent-settings.json  에이전트를 띄울 때 붙일 옵션 (설정 창 · 에이전트)
remote.json         원격 접속 설정과 접속 토큰 (0600)
hosts.json          데스크톱 앱이 붙는 원격 호스트 id·이름·주소·토큰 (0600, 앱이 쓴다)
shell/              셸 통합 파일, claude 실행기(claude-launch), 에이전트 팀용 가짜 tmux(teams-bin/tmux)
```

## CLI (`thuminal`)

명령마다 데몬에 한 번 붙는다. 바꾸는 명령은 대상을 데몬이 풀도록 칸 번호나 세션으로 보내 요청 하나로 끝낸다 (`--in` 의 브랜치 이름이나 `.` 을 풀 때만 읽기 요청을 하나 더 한다). 기본 출력은 짧은 글, `--json` 은 데몬이 돌려준 구조 그대로다.

- `term …`: 세션 만들기, 보내기, 읽기, 기다리기, 붙기. 세션 자리에는 `12`, `s12`, 칸 `p7`(그 칸의 세션), `.` 을 쓴다
  - `term read --tail N` 은 빈 줄을 뺀 마지막 N 줄, `--json` 은 `{"session":12,"lines":[…]}` 이다
  - `term wait --agent idle|working|attention` 은 에이전트가 그 상태가 될 때까지 이벤트로 기다린다. idle 은 이미 idle 이면 막 보낸 입력의 훅이 닿을 틈(1.5초)을 지켜보고, 그 사이 일을 시작하면 턴이 끝날 때까지 기다린다. 그래서 `term send p7 "…" --enter` 뒤에 바로 불러도 된다. `--enter` 는 글을 보내고 300ms 뒤, 화면에 글이 찍히기를 기다렸다가(최대 3초) Enter 를 따로 보낸다 (글과 Enter 가 한 번에 읽히면 claude 가 붙여넣기로 받아 Enter 를 줄바꿈으로 넣는다. 막 뜬 claude 는 바빠 두 번 보낸 것도 한 번에 읽는다). 기다리는 동안 세션이 끝나면 종료 코드 1, 시간이 넘으면 124
- `pane …`: `split`, `resize`, `focus`, `move`, `swap`, `zoom`, `equalize`, `break`, `close`, `ls`. 칸은 `p7`, 생략하거나 `.` 이면 이 셸이 든 칸(`THUMINAL_SESSION_ID`)이다
- `tab …`: `new`, `select`, `close`, `rename`, `move`, `join`, `ls`. 탭은 `t3`. `tab new --title T` 는 탭 이름을 붙여 만든다
- 터미널을 만드는 명령은 세션 번호도 찍어 바로 `term send/read/wait` 에 넣을 수 있다: `tab new` → `t3 p7 s12`, `pane split` → `p8 s13`, `layout apply` → 칸마다 `p7 s12` 한 줄(문서 칸은 `p7 -`). `--json` 에는 `panes: [{pane, tab, session}]` 가 더 붙는다
- `layout show` / `layout apply '<한 줄>'`: 탭 배치를 한 줄로 보고 적용한다. 예: `row(claude, col(zsh, "npm run dev"):40%)`. 칸 자리의 `p7` 은 이미 있는 칸, 그 밖의 글은 새 셸에 입력할 명령(`zsh`, `_` 은 그냥 셸)이다. `show` 의 출력은 그대로 `apply` 에 다시 넣을 수 있다
- `browser open <주소>`: 앱 안 브라우저 탭을 연다 (스킴이 없으면 http:// 를 붙인다). `--beside p7` 이나 `--right` 류를 주면 그 칸 옆을 나눠 연다. 새 칸 번호를 찍는다
- `--in <대상>`: 워크트리 경로나 브랜치 이름, `floating`, `other`, `.`(이 셸의 workspace, 기본)
- `ps [-a] [--json]`: 세션마다 셸 pid · CPU · 메모리 · 연 포트(`-a` 면 그 밑 프로세스까지), 데몬 자신, LISTEN 포트와 붙인 곳(세션 · 워크트리 · 근거). 요청 `list_processes` 하나와 제목을 찍을 세션 목록 하나
- `remote status|on|off|url|rotate|rm <id>`: 원격 접속 켜기·끄기, 접속 주소 보기(`pair` 도 같다), 토큰 바꾸기, 예전 기기 토큰 지우기
- `repo …`, `wt …`: 저장소 등록, 워크트리 만들기·지우기·상태. `wt rm --force` 는 워크트리만, `--delete-branch` 는 합친 브랜치만 지우고, 합치지 않은 브랜치는 `--force-branch` 를 줘야 지운다. `wt new --name` · `wt set --name/--pin/--unpin` 은 사이드바 이름·고정을 바꾼다 (`update_worktree`)

## 화면 (`packages/ui`)

- **스택**: React + Tailwind v4 + shadcn(new-york, Radix) + phosphor 아이콘. shadcn 컴포넌트는 `components/ui/` 에 두고 아이콘만 phosphor 로 바꿔 쓴다. 상태는 zustand 하나(`store.ts` 의 `AppModel`)에 둔다.
- **상태의 주인**: 저장소, 워크트리, 세션, 배치는 데몬 것을 받아 들고만 있다. 배치는 데몬에 `layout` 요청을 보내고, 돌아온 배치(와 `layout_changed` 이벤트)로 바꿔 끼운다. 고른 워크트리, 열린 창, 플로팅 패널 자리, 테마 설정처럼 화면에만 있는 것은 앱이 정한다.
- **그림판**: 터미널 그림판(WebGL 렌더러)은 화면 면마다 하나다. 메인 면과 플로팅 패널이 각자 하나를 가진다. 칸 자리는 DOM 이 잡고 글자는 그 위 canvas 가 그린다.
- **사이드바 워크스페이스**: 워크스페이스 → 프로젝트 → 워크트리 세 단계다 (`Sidebar.tsx`, 묶음 칸은 `GroupSection.tsx`, 계산은 `groups.ts`). 기본 하나뿐이면 머리를 감춰 프로젝트만 늘어놓는다. "+ 워크스페이스" 로 만들고, 머리 메뉴로 이름·차례·지우기, 프로젝트 머리를 끌거나 프로젝트 메뉴 "워크스페이스로 옮기기" 로 옮긴다. 접은 상태는 다른 묶음처럼 localStorage 에 남는다. 폰 화면은 머리 아래 묶어 보이기만 한다. `GroupSection` 의 `remote` 를 주면 원격 컴퓨터 워크스페이스(컴퓨터 표시·연결 상태 배지, 끌어 넣기·이름 고치기 막음)로 그린다. 원격 컴퓨터마다 그 이름의 고정 워크스페이스가 내 워크스페이스들 아래에 하나씩 붙고, 그 컴퓨터의 프로젝트·워크트리는 모두 그 안에만 든다 (옮기기·Finder 메뉴 없음). 머리 메뉴에 "다시 붙기"·"설정에서 다시 등록". 원격 컴퓨터가 하나라도 있으면 기본 하나뿐이어도 워크스페이스 머리를 보인다.
- **끌어 놓기**: 탭을 칸 가장자리에 놓으면 `join_tab`, 칸을 탭 줄에 놓으면 `break_pane`, 칸을 칸에 놓으면 `move_pane`(가운데면 `swap`), 사이드바 카드에 놓으면 그 워크트리로 보낸다. 놓을 곳은 `data-drop-*` 속성으로 찾는다 (`dnd.ts`).
- **플로팅 워크스페이스**: 워크스페이스 `floating` 의 탭과 칸을 메인 창 위 패널에 그린다. 자리와 크기는 localStorage 에 남는다. 닫아도 세션은 데몬에서 계속 돈다.
- **브라우저 칸**: 문서 칸 종류 `{"kind":"browser","url":…}` 이다. 칸 자리는 DOM 이 잡고, 껍데기(Tauri, `unstable` 자식 웹뷰)가 그 자리에 진짜 WKWebView 를 얹는다 (`apps/desktop/src-tauri/src/browser.rs`). 웹뷰는 HTML 위에 그려지므로 메뉴·창이 열려 있거나 끄는 중이거나 플로팅 패널이 덮으면 잠깐 숨긴다. 페이지를 옮겨 다니면 `update_doc` 으로 주소를 배치에 남겨 다시 켜도 그 페이지로 연다. 페이지가 키보드를 잡고 있으면 앱 단축키가 메인 웹뷰로 오지 않으므로, 페이지마다 넣은 스크립트가 ⌘ 조합을 `thuminal-key://` 이동으로 바꾸고 껍데기가 그 이동을 가로채 메인 웹뷰에 넘긴다. 페이지에는 Tauri 명령 권한을 주지 않는다 (capabilities 는 메인 웹뷰만).
- **파일 칸**: 문서 칸 종류 `{"kind":"file","file":…}` 이다. Markdown 은 [미리보기 | 원문] 을 고르고, 원문 보기가 곧 편집기(CodeMirror 6)다. ⌘S 로 데몬 `write_file` 에 통째로 쓰고, 읽을 때 받은 바뀐 때(`modified`)를 같이 보내 그사이 다른 곳(claude 등)이 고쳤으면 데몬이 `conflict` 로 거절한다. 저장하지 않은 글은 칸 밖에 남아 칸을 닫았다 다시 열어도 이어진다 (앱을 끄면 사라진다). 그림 · 영상 · 소리는 껍데기가 정한 주소(`files.mediaUrl`)로 띄운다: 데스크톱은 `thuminal-file://` (`src-tauri/src/media.rs` 가 `Range` 를 데몬 `read_file_bytes` 조각 읽기로 바꾼다. 원격 컴퓨터 파일도 그 연결로), 웹은 데몬 `/api/file`. 옛 데몬은 이 요청을 모르면 연결을 끊으므로, 화면은 데몬 부 판이 `FILES_PROTOCOL_MINOR`(5) 이상일 때만 보낸다.
- **오른쪽 사이드바**: 단추 하나(⌘L)로 열고 닫고, 안쪽 위 탭으로 파일(⌘⇧E, 트리 + 이름 거르기) · 변경(⌘⇧G, 스테이지됨 · 변경 · 새 파일, 줄 수, 워크트리별 커밋 메시지 초안) · 검색(⌘⇧F, 내용 찾기 → 그 줄로 파일 열기, 문서 칸 `line`)을 오간다. 왼쪽 경계를 끌어 폭을 바꾸고 폭과 마지막 탭은 localStorage 에 남는다 (Orca 와 같은 단축키).
- **리소스 관리자 · 포트** (`ui/src/ResourceManager.tsx`, `ports-ui.tsx`, 읽기는 `processes.ts`): 사이드바 맨 아래 줄 설정 단추 옆 [리소스] 단추(메모리 합계 · 세션 수)가 팝오버를 연다. 리소스만 본다: 저장소 → 워크트리 → 세션 트리의 CPU · 메모리(이름 · CPU · 메모리 정렬, 기본 메모리 내림차순). 세션을 펼치면 그 밑 프로세스(pid · 명령 · CPU · 메모리), 누르면 그 칸으로 간다. [세션 끝내기] 는 칸에 든 세션이면 칸을 닫고(아니면 `remove`), 칸에 들었거나 에이전트가 떠 있으면 팝오버 안에서 먼저 묻는다. 포트는 세션 아이콘(탭 · 칸 머리 · 사이드바 세션 줄. 일반 터미널에도 터미널 아이콘을 두고, 포트가 있으면 밝게 칠한다)에 마우스를 올리거나 우클릭하면 그 세션이 연 포트 팝업으로 보인다. 같은 워크트리에서 어느 세션에도 붙지 않은 포트(`cwd` · `command`. claude 가 백그라운드로 실행해 셸에서 떨어져 나간 서버)는 그 워크트리 모든 세션의 팝업 아래 "이 워크트리 · 세션 밖에서 실행" 으로 함께 보인다. 줄마다 [브라우저로 열기] · [주소 복사] · [프로세스 멈추기](멈춘 뒤 바로 · 0.5초 뒤 다시 읽는다). 워크트리 밖 포트(밖)는 화면 어디에도 보이지 않는다 (`thuminal ps` 에만 나온다). 열기는 앱 안 브라우저 칸(그 세션 · 워크트리 워크스페이스), ⇧⌘클릭은 시스템 브라우저다. `0.0.0.0` · `::` · `127.0.0.1` · `[::1]` 은 localhost, 443 · 8443 은 https 로 연다. 호스트마다 읽는 곳 하나를 두고 30초, 팝오버가 열려 있으면 2초마다 읽으며 창이 숨으면 쉰다. 옛 데몬은 모르는 요청에 연결을 끊으므로 데몬 부 버전이 `PROCESSES_PROTOCOL_MINOR`(6) 이상일 때만 보내고, 아니면 "데몬을 다시 시작하면 볼 수 있어요" 를 보인다.
- **에이전트 아이콘**: `agent-icons.tsx` (Orca MIT 아이콘, 출처는 `packages/ui/NOTICE`).
- **테마**: `packages/themes` 의 터미널 테마 하나로 화면 토큰(`<html>` CSS 변수), 앱 엔진 기본색, 데몬 기본색(`set_terminal_colors`)을 함께 맞춘다. "화면 색도 터미널 테마에 맞추기"를 끄면 화면은 무채색 다크/라이트 토큰을 쓴다. 테마 색 원본은 iTerm2-Color-Schemes(MIT)이고 출처는 `packages/themes/NOTICE` 에 적었다.

## 앱 번들

`scripts/build-app.sh` 가 `thuminal.app` 을 만든다. 데몬(`thuminald`)과 CLI(`thuminal`)가 `Contents/MacOS` 에 함께 들어가고, 앱과 CLI 는 자기 옆의 `thuminald` 를 띄운다. 원격 접속 웹 화면은 `Contents/Resources/web` 에 들어간다 (Android SDK 가 있으면 안드로이드 앱도 그 안 `download/` 에). 개발할 때는 `pnpm dev` (데이터 폴더 `~/scratch/thuminal/main/dev-home`).
