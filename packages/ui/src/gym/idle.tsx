// 창 안 입력이 정한 시간(분) 동안 없으면 화면 보호기(헬스장 화면)를 띄운다. 설정은 `settings.ts`, 처음에는 꺼져 있다.
//
// 입력으로 치는 것: 메인 웹뷰가 받은 키 · 마우스 · 휠, 그리고 브라우저 칸이 받은 것 (페이지 단축키 · 포커스 · 이동,
// macOS 는 껍데기가 알리는 칸 마우스 `input`). 다른 앱을 쓰는 동안은 창 안 입력이 없으므로 시간이 지나면 뜬다.
//
// 떠 있는 동안 키는 터미널 · 앱 단축키로 가지 않는다. 그래서 키 듣기를 앱 단축키(`useShortcuts`)보다 먼저 건다:
// Shell 에서 이 훅을 useShortcuts 보다 먼저 부르고, 듣기는 처음 한 번만 건다 (켜고 끌 때 다시 걸면 차례가 뒤로 밀린다).

import { useEffect, useRef, useState } from "react";

import type { AppModel } from "../store";
import { GymScreen } from "./GymScreen";
import { useIdleScreenSettings } from "./settings";

/** 시간이 지났는지 이 간격으로 본다 */
const CHECK_MS = 5_000;

/** 설정창 [지금 보기] 가 부른다 */
let showNow: (() => void) | null = null;
export const previewIdleScreen = () => showNow?.();

export function useIdleScreen(root: AppModel): React.ReactNode {
  const { enabled, minutes } = useIdleScreenSettings();
  const [shown, setShown] = useState(false);
  const [bedToggle, setBedToggle] = useState(0);
  const lastInput = useRef(Date.now());
  const shownRef = useRef(false);
  /** 띄우기 전 키보드를 받던 요소. 닫으면 돌려준다 */
  const focusRef = useRef<HTMLElement | null>(null);

  const show = () => {
    if (shownRef.current) return;
    shownRef.current = true;
    const el = document.activeElement;
    focusRef.current = el instanceof HTMLElement && el !== document.body ? el : null;
    // 한글 조합 중인 글자가 터미널로 가지 않게 키보드를 뺀다
    focusRef.current?.blur();
    setShown(true);
  };
  const hide = (refocus = true) => {
    if (!shownRef.current) return;
    shownRef.current = false;
    lastInput.current = Date.now();
    setShown(false);
    const el = focusRef.current;
    focusRef.current = null;
    if (refocus && el?.isConnected) el.focus();
  };
  const ctl = useRef({ show, hide });
  ctl.current = { show, hide };
  useEffect(() => {
    showNow = () => ctl.current.show();
    return () => {
      showNow = null;
    };
  }, []);

  // 입력 듣기 (처음 한 번만 건다)
  useEffect(() => {
    const touch = () => {
      if (!shownRef.current) lastInput.current = Date.now();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!shownRef.current) return touch();
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || ["Meta", "Shift", "Alt", "Control", "CapsLock"].includes(e.key)) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "b" || e.key === "B" || e.key === "ㅠ")) return setBedToggle((n) => n + 1);
      ctl.current.hide();
    };
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("keydown", onKey, true);
    for (const t of ["pointerdown", "pointermove", "wheel"] as const) window.addEventListener(t, touch, opts);
    const offBrowser = root.services.host.browser?.onEvent(touch);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      for (const t of ["pointerdown", "pointermove", "wheel"] as const) window.removeEventListener(t, touch, opts);
      offBrowser?.();
    };
  }, [root]);

  // 시간 재기. 켜면 그때부터 센다
  useEffect(() => {
    if (!enabled) {
      ctl.current.hide(false);
      return;
    }
    lastInput.current = Date.now();
    const t = window.setInterval(() => {
      if (Date.now() - lastInput.current >= minutes * 60_000) ctl.current.show();
    }, CHECK_MS);
    return () => window.clearInterval(t);
  }, [enabled, minutes]);

  if (!shown) return null;
  return (
    <GymScreen
      bedToggle={bedToggle}
      onClose={() => hide()}
      onPick={(session) => {
        hide(false);
        revealAgent(root, session);
      }}
    />
  );
}

/** 사람을 눌렀다: 그 세션 칸으로 간다. 팀원이면 리더 칸으로 가서 팀원 팝업에 그 팀원을 띄운다 */
function revealAgent(root: AppModel, session: number) {
  const s = root.get().sessions[session];
  const leader = Number(s?.labels["team.leader"]);
  if (leader) {
    root.revealSession(leader);
    root.showTeammate(leader, session);
  } else root.revealSession(session);
}
