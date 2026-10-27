// 붙인 그림: 이 칸 claude 대화(지금 기록)에서 사용자가 붙여 보낸 그림(`[Image #N]`)을 칸 위 팝업으로 모아 본다.
//
// 그림은 데몬이 대화 기록 안 base64 에서 꺼낸다 (daemon images.rs). 단추의 수는 `AgentInfo.image_count` 이고,
// 기록이 자라면 데몬이 1초 안에 세어 알린다. /clear 로 새 기록이 되면 0 이 되어 단추가 사라진다.
// 팝업은 썸네일 바둑판(보이는 것만 받는다, 데몬이 줄여 보낸다), 누르면 원본을 크게 보는 라이트박스다.
// 라이트박스는 Radix Dialog 라 열리면 브라우저 칸 네이티브 웹뷰가 저절로 숨는다 (BrowserPane `useOverlayOpen`).

import { CaretLeftIcon, CaretRightIcon, ImageIcon, XIcon } from "@phosphor-icons/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { AgentImage, HostApi, SessionId } from "@thuminal/term-core";

import { cn } from "./lib/utils";
import { PopupHead, ResizablePopup } from "./PanePopup";
import { useApp, useModel } from "./store";

/** 칸의 붙인 그림 수와 팝업이 열렸는지 */
export function useGallery(session: SessionId): { count: number; open: boolean } {
  const count = useApp((s) => s.sessions[session]?.agent?.image_count ?? 0);
  const open = useApp((s) => !!s.gallery[session]) && count > 0;
  return { count, open };
}

/** [그림 N] 단추. floating 이면 칸 오른쪽 위에 뜨는 모양, 아니면 칸 머리 줄 모양 */
export function GalleryButton({ session, floating }: { session: SessionId; floating?: boolean }) {
  const model = useModel();
  const { count, open } = useGallery(session);
  if (count === 0) return null;
  return (
    <button
      className={
        floating
          ? "flex h-5 items-center gap-1 rounded-md border bg-popover/90 px-1.5 text-[10px] text-popover-foreground shadow-sm hover:bg-accent"
          : "flex h-4 items-center gap-1 rounded bg-primary/15 px-1.5 text-[10px] text-foreground hover:bg-primary/25"
      }
      title={`claude 에 붙여 보낸 그림 ${count}장. 눌러서 ${open ? "닫기" : "보기"}`}
      onClick={() => model.toggleGallery(session)}
    >
      <ImageIcon className="size-3" />
      그림 {count}
    </button>
  );
}

// ---- 그림 받기: 썸네일은 기록·자리마다 한 번만 받는다 ----

const thumbs = new Map<string, Promise<string>>();
const THUMB_KEEP = 400;

function thumbOf(host: HostApi, session: SessionId, transcript: string, id: string): Promise<string> {
  const key = `${session}\n${transcript}\n${id}`;
  let p = thumbs.get(key);
  if (!p) {
    p = host.agentImage(session, id, true).then(
      (r) => `data:${r.mediaType};base64,${r.data}`,
      (e) => {
        thumbs.delete(key);
        throw e;
      },
    );
    thumbs.set(key, p);
    // 오래된 것부터 지운다 (Map 은 넣은 차례를 지킨다)
    for (const k of thumbs.keys()) {
      if (thumbs.size <= THUMB_KEEP) break;
      thumbs.delete(k);
    }
  }
  return p;
}

const dateFmt = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function describe(img: AgentImage): string {
  const parts = [`#${img.n}`];
  if (img.width && img.height) parts.push(`${img.width}×${img.height}`);
  parts.push(img.bytes >= 1024 * 1024 ? `${(img.bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(img.bytes / 1024))}KB`);
  if (img.at) parts.push(dateFmt.format(img.at));
  return parts.join(" · ");
}

/** 붙인 그림 팝업: 썸네일 바둑판(보낸 차례, 새 그림이 아래) */
export function ImageGallery({ session }: { session: SessionId }) {
  const model = useModel();
  const host = model.services.host;
  const count = useApp((s) => s.sessions[session]?.agent?.image_count ?? 0);
  const transcript = useApp((s) => s.sessions[session]?.agent?.transcript ?? "");
  const [list, setList] = useState<AgentImage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    host.agentImages(session).then(
      (l) => live && (setList(l), setError(null)),
      (e) => live && setError(String(e instanceof Error ? e.message : e)),
    );
    return () => {
      live = false;
    };
  }, [host, session, count, transcript]);

  // 새 그림이 아래에 붙으므로 처음 열 때와 늘었을 때 맨 아래로
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list?.length]);

  return (
    <ResizablePopup sizeKey="thuminal.imagePopupSize" defaultSize={{ w: 460, h: 380 }} className="border bg-popover text-popover-foreground">
      <PopupHead onClose={() => model.toggleGallery(session, false)}>
        <ImageIcon className="size-3.5 text-primary" />
        <span className="font-medium">붙인 그림 {count}</span>
      </PopupHead>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-1.5 thm-scroll">
        {error ? (
          <div className="p-2 text-xs text-destructive">그림 목록을 읽지 못했어요: {error}</div>
        ) : list === null ? (
          <div className="p-2 text-xs text-muted-foreground">읽는 중…</div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5">
            {list.map((img, i) => (
              <Thumb key={img.id} host={host} session={session} transcript={transcript} img={img} onOpen={() => setView(i)} />
            ))}
          </div>
        )}
      </div>
      {list && view !== null && list[view] && (
        <Lightbox session={session} transcript={transcript} images={list} index={view} onIndex={setView} onClose={() => setView(null)} />
      )}
    </ResizablePopup>
  );
}

/** 썸네일 하나. 화면에 보일 때 받는다 */
function Thumb({ host, session, transcript, img, onOpen }: { host: HostApi; session: SessionId; transcript: string; img: AgentImage; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      thumbOf(host, session, transcript, img.id).then(
        (url) => live && setSrc(url),
        () => live && setFailed(true),
      );
    });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [host, session, transcript, img.id]);
  return (
    <button
      ref={ref}
      className="group relative aspect-square overflow-hidden rounded-md border bg-muted/60 outline-none hover:ring-2 hover:ring-primary/60 focus-visible:ring-2 focus-visible:ring-ring"
      title={describe(img)}
      onClick={onOpen}
    >
      {src ? (
        <img src={src} alt={`붙인 그림 #${img.n}`} className="size-full object-cover" draggable={false} />
      ) : (
        <span className="flex size-full items-center justify-center text-[10px] text-muted-foreground">{failed ? "읽기 실패" : ""}</span>
      )}
      <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] leading-4 text-white">#{img.n}</span>
    </button>
  );
}

/** 원본을 크게 본다. ←→ 로 넘기고 Esc 로 닫는다 */
function Lightbox({
  session,
  transcript,
  images,
  index,
  onIndex,
  onClose,
}: {
  session: SessionId;
  transcript: string;
  images: AgentImage[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const model = useModel();
  const host = model.services.host;
  const img = images[index];
  const [full, setFull] = useState<{ id: string; url: string } | null>(null);
  const [thumb, setThumb] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    // 원본이 오기 전에는 썸네일을 늘려 보인다
    void thumbOf(host, session, transcript, img.id).then(
      (url) => live && setThumb({ id: img.id, url }),
      () => undefined,
    );
    host.agentImage(session, img.id, false).then(
      (r) => live && setFull({ id: img.id, url: `data:${r.mediaType};base64,${r.data}` }),
      (e) => live && setError(String(e instanceof Error ? e.message : e)),
    );
    return () => {
      live = false;
    };
  }, [host, session, transcript, img.id]);

  const go = (d: number) => {
    const next = index + d;
    if (next >= 0 && next < images.length) onIndex(next);
  };
  const src = full?.id === img.id ? full.url : thumb?.id === img.id ? thumb.url : null;
  const navBtn = "absolute top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 disabled:invisible";

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col outline-none"
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") (e.preventDefault(), go(-1));
            else if (e.key === "ArrowRight") (e.preventDefault(), go(1));
          }}
          onCloseAutoFocus={(e) => (e.preventDefault(), model.controller(session).focus())}
          // 그림 밖(검은 바탕)을 누르면 닫는다
          onPointerDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <div className="flex h-10 shrink-0 items-center gap-3 px-4 text-xs text-white/80">
            <DialogPrimitive.Title className="font-medium text-white">붙인 그림 #{img.n}</DialogPrimitive.Title>
            <span>
              {index + 1} / {images.length}
            </span>
            <span className="text-white/60">{describe(img).split(" · ").slice(1).join(" · ")}</span>
            <DialogPrimitive.Close className="ml-auto flex size-7 items-center justify-center rounded-md hover:bg-white/15" title="닫기 (Esc)">
              <XIcon className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="relative flex min-h-0 flex-1 items-center justify-center px-16 pb-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
            {error ? (
              <span className="text-sm text-white/80">그림을 읽지 못했어요: {error}</span>
            ) : src ? (
              <img src={src} alt={`붙인 그림 #${img.n}`} className={cn("max-h-full max-w-full object-contain shadow-2xl", src !== full?.url && "blur-[1px]")} draggable={false} />
            ) : null}
            <button className={cn(navBtn, "left-3")} title="앞 그림 (←)" disabled={index === 0} onClick={() => go(-1)}>
              <CaretLeftIcon className="size-5" />
            </button>
            <button className={cn(navBtn, "right-3")} title="다음 그림 (→)" disabled={index === images.length - 1} onClick={() => go(1)}>
              <CaretRightIcon className="size-5" />
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
