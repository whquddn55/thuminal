# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

thuminal 은 Orca 를 다시 만드는 macOS 앱이다: 워크트리마다 터미널·claude·브라우저 칸을 띄우고, 앱을 꺼도 터미널은 데몬 밑에서 계속 돈다. 구조와 설계 이유는 `docs/architecture.md` 가 원본이다. 이 파일은 그 위에서 일할 때 알아야 할 것만 적는다.

## 명령

```sh
mise install                         # Zig 0.16 (libghostty-vt 빌드용). cargo 는 반드시 mise exec 로
pnpm install
pnpm dev                             # 사이드카(thuminald, thuminal) 디버그 빌드 + tauri dev. 데이터 폴더 ~/scratch/thuminal/main/dev-home
mise exec -- cargo test --workspace
mise exec -- cargo test -p thuminal-layout browser_doc      # 크레이트 하나, 이름으로 시험 하나
mise exec -- cargo clippy --workspace --all-targets
pnpm test                            # vitest (지금은 packages/engine-ghostty-wasm 에만 있다. themes 시험도 거기 test/ 에 있다)
pnpm -C packages/engine-ghostty-wasm exec vitest run -t "조합"   # 이름으로 시험 하나
pnpm -r typecheck
scripts/build-app.sh                 # target/release/bundle/macos/thuminal.app
scripts/release.sh 0.2.0             # 버전을 올려 커밋 · 태그. git push origin main v0.2.0 → Release 워크플로가 세 OS 설치본 · 업데이트 파일을 초안 Release 에 올린다. 게시해야 앱 업데이트에 잡힌다
pnpm -C apps/web build               # 원격 접속 웹 화면 (데몬이 apps/web/dist 를 낸다)
scripts/build-android.sh             # 안드로이드 앱 → apps/web/public/download/thuminal.apk (JDK 17·21, ~/Library/Android/sdk)
```

- CLI 를 개발 데몬에 대고 돌릴 때: `THUMINAL_HOME=~/scratch/thuminal/main/dev-home target/debug/thuminal pane ls --all`. `THUMINAL_HOME` 이 없으면 기본 폴더(`~/Library/Application Support/thuminal`)의 다른 데몬을 본다.
- 데몬 코드를 바꾼 뒤: `cargo build -p thuminald -p thuminal-cli && scripts/prepare-sidecars.sh debug` 하고 데몬에 `SIGTERM`(예: `pkill -TERM -f "thuminald --home …dev-home"`). 앱이 새 데몬을 띄우고, 세션은 화면 저장본으로 되살아나며 claude 는 `--resume` 으로 이어진다. `thuminal daemon stop` 은 세션 기록을 지우므로 되살아나지 않는다.
- 업데이트 서명 키는 `~/.tauri/thuminal.key`(암호는 macOS 키체인 `thuminal-updater-key`), CI 는 GitHub secret `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` 를 쓴다. 키를 잃으면 이미 설치된 앱이 다음 버전을 받지 못한다.
- 시험은 사용자의 dev-home 세션에 입력을 보내지 말고 따로 띄운 데몬(`target/debug/thuminald --home <임시 폴더>`)에서 한다.

## 큰 그림

```
apps/desktop (Tauri) ── packages/ui (React)        ← 화면. 데몬 것을 받아 그리기만 한다
     │ HostApi 구현        ├ term-core (인터페이스·프로토콜 TS 타입)
     │                    ├ engine-ghostty-wasm, renderer-webgl, themes
     ▼
crates/thuminal-client ── crates/thuminal-cli (thuminal 명령)
     ▼ 유닉스 소켓, 프레임 [길이 u32][종류 u8][내용]
crates/thuminal-daemon (thuminald) ── thuminal-layout, thuminal-engine(-ghostty), thuminal-pty(-portable), thuminal-workspace(+vcs-git)
plugins/claude-code/thuminal  ← claude 훅 → `thuminal agent report` → 데몬
```

- **바깥 기술은 인터페이스 뒤에 있다.** 엔진·PTY·git·렌더러·앱 껍데기는 trait/interface 로 정의하고 어댑터는 따로 둔다. 어댑터를 고르는 곳은 `crates/thuminald/src/main.rs`, `apps/desktop/src/main.tsx`, `apps/web/src/main.tsx` 뿐이다.
- **배치(탭·칸 트리·크기·포커스)의 주인은 데몬이다.** 앱과 CLI 는 `layout` 요청(`LayoutOp`)을 보내고, 데몬이 `thuminal-layout` 으로 트리를 바꾼 뒤 `layout_changed` 이벤트로 알린다. 앱은 돌려받은 배치를 통째로 바꿔 끼운다. 새 터미널이 필요한 op 는 데몬이 세션을 먼저 띄우고, 실패하면 배치를 되돌린다. 배치는 `layout-v1.json` 에 남고, 데몬이 다시 뜨면 `restored_from` 으로 옛 세션 번호를 새 번호로 바꿔 끼운다.
- **workspace** 는 워크트리 절대 경로, `"floating"`(플로팅 패널), `"other"`(워크트리 밖) 중 하나다. `CreateSession` 으로 만든 세션은 꼬리표(`worktree`, `floating`)로 정한 workspace 의 새 탭에 들어간다.
- **칸 내용**은 `terminal { session }` 또는 `doc { doc: map }` 이다. 문서 칸 종류는 `doc.kind` 로 가른다: `diff`, `file`, `browser`(`url`). 데몬은 doc 의 뜻을 모른다.
- **세션 하나 = PTY 하나 + 엔진 하나**, 세션 전용 스레드(actor)가 엔진을 혼자 든다 (`daemon/src/session.rs`). 터미널 질의(커서 위치, OSC 10/11 색 등)는 데몬 엔진만 답한다. 앱 엔진은 답하지 않는다.
- **에이전트 상태**는 claude 훅이 알려 준다. 훅 이벤트 → 상태 규칙은 `daemon/src/manager.rs` 의 `next_agent` 에 있고, 세션 환경의 `THUMINAL_HOME`·`THUMINAL_SESSION_ID`·`THUMINAL_CLI` 로 그 데몬에 닿는다. claude 는 셸 함수가 부르는 실행기 `shell/claude-launch` 가 `--plugin-dir` 로 이 플러그인을 그 실행에만 얹고, 에이전트 설정(권한 옵션·팀)을 붙인다 (`daemon/src/shell.rs`).
- **원격 접속**: 데몬이 Tailscale 주소(기본 6780)에서 웹 화면과 웹소켓 `/ws` 를 낸다 (`daemon/src/remote.rs`). 웹소켓 메시지 하나가 길이 머리를 뗀 프레임 하나라 유닉스 소켓과 같은 처리(`Server::serve_stream`)를 탄다. 기기마다 토큰(`remote.json`). 웹 껍데기는 `apps/web`(HostApi = `web-host.ts`), 좁은 화면은 `ui/src/MobileApp.tsx`, 안드로이드 앱(`apps/android`)은 그 웹 화면을 띄우는 WebView 껍데기다. 세션 크기는 마지막으로 입력한 화면을 따른다 (`TerminalController.claimSize`).
- **원격 호스트**: 데스크톱 앱이 다른 컴퓨터 데몬에도 붙는다 (`hosts.json`, Tauri 명령마다 `host`). 화면은 호스트마다 `AppModel` 하나(로컬이 root)이고, 창 전체 상태(`WINDOW_KEYS`)는 root 가 들고 자식이 비춘다. 고른 곳은 (`activeHost`, 그 모델 `active`), 읽은 때·최근 키는 `placeKey`(`<호스트>|<ws>`). 끌어 놓기는 같은 `data-host` 안에서만.
- **에이전트 팀**: claude 에게 가짜 tmux 를 보여 팀원 칸 명령(`split-window`, `respawn-pane`, `kill-pane` …)을 데몬이 받는다 (`daemon/src/teams.rs`). 팀원은 칸 트리에 없는 세션이고(`layout=none`, 꼬리표 `team.*`), 화면은 리더 칸 위 팝업(목록 → 팀원 터미널)으로 그린다 (`ui/src/TeamPanel.tsx`). 터미널끼리 겹치면 `RenderTarget.layer` 가 큰 것을 위에 그린다.

### 화면 (`packages/ui`)

- shadcn(new-york, Radix, `components/ui/`) + Tailwind v4 + phosphor 아이콘. 상태는 zustand 하나: `store.ts` 의 `AppModel` (컴포넌트는 `useApp(selector)`, 동작은 `useModel()`). 터미널 컨트롤러(엔진·붙기)는 상태가 아니라 zustand 밖에 둔다.
- 터미널 그림판(WebGL 렌더러)은 **면마다 하나**다 (메인 면, 플로팅 패널). 칸 자리는 DOM 이 잡고 글자는 그 위 canvas 가 그린다. 칸이 옮겨지면 `renderer.layout()` 을 불러야 자리가 다시 잡힌다.
- 끌어 놓기는 pointer 이벤트로 직접 한다 (`dnd.ts`). 놓을 곳은 `data-drop-pane`, `data-drop-tabbar`(+`data-tab-index`), `data-drop-workspace` 속성으로 찾는다.
- **브라우저 칸**은 Tauri `unstable` 자식 웹뷰(진짜 WKWebView)를 칸 자리에 얹는다 (`src-tauri/src/browser.rs`, `ui/src/BrowserPane.tsx`). 네이티브 뷰라 HTML 위에 그려지므로 메뉴·창·끌기·플로팅 패널이 겹치면 숨긴다. 페이지가 키보드를 잡고 있으면 ⌘ 단축키를 `thuminal-key://` 이동으로 바꿔 메인 웹뷰로 넘긴다. capabilities 는 메인 웹뷰(`webviews: ["main"]`)에만 준다.
- **터미널 글꼴**은 설정창 값(`ui/src/terminal-font.ts`, localStorage)이다. 기본은 Orca 와 같은 SF Mono 14px · 굵기 500. WebKit 은 시스템 SF Mono 를 `ui-monospace` 로만 주고, 사용자 설치 글꼴은 숨기므로 껍데기(`fontFaces` · `fontSource`)에서 파일을 받아 직접 등록한다. 시작할 때는 보통 굵기 면만 기다리고 굵게 · 기울임 면은 뒤에서 받는다. 글꼴이 바뀌거나 남은 면이 들어오면 면의 렌더러를 새로 만든다.
- **시작 화면**(`ui/src/boot.ts`): 저장된 테마를 맨 먼저 입히고, 엔진 · 글꼴 · 데몬 목록 다섯을 받는 동안 화면 전체를 진행 막대로 덮는다. root 모델이 처음 다 읽으면 걷는다.
- **테마** 하나로 세 곳을 맞춘다: 화면 토큰(`<html>` CSS 변수, `themes` 의 `uiTokens`), 앱 엔진 기본색(`setColors`), 데몬 엔진 기본색(`set_terminal_colors`).
- 한글 IME: 조합 중인 글자는 엔진 `setPreedit` 으로 커서 자리에 밑줄로 그린다. textarea 는 조합이 모두 끝난 뒤에만 비운다 (WebKit 은 다음 글자 조합 시작이 앞 글자 조합 끝보다 먼저 오기도 한다). 입력 소스를 바꾼 직후 입력기가 붙지 않아 자모가 keyCode 229 없이 하나씩 오면 `hangul.ts` 가 직접 묶는다.

## 지킬 것

- **프로토콜 타입은 두 벌이다.** 원본은 `crates/thuminal-protocol/src/{message,layout}.rs`, TS 쪽은 `packages/term-core/src/protocol.ts`. 와이어 모양을 바꾸면 둘을 같이 바꾼다. enum 은 serde `tag = "type"`(op 는 `tag = "op"`), snake_case 다. 새 필드는 `#[serde(default)]` 로 옛 데몬·앱과 맞춘다.
- 앱의 데몬 요청은 대부분 generic `daemon_request` Tauri 명령으로 그대로 넘어간다 (`tauri-host.ts` 의 `req()`). 새 요청에 Tauri 명령을 늘릴 필요는 보통 없다.
- 데몬은 바깥 환경의 `THUMINAL_*`, `ORCA_*`, `CLAUDE_CODE_*` 를 세션에 물려주지 않는다 (`SCRUBBED_ENV_PREFIXES`). 세션 안 CLI 가 써야 하는 값은 데몬이 다시 넣는다.
- 단축키는 Orca 와 같게 둔다 (⌘1~9 워크트리, ⌃1~9 탭, ⌘⌥←→ 방문 기록, ⌘⌥A 플로팅, ⌘D/⌘⇧D 나누기). thuminal 에만 있는 칸 방향 이동은 ⌃⌘방향키, 크기는 ⌃⌘⇧방향키다. ⌘+ ⌘- ⌘0 은 터미널에 포커스가 있으면 모든 터미널 글자 크기, 아니면 앱 화면 배율(Tauri 웹뷰 확대)이다 (`ui/src/App.tsx` `useShortcuts`). Windows · Linux 는 누른 키를 macOS 자리로 바꿔 읽는다 (`ui/src/platform.ts` `appMods`): ⌘ 는 Ctrl(터미널과 겹치는 Ctrl+D · W · L 등도 앱이 가져간다), ⌃1~9 탭은 Alt+1~9, ⌃⌘방향키는 Ctrl+Alt+방향키, ⌘⌥←→ 는 Alt+←→, 터미널 단어 이동은 Ctrl+←→. 화면에 쓰는 단축키 글자는 `keyLabel("⌘D")` 로 바꿔 보인다.
- 주석·문서·CLI 도움말·출력은 한국어 `-다` 평서형이다. 주변 코드의 주석 밀도와 말투를 따른다.
- 화면 글(앱·웹·폰, 화면에 뜨는 데몬·클라이언트 오류, 알림)은 해요체다 ("열린 터미널이 없어요", "이 기기를 지울까요?"). 단추·메뉴·상태·칸 머리 같은 짧은 이름은 명사로 쓴다 ("저장", "작업 중", "응답 대기"). 낱말은 개발자가 흔히 쓰는 말로: 버전(판 아님), 연결(붙다 아님), 실행·시작(띄우다 아님). 칸·탭·워크트리는 화면 이름이라 그대로 쓴다. 문장 안에 em dash 를 쓰지 않는다.
- CLI 는 orca CLI 와 호환하지 않는다. 명령 하나 = 연결 하나 + 바꾸는 요청 하나가 원칙이고, 대상(`p7`, `t3`, `s12`, `.`)은 데몬이 푼다.
- **macOS 알림에 `mac-notification-sys` 나 `tauri-plugin-notification`(속으로 같은 것을 쓴다)을 쓰지 않는다.** 처음 알림을 보낼 때 `NSBundle` 번들 id 를 바꿔치기(swizzle)해서, 그 뒤로 앱이 macOS 에 Finder 로 보이고 입력기(IMK)·창 끌기가 몇 초씩 막힌다. 알림은 앱이 `UNUserNotificationCenter` 로 직접 보낸다 (`src-tauri/src/notify.rs`). 이 API 는 서명된 `.app` 번들 안에서만 되므로 `pnpm dev` 도 `scripts/dev-app-runner.sh` 가 개발 앱을 `target/debug/thuminal-dev.app`("thuminal dev")으로 임시 서명해 실행한다.
- 데몬의 연결마다 읽기 루프는 세션·배치 요청을 받은 차례대로 처리한다. git·파일처럼 오래 걸리는 요청은 `server.rs` `is_slow` 에 넣어 따로 돌린다 (안 그러면 같은 연결의 키 입력·붙기가 그 뒤에 줄을 선다).
- `libghostty-vt` 는 crates.io 판에 snapshot API 가 없어 git rev 를 고정해 쓴다 (`Cargo.toml`). 스크롤백 바이트 한도 기본값이 작아 엔진을 만들 때 풀어 준다.
