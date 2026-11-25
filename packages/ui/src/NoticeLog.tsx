// 사이드바 머리의 알림 단추: 보낸 알림 목록과 [시험 알림]. 읽지 않은 알림 수를 단추에 적는다. 알림이 온 칸을 보면 읽은 것이 된다.

import { BellIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { Button } from "./components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import { cn } from "./lib/utils";
import { clearNotices, markNoticesRead, type NoticeEntry, unreadNotices, useNoticeLog } from "./notice-log";
import { useModel } from "./store";

const DOT: Record<NoticeEntry["kind"], string> = {
  attention: "bg-agent-attention",
  done: "bg-agent-done",
  bell: "bg-muted-foreground/60",
  test: "bg-muted-foreground/30",
};

/** 보낸 때: 오늘이면 시각만, 아니면 날짜도 */
function when(at: number): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function NoticeButton() {
  const model = useModel();
  const [open, setOpen] = useState(false);
  const entries = useNoticeLog((s) => s.entries);
  const unread = useNoticeLog(unreadNotices);
  const go = (e: NoticeEntry) => {
    if (e.kind === "test") return;
    markNoticesRead((x) => x === e);
    if (model.root.revealNotice(e.host, e.session)) setOpen(false);
    else model.notice("그 칸은 이미 닫혔어요");
  };
  const text = "rounded px-1.5 py-0.5 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="relative size-7 text-muted-foreground" aria-label={unread ? `알림 ${unread}개` : "알림"}>
              <BellIcon className="size-4" />
              {unread > 0 && (
                <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-agent-attention px-1 text-[9px] leading-none font-semibold text-white tabular-nums">
                  {unread > 99 ? "99+" : unread}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{unread ? `읽지 않은 알림 ${unread}개` : "보낸 알림"}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-80 p-1" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex items-center gap-1 px-1.5 pt-0.5 pb-1">
          <span className="flex-1 text-xs font-semibold">알림</span>
          <button className={text} onClick={() => void model.root.testNotify()}>
            시험 알림
          </button>
          {unread > 0 && (
            <button className={text} onClick={() => markNoticesRead()}>
              모두 읽음
            </button>
          )}
          {entries.length > 0 && (
            <button className={text} onClick={clearNotices}>
              비우기
            </button>
          )}
        </div>
        <div className="thm-scroll max-h-96 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">아직 보낸 알림이 없어요</div>
          ) : (
            entries.map((e, i) => (
              <button
                key={`${e.at}:${i}`}
                className={cn("flex w-full items-start gap-2 rounded px-1.5 py-1.5 text-left", e.kind !== "test" && "hover:bg-accent/60", (e.read || e.kind === "test") && "opacity-55")}
                onClick={() => go(e)}
              >
                <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT[e.kind])} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1.5 text-xs">
                    <span className={cn("min-w-0 truncate", e.read || e.kind === "test" ? "font-normal" : "font-semibold")}>{e.title}</span>
                    <span className="ml-auto shrink-0 text-2xs tabular-nums text-muted-foreground">{when(e.at)}</span>
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{e.subtitle}</span>
                  {e.body && <span className="line-clamp-2 text-2xs text-muted-foreground/80">{e.body}</span>}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
