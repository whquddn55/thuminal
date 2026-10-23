# 시제품

본 작업 전에 기술 선택을 확인하려고 만든 측정용 코드다. 앱 코드에서 쓰지 않는다.

- `vt-daemon-probe/`: 데몬 쪽 Ghostty 엔진(libghostty-vt) 확인. 처리 속도, 화면 저장·복원, 메모리.
- `render-bench/`: Tauri 창에 터미널 20개를 띄워 xterm.js, Ghostty wasm + Canvas 2D, Ghostty wasm + WebGL 을 비교한다 (`run_bench.py`).

측정 결과는 저장소 밖 `~/scratch/thuminal/main/render-research/` 에 있다.

wasm 은 저장소에 두 번 넣지 않는다. 돌리기 전에 복사한다.

```sh
cp packages/engine-ghostty-wasm/src/assets/ghostty-vt.wasm spikes/render-bench/src/assets/
```
