// 오른쪽 아래에 쌓아 띄우는 카드: 오류와 알릴 것 (store.ts `toasts`). 저절로 사라지고, 마우스를 올려 둔 동안은 남는다.

import { CheckIcon, CopyIcon, InfoIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";

import { cn } from "./lib/utils";
import { type Toast, useApp, useModel } from "./store";

/** 떠 있는 시간 (ms). 오류는 읽고 복사할 틈을 더 준다 */
const STAY: Record<Toast["kind"], number> = { notice: 6000, error: 15000 };

/** children 은 같은 자리에 쌓을 다른 카드 (업데이트 진행) */
export function Toasts({ children }: { children?: ReactNode }) {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[26rem] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
      {children}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const model = useModel();
  const [hover, setHover] = useState(false);
  const close = () => model.root.dismissToast(toast.id);
  useEffect(() => {
    if (hover) return;
    const t = window.setTimeout(() => model.root.dismissToast(toast.id), STAY[toast.kind]);
    return () => window.clearTimeout(t);
  }, [hover, toast.id, toast.kind, model]);
  const error = toast.kind === "error";
  const icon = "flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <div
      data-browser-cover
      role={error ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex animate-in flex-col gap-1.5 rounded-lg border bg-popover p-3 text-popover-foreground shadow-lg duration-150 fade-in-0 slide-in-from-bottom-2",
        error && "border-destructive/50",
      )}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <div className="flex items-center gap-1.5">
        {error ? <WarningCircleIcon weight="fill" className="size-4 shrink-0 text-destructive" /> : <InfoIcon weight="fill" className="size-4 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 text-sm font-semibold">{error ? "오류" : "알림"}</span>
        {error && <CopyButton text={toast.text} className={icon} />}
        <button className={icon} aria-label="닫기" onClick={close}>
          <XIcon className="size-4" />
        </button>
      </div>
      {/* 글은 골라 복사할 수 있다 (경로가 든 오류를 claude 에게 그대로 넘기게) */}
      <div className="thm-scroll max-h-52 cursor-text overflow-y-auto text-[13px] leading-relaxed break-words whitespace-pre-wrap select-text">{toast.text}</div>
    </div>
  );
}

/** 글을 복사하는 단추. 복사하면 잠깐 체크 표시로 바뀐다 */
function CopyButton({ text, className }: { text: string; className: string }) {
  const [done, setDone] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(text).then(
      () => (setDone(true), window.setTimeout(() => setDone(false), 1200)),
      () => undefined,
    );
  return (
    <button className={className} title="복사" onClick={copy}>
      {done ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
    </button>
  );
}
