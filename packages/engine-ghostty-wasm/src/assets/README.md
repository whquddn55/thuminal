# ghostty-vt.wasm

Ghostty `tip` 릴리스의 `ghostty-vt.wasm` 을 그대로 넣었다 (2026-10-24 내려받음).

- sha256: `e23598cefe95b42d441221a45d22d435c9c1915bca7475fe735e7617eac1a0d1`
- 출처: https://github.com/ghostty-org/ghostty/releases/tag/tip
- 바꿀 때는 `include/ghostty/vt/*.h` 의 enum 값과 구조체 배치(`ghostty_type_json`)가 그대로인지 `pnpm test` 로 확인한다.
