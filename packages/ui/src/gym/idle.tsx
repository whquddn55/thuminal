// 창 안 입력이 정한 시간(분) 동안 없으면 화면 보호기(헬스장 화면)를 띄운다. 설정은 `settings.ts`, 처음에는 꺼져 있다.
//
// 입력으로 치는 것: 메인 웹뷰가 받은 키 · 마우스 · 휠, 그리고 브라우저 칸이 받은 것 (페이지 단축키 · 포커스 · 이동,
// macOS 는 껍데기가 알리는 칸 마우스 `input`). 다른 앱을 쓰는 동안은 창 안 입력이 없으므로 시간이 지나면 뜬다.
//
// 떠 있는 동안 키는 터미널 · 앱 단축키로 가지 않는다. 그래서 키 듣기를 앱 단축키(`useShortcuts`)보다 먼저 건다:
// Shell 에서 이 훅을 useShortcuts 보다 먼저 부르고, 듣기는 처음 한 번만 건다 (켜고 끌 때 다시 걸면 차례가 뒤로 밀린다).
//
// 잠금(`lock.ts`)이 켜져 있으면 띄울 때 잠근다. 잠긴 동안 닫거나 사람을 누르면 암호 칸을 띄우고, 맞게 치면 그 일을 한다.
// 잠긴 채 앱을 끄면 다시 켤 때 잠긴 화면으로 시작한다.

import { useEffect, useRef, useState } from "react";

import type { AppModel } from "../store";
import { GymScreen } from "./GymScreen";
import { checkPassword, clearLock, lockOn, markLocked, wasLocked } from "./lock";
import { useIdleScreenSettings } from "./settings";

/** 시간이 지났는지 이 간격으로 본다 */
const CHECK_MS = 5_000;

/** 설정창 [지금 보기] 가 부른다 */
let showNow: (() => void) | null = null;
export const previewIdleScreen = () => showNow?.();

/** 잠긴 화면을 풀고 나서 할 일 */
type After = { kind: "close" } | { kind: "pick"; session: number };

export function useIdleScreen(root: AppModel): React.ReactNode {
  const { enabled, minutes } = useIdleScreenSettings();
  const [shown, setShown] = useState(wasLocked);
  const [locked, setLocked] = useState(wasLocked);
  /** 암호 칸을 띄웠으면 풀고 나서 할 일 */
  const [asking, setAsking] = useState<After | null>(null);
  const [bedToggle, setBedToggle] = useState(0);
  /** 암호를 잊었을 때 만들 파일 (껍데기가 알려 준다) */
  const [resetPath, setResetPath] = useState<string | null>(null);
  const lastInput = useRef(Date.now());
  const shownRef = useRef(shown);
  const lockedRef = useRef(locked);
  const askingRef = useRef(asking);
  askingRef.current = asking;
  /** 띄우기 전 키보드를 받던 요소. 닫으면 돌려준다 */
  const focusRef = useRef<HTMLElement | null>(null);

  const show = () => {
    if (shownRef.current) return;
    shownRef.current = true;
    const el = document.activeElement;
    focusRef.current = el instanceof HTMLElement && el !== document.body ? el : null;
    // 한글 조합 중인 글자가 터미널로 가지 않게 키보드를 뺀다
    focusRef.current?.blur();
    if (lockOn()) {
      lockedRef.current = true;
      setLocked(true);
      markLocked(true);
    }
    setShown(true);
  };
  const hide = (refocus = true) => {
    if (!shownRef.current) return;
    shownRef.current = false;
    lastInput.current = Date.now();
    setShown(false);
    setAsking(null);
    const el = focusRef.current;
    focusRef.current = null;
    if (refocus && el?.isConnected) el.focus();
  };
  const run = (after: After) => {
    if (after.kind === "close") return hide();
    hide(false);
    revealAgent(root, after.session);
  };
  /** 닫거나 사람에게 간다. 잠겨 있으면 먼저 암호를 묻는다 */
  const request = (after: After) => {
    if (lockedRef.current) setAsking(after);
    else run(after);
  };
  const unlock = (password: string): boolean => {
    if (!checkPassword(password)) return false;
    lockedRef.current = false;
    setLocked(false);
    markLocked(false);
    const after = askingRef.current ?? { kind: "close" };
    setAsking(null);
    run(after);
    return true;
  };
  const ctl = useRef({ show, hide, request });
  ctl.current = { show, hide, request };
  useEffect(() => {
    showNow = () => ctl.current.show();
    return () => {
      showNow = null;
    };
  }, []);

  // 암호를 잊었으면 데이터 폴더의 파일로 푼다 (앱을 다시 켤 때 한 번 본다)
  useEffect(() => {
    void root.services.host.idleLockReset?.().then(
      ({ requested, path }) => {
        setResetPath(path);
        if (!requested) return;
        clearLock();
        lockedRef.current = false;
        setLocked(false);
        ctl.current.hide();
      },
      () => {},
    );
  }, [root]);

  // 입력 듣기 (처음 한 번만 건다)
  useEffect(() => {
    const touch = () => {
      if (!shownRef.current) lastInput.current = Date.now();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!shownRef.current) return touch();
      // 터미널 · 앱 단축키로 가지 않게 한다
      e.stopImmediatePropagation();
      if (askingRef.current) {
        // 암호 칸: 글자 넣기와 Enter(풀기)는 칸이 그대로 받고, Esc 는 암호 칸만 닫는다
        if (e.key === "Escape") {
          e.preventDefault();
          setAsking(null);
        } else if (!(e.target instanceof HTMLInputElement && e.target.dataset.idleLock)) {
          e.preventDefault();
          document.querySelector<HTMLInputElement>("[data-idle-lock]")?.focus();
        }
        return;
      }
      e.preventDefault();
      if (e.repeat || ["Meta", "Shift", "Alt", "Control", "CapsLock"].includes(e.key)) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "b" || e.key === "B" || e.key === "ㅠ")) return setBedToggle((n) => n + 1);
      ctl.current.request({ kind: "close" });
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
      // 잠긴 화면은 그대로 둔다 (설정은 풀린 뒤에만 바꿀 수 있다. 앱을 다시 켤 때 잠긴 채 꺼져 있을 수 있다)
      if (!lockedRef.current) ctl.current.hide(false);
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
    <GymScreen bedToggle={bedToggle} locked={locked} onClose={() => request({ kind: "close" })} onPick={(session) => request({ kind: "pick", session })}>
      {asking && <UnlockCard onUnlock={unlock} onCancel={() => setAsking(null)} resetPath={resetPath} />}
    </GymScreen>
  );
}

/** 잠긴 화면 위 암호 칸 */
function UnlockCard({ onUnlock, onCancel, resetPath }: { onUnlock: (password: string) => boolean; onCancel: () => void; resetPath: string | null }) {
  const [value, setValue] = useState("");
  const [wrong, setWrong] = useState(false);
  const [help, setHelp] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <form
        className="w-80 rounded-xl border border-[#2a3546] bg-[#0d1219] p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (onUnlock(value)) return;
          setWrong(true);
          setValue("");
          inputRef.current?.focus();
        }}
      >
        <div className="mb-1 text-sm font-bold">🔒 잠겨 있어요</div>
        <div className="mb-3 text-xs text-[#6b7a90]">화면 보호기 암호를 입력해 주세요.</div>
        <input
          ref={inputRef}
          data-idle-lock="1"
          type="password"
          autoComplete="off"
          className="h-8 w-full rounded-md border border-[#2a3546] bg-[#07090d] px-2.5 text-sm text-[#e8eef7] outline-none focus:border-[#7cf2c8]"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setWrong(false);
          }}
        />
        <div className="mt-1.5 h-4 text-xs text-[#ff8a8a]">{wrong ? "암호가 맞지 않아요" : ""}</div>
        <div className="mt-2 flex items-center justify-between">
          <button type="button" className="text-xs text-[#6b7a90] underline-offset-2 hover:underline" onClick={() => setHelp((h) => !h)}>
            암호를 잊었어요
          </button>
          <button type="submit" className="h-7 rounded-md bg-[#7cf2c8] px-3 text-xs font-bold text-[#07090d]">
            풀기
          </button>
        </div>
        {help && (
          <div className="mt-3 rounded-md border border-[#1c2533] bg-[#0a0e14] p-2.5 text-xs leading-relaxed text-[#a9b6c8] select-text">
            {resetPath ? (
              <>
                앱을 끄고 터미널에서 아래 명령을 실행한 뒤 다시 켜면 잠금이 풀리고 암호가 지워져요.
                <code className="mt-1.5 block font-mono break-all text-[#e8eef7]">touch "{resetPath}"</code>
              </>
            ) : (
              "이 브라우저에서 이 사이트의 데이터를 지우면 잠금이 풀려요. 이 사이트에 남긴 다른 설정도 함께 지워져요."
            )}
          </div>
        )}
      </form>
    </div>
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
