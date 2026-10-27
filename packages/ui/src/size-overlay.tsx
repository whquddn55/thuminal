// 다른 화면(폰 · 다른 컴퓨터 창)이 세션 크기를 가져갔을 때 칸 전체를 덮는 덮개.
//
// 누르기 · 입력 · 칸 크기 바꾸기로는 크기를 가져오지 않는다. 덮개의 [세션 가져오기] 를 눌러야만 이 칸 크기로 되돌린다.
// 덮개 밑 터미널은 다른 크기로 그려진 채 반투명하게 보인다. 덮인 동안은 키보드 입력도 세션에 보내지 않는다.
// 처음 붙을 때 다른 화면이 이미 붙어 있으면 칸에 맞추지 않고 덮는다 (혼자 붙으면 칸에 맞춘다).

import { useEffect, useState } from "react";

import { Button } from "./components/ui/button";
import type { TerminalController } from "./terminal-controller";

/** 세션 크기를 다른 화면이 가져갔는지. 크기가 잠깐 오가는 것은 띄우지 않게 조금 기다렸다가 띄우고, 걷는 것은 바로 한다 */
export function useSizeTaken(c: TerminalController): boolean {
  const [taken, setTaken] = useState(false);
  useEffect(() => {
    let timer = 0;
    const check = () => {
      window.clearTimeout(timer);
      if (!c.sizeTaken) setTaken(false);
      else timer = window.setTimeout(() => setTaken(c.sizeTaken), 300);
    };
    check();
    const stop = c.onSizeState(check);
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, [c]);
  return taken;
}

/** 칸 자리(위치가 잡힌 부모)를 덮는다. 터미널 그림판(z 5) 위에 그린다 */
export function SizeTakenOverlay({ c, cols, rows }: { c: TerminalController; cols?: number; rows?: number }) {
  const taken = useSizeTaken(c);
  if (!taken) return null;
  // 덮개를 누르거나 굴린 것이 터미널(고르기 · 휠 · 포커스)로 가지 않게 막는다
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div
      className="absolute inset-0 z-[6] flex flex-col items-center justify-center gap-3 bg-background/70 p-4 text-center"
      onMouseDown={stop}
      onPointerDown={stop}
      onTouchStart={stop}
      onWheel={stop}
    >
      <div className="text-sm text-foreground">
        다른 기기 크기{cols && rows ? `(${cols}×${rows})` : ""}로 그리는 중
      </div>
      <Button size="sm" onClick={() => c.claimSize()}>
        세션 가져오기
      </Button>
    </div>
  );
}
