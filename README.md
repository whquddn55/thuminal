# thuminal

워크트리마다 터미널과 claude 를 띄워 관리하는 macOS 앱.

- 앱을 끄거나 업데이트해도 터미널은 데몬 밑에서 계속 돈다.
- 재부팅 뒤에는 세션을 되살리고 `claude --resume` 으로 대화를 잇는다.
- 터미널은 Ghostty 엔진(데몬: libghostty-vt, 앱: ghostty-vt.wasm)과 WebGL 렌더러로 그린다.

구조는 [docs/architecture.md](docs/architecture.md).

## 개발

```sh
mise install          # Zig 0.16 (libghostty-vt 빌드용)
pnpm install
pnpm dev              # 앱 (개발용 데이터 폴더)
mise exec -- cargo test --workspace
pnpm test
scripts/build-app.sh  # target/release/bundle/macos/thuminal.app
```

## claude 연동

따로 설치하지 않는다. thuminal 이 띄운 셸에서는 `claude` 가 셸 함수로 바뀌어
`claude --plugin-dir <thuminal.app/Contents/Resources/claude-plugin>` 으로 실행된다.
그 실행에만 훅이 들어가 탭에 claude 상태가 보이고, 재부팅 뒤 `claude --resume` 으로 대화를 잇는다.
thuminal 밖의 claude 와 `~/.claude` 설정은 건드리지 않는다.

- 플러그인 원본: `plugins/claude-code/thuminal` (개발 중에는 데몬이 이 폴더를 쓴다)
- 셸 통합: zsh 는 `ZDOTDIR`, bash 는 `--rcfile` 로 사용자 설정을 그대로 읽은 뒤 함수만 더한다 (`crates/thuminal-daemon/src/shell.rs`)
- `command claude` 처럼 함수를 건너뛰면 훅이 빠진다
