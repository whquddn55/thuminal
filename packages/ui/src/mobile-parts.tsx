// 폰 화면(MobileApp · MobileSettings)이 같이 쓰는 조각.

import { ArrowLeftIcon } from "@phosphor-icons/react";

/** 화면 머리: 뒤로 단추, 제목 · 부제, 오른쪽 메뉴 */
export function Header({ title, sub, back, right }: { title: React.ReactNode; sub?: React.ReactNode; back?: () => void; right?: React.ReactNode }) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-1 border-b px-1.5">
      {back ? (
        <button className="flex size-9 shrink-0 items-center justify-center rounded-md active:bg-accent" onClick={back} aria-label="뒤로">
          <ArrowLeftIcon className="size-5" />
        </button>
      ) : (
        <span className="w-2" />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-semibold">{title}</div>
        {sub ? <div className="truncate text-[11px] text-muted-foreground">{sub}</div> : null}
      </div>
      {right}
    </div>
  );
}
