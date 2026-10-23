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
      │                              └─ packages/renderer-webgl (렌더러 어댑터)
      ▼
crates/thuminal-client ──── crates/thuminal-cli (thuminal 명령)
      │  (프로토콜 + 전송)
      ▼
crates/thuminal-daemon (thuminald)
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
- **셸 통합**: 데몬이 기본 셸을 띄울 때 zsh 는 `ZDOTDIR`, bash 는 `--rcfile` 로 thuminal 파일(`shell/`)을 먼저 읽힌다. 그 파일은 사용자 설정을 그대로 다 읽은 뒤 `claude` 함수를 더한다. 함수는 `--plugin-dir` 로 thuminal claude 플러그인을 그 실행에만 얹는다.
- **에이전트**: claude 훅이 `thuminal agent report` 로 상태(일하는 중, 입력 기다림, 사용자 부름)와 claude 세션 id 를 알린다. 세션 정보의 `agent` 에 담긴다.
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
```

## 앱 번들

`scripts/build-app.sh` 가 `thuminal.app` 을 만든다. 데몬(`thuminald`)과 CLI(`thuminal`)가 `Contents/MacOS` 에 함께 들어가고, 앱과 CLI 는 자기 옆의 `thuminald` 를 띄운다. 개발할 때는 `pnpm dev` (데이터 폴더 `~/scratch/thuminal/main/dev-home`).
