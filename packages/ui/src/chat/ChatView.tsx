// 에이전트 칸의 대화 보기: 터미널 원본 대신 대화 기록을 메시지 · 도구 줄로 그린다.
//
// - 모양은 AI 채팅 웹 화면을 따른다: 사용자 글은 오른쪽 말풍선, 답과 도구 줄은 왼쪽.
// - 내용은 데몬이 claude 대화 기록을 정규화해 준 조각이다 (`chat-state.ts`). 글자 하나씩 흘러나오지는 않고,
//   claude 가 조각(답 한 덩이, 도구 호출 하나)을 끝낼 때마다 한 줄씩 늘어난다.
// - 입력은 그 세션의 터미널로 그대로 간다 (claude 는 같은 TUI 로 돌고 있다). 그래서 [원본] 으로 바꾸면 같은 대화가 보인다.
// - 터미널을 그리지 않으므로 이 화면은 세션 크기(열 · 줄)를 건드리지 않는다. 폰과 데스크톱이 같은 세션을 같이 봐도 된다.
// - claude 가 묻는 창(AskUserQuestion)은 기록의 도구 입력으로 카드를 그리고 단추로 답한다.
// - 모델 · 생각 강도는 `/model 값` · `/effort 값` 으로 바꾼다 (값을 붙이면 claude 가 고르는 창을 띄우지 않는다. Orca 와 같다).
//   claude 가 터미널 화면에만 띄우는 창(/resume, /config …)은 [원본] 에서 다룬다. 화면 글을 읽어 옮기지 않는다.

import { ArrowDownIcon, ArrowUpIcon, CaretRightIcon, CheckIcon, StopIcon, TerminalWindowIcon, XIcon } from "@phosphor-icons/react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AgentInfo, ChatStatus, HostApi, SessionId, WorkspaceId } from "@thuminal/term-core";

import { Button } from "../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { cn } from "../lib/utils";
import { useApp, useModel } from "../store";
import { toBase64 } from "../terminal-controller";
import { type ChatDraft, chatFeed, type ChatFeed, draftKey, flatText as flat, loadDraft, type PendingSend, saveDraft, useAgentSessions, useChat, useClaudeCommands, useClaudeModels } from "./chat-state";
import { claudeCommands, effortChoices, modelLabel, needsArg, SEED_EFFORTS, SEED_MODELS, type SlashChoice, type SlashCommand, type SlashItem, slashItems, tokenLabel, unknownCommand } from "./slash";
import { type Answer, answerKeys, buildTimeline, duration, type Question, questionsOf, type Row, type ToolCall, toolSummary, tuiInputBox } from "./timeline";

const Markdown = lazy(() => import("../markdown"));

/** 키를 이어 보낼 때 사이 틈 (claude 묻는 창이 다음 화면을 그릴 시간) */
const KEY_GAP_MS = 180;

export interface ChatActions {
  openFile: (file: string, line?: number) => void;
  openUrl: (url: string, inApp: boolean) => void;
  notice: (text: string) => void;
}

/** 지난 때를 `방금` · `12분 전` · `3시간 전` · `5일 전` 으로 */
function agoLabel(at: number): string {
  const m = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  if (m < 1440) return `${Math.floor(m / 60)}시간 전`;
  return `${Math.floor(m / 1440)}일 전`;
}

/** 멈춘 뒤 claude 가 글을 입력창에 되돌려 놓았는지 보는 때 (앞 확인부터 잰 ms) */
const RESTORE_CHECKS_MS = [350, 500, 800];

/** 세션에 키 · 글을 보내는 것들 */
function useSender(host: HostApi, session: SessionId, feed: ChatFeed) {
  return useMemo(() => {
    let reclaims = 0;
    // 대화 보기는 터미널에 붙지 않는다. 붙은 세션에만 닿는 `input` 대신 요청(`send_text`)으로 넣는다
    const raw = (text: string) => host.sendText(session, text);
    const keys = async (list: string[]) => {
      for (const [i, k] of list.entries()) {
        if (i) await new Promise((r) => setTimeout(r, KEY_GAP_MS));
        await raw(k);
      }
    };
    return {
      raw,
      keys,
      /** 입력창에 글을 넣고 Enter. 여러 줄이나 긴 글은 붙여넣기로 감싸 한 번에 넣는다 */
      prompt: async (text: string, images: ChatDraft["images"] = []) => {
        // 슬래시 명령은 기록에 사용자 글로 남지 않는다
        if (!text.startsWith("/")) feed.addPending(text, images);
        else for (const i of images) URL.revokeObjectURL(i.url);
        // 그림은 파일 경로를 붙여 넣으면 claude 가 `[Image #N]` 으로 붙인다 (터미널에 그림을 붙여 넣을 때와 같다)
        if (images.length) {
          await raw(`\x1b[200~${images.map((i) => i.path).join(" ")}\x1b[201~`);
          await new Promise((r) => setTimeout(r, 600));
          if (!text) return void (await raw("\r"));
          await raw(" ");
        }
        const typed = !text.includes("\n") && text.length <= 400;
        await raw(typed ? text : `\x1b[200~${text}\x1b[201~`);
        // 붙여 넣은 글을 claude 가 받아 그릴 시간을 준다 (Orca 도 붙여넣기 뒤 0.5초 기다린다)
        await new Promise((r) => setTimeout(r, typed ? 80 : 500));
        await raw("\r");
      },
      interrupt: () => raw("\x1b"),
      /**
       * 일하는 claude 를 멈춘다. 막 보낸 글을 답이 나오기 전에 멈추면 claude 는 그 글을 자기 입력창에 되돌려 놓는다.
       * 그대로 두면 다음에 보내는 글이 그 뒤에 붙으므로, claude 입력창은 비우고(⌃C) 그 글을 돌려준다 (대화 보기 입력창에 넣는다).
       * 화면의 입력창 글이 우리가 보낸 글과 같을 때만 한다 (claude 가 흐리게 보이는 제안 글 · 터미널에서 직접 친 글은 건드리지 않는다)
       */
      interruptAndReclaim: async (): Promise<ChatDraft | null> => {
        // 잇달아 멈추면 맨 나중 것만 입력창을 비운다 (⌃C 가 두 번 가면 claude 가 끝난다)
        const mine = ++reclaims;
        await raw("\x1b");
        for (const wait of RESTORE_CHECKS_MS) {
          await new Promise((r) => setTimeout(r, wait));
          const box = tuiInputBox(await host.readScreen(session, false).catch(() => ""));
          if (mine !== reclaims) return null;
          if (!box) continue;
          const want = flat(box);
          const withImage = /\[Image #\d+\]/.test(box);
          if (!want && !withImage) continue;
          const snap = feed.get();
          // 줄 서 있던 글 여럿은 한 덩어리로 돌아온다. 끝에서부터 이어 붙여 같은 것을 찾는다
          const tail = <T,>(list: T[], text: (x: T) => string): T[] | null => {
            for (let k = 1; k <= list.length; k++) {
              const run = list.slice(-k);
              if (flat(run.map(text).join("")) === want) return run;
            }
            return null;
          };
          const pending = tail(snap.pending, (p) => p.text);
          // 그림만 보낸 글은 글이 비어 있어 그림 표시로 가린다
          if (pending && !want && !pending.some((p) => p.images.length)) continue;
          const sent = pending ? null : want ? tail(snap.items.flatMap((i) => (i.type === "user" ? [i.text] : [])).slice(-4), (t) => t) : null;
          if (!pending && !sent) continue;
          await raw("\x03");
          const taken = (pending ?? []).map((p) => feed.takePending(p.id) ?? p);
          const texts = (pending ? taken.map((p) => p.text) : sent!).filter(Boolean);
          // claude 대화에서는 빠진 글이다. 말풍선으로 남기지 않는다
          feed.retract(texts);
          return { text: texts.join("\n"), images: taken.flatMap((p) => p.images) };
        }
        return null;
      },
    };
  }, [host, session, feed]);
}

export function ChatView({
  ws,
  session,
  keyboard,
  onActivate,
  onTerminal,
  compact,
}: {
  ws: WorkspaceId;
  session: SessionId;
  /** 이 칸이 키보드를 받는다 (입력창에 포커스를 둔다) */
  keyboard: boolean;
  /** 눌러서 이 칸을 고를 때 */
  onActivate?: () => void;
  /** 원본(터미널)으로 바꾼다 */
  onTerminal: () => void;
  /** 폰 화면: 글자와 누를 자리를 키운다 */
  compact?: boolean;
}) {
  const model = useModel();
  const host = model.services.host;
  const feed = chatFeed(host, model.hostKey, session);
  const snap = useChat(feed);
  const agent = useApp((s) => s.sessions[session]?.agent ?? null);
  const send = useSender(host, session, feed);
  // 쓰다 만 글은 세션마다 따로 둔다 (칸이 사라졌다 돌아와도 남는다)
  const draft = draftKey(model.hostKey, session, useApp((s) => s.sessions[session]?.created_at ?? 0));
  const timeline = useMemo(() => buildTimeline(snap.hidden.size ? snap.items.filter((i) => !snap.hidden.has(i.id)) : snap.items), [snap.items, snap.hidden]);

  const actions = useMemo<ChatActions>(
    () => ({
      openFile: (file, line) => model.openDoc(line ? { kind: "file", file, line: String(line) } : { kind: "file", file }),
      openUrl: (url, inApp) => {
        if (inApp && host.browser) void model.newBrowserTab(ws, url).catch(model.fail);
        else if (host.openUrl) void host.openUrl(url).catch(model.fail);
        else window.open(url, "_blank", "noopener");
      },
      notice: model.notice,
    }),
    [model, host, ws],
  );

  // 맨 아래를 보고 있으면 새 줄을 따라 내려간다. 위로 올려 읽는 중이면 그대로 두고 [맨 아래로] 를 띄운다
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setAtBottom(true);
  }, []);
  const state = agent?.state;
  useLayoutEffect(() => {
    if (stick.current) toBottom();
  }, [timeline, snap.pending, state, toBottom]);
  // 답 안의 그림 · 코드가 늦게 자리 잡아도 따라 내려간다
  // 화면 키보드가 올라와 틀이 줄어도 마찬가지다
  useEffect(() => {
    const el = scroller.current;
    if (!el?.firstElementChild) return;
    const obs = new ResizeObserver(() => stick.current && toBottom());
    obs.observe(el);
    obs.observe(el.firstElementChild);
    return () => obs.disconnect();
  }, [toBottom]);
  // 사용자가 직접 굴렸을 때만 따라 내려가기를 푼다 (내용이 늘거나 틀이 줄어 생긴 스크롤 이벤트에 풀리지 않게)
  const gesture = useRef(0);
  const touched = () => {
    gesture.current = Date.now();
  };

  // 목록에 없는 슬래시 명령을 방금 보냈다 (claude 가 터미널 화면에 창을 띄웠을 수 있다고 알리는 줄). 대화가 늘거나 턴이 시작되면 지운다
  const [slash, setSlash] = useState<string | null>(null);
  useEffect(() => setSlash(null), [snap.items, state]);
  // 권한 모드는 claude 가 턴 사이에 어디에도 알리지 않아, 터미널 화면의 모드 줄 한 줄에서만 읽는다 (보이는 것은 thuminal 이 그린다)
  const [mode, setMode] = usePermissionMode(host, session, state);
  // 모델 · 생각 강도 목록은 claude 에게서 받는다 (Orca 와 같다). 받기 전 · 못 받았을 때는 손으로 적어 둔 것
  const listed = useClaudeModels(host, model.hostKey);
  // 지난 대화 목록은 입력창에 `/` 를 칠 때마다 다시 읽는다
  const [slashTick, setSlashTick] = useState(0);
  const past = useAgentSessions(host, model.hostKey, session, slashTick);
  const skills = useClaudeCommands(host, model.hostKey, session);
  const { models, efforts, commands } = useMemo(() => {
    const models: SlashChoice[] = listed.length ? listed.map((m) => ({ value: m.value, desc: m.value === "default" && m.description ? m.description.split(" · ")[0] : m.label })) : SEED_MODELS;
    // 지금 모델이 받는 강도만 보인다
    const now = snap.status.model ?? agent?.model ?? "";
    const cur = listed.find((m) => m.resolved === now || m.label === now || m.value === now);
    const efforts = cur?.efforts?.length ? effortChoices(cur.efforts) : SEED_EFFORTS;
    const sessions: SlashChoice[] = past.map((s) => ({ value: s.id, label: s.title, desc: agoLabel(s.modified) }));
    const extra: SlashCommand[] = skills.map((c) => ({ name: c.name, desc: c.description ?? "" }));
    return { models, efforts, commands: claudeCommands(models, efforts, sessions, extra) };
  }, [listed, past, skills, snap.status.model, agent?.model]);

  const waiting = state === "needs_attention";
  const working = state === "working";
  const questions = waiting && timeline.open ? questionsOf(timeline.open) : null;
  // 훅이 기록보다 먼저 온다. 묻는 도구가 기록에 나타날 틈을 주고, 그래도 없을 때만 "원본에서 확인" 카드를 띄운다
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    setSettled(false);
    if (!waiting || questions) return;
    const t = window.setTimeout(() => setSettled(true), 1500);
    return () => window.clearTimeout(t);
  }, [waiting, !!questions]);

  return (
    <div className={cn("absolute inset-0 z-[7] flex flex-col bg-background text-foreground", compact ? "text-[15px]" : "text-[13px]")} onPointerDown={onActivate}>
      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain thm-scroll"
        onWheel={touched}
        onTouchMove={touched}
        onPointerDown={touched}
        onKeyDown={touched}
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (!bottom && Date.now() - gesture.current > 1500) return;
          stick.current = bottom;
          if (bottom !== atBottom) setAtBottom(bottom);
        }}
      >
        <div className={cn("mx-auto flex w-full max-w-4xl flex-col gap-3 select-text", compact ? "px-3 py-3" : "px-5 py-4")}>
          {snap.more && (
            <button className="self-center rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => feed.loadAll()}>
              이전 대화
            </button>
          )}
          {snap.loaded && !timeline.rows.length && !snap.pending.length && (
            <p className="py-10 text-center text-muted-foreground">{snap.error ? `대화 기록을 읽지 못했어요: ${snap.error}` : "아직 대화가 없어요."}</p>
          )}
          {timeline.rows.map((row) => (
            <RowView key={row.id} row={row} host={host} session={session} ws={ws} actions={actions} scroller={scroller} live={working || waiting} openId={timeline.open?.id ?? null} />
          ))}
          {snap.pending.map((p) => (
            <PendingRow key={p.id} p={p} working={working} onDrop={() => feed.dropPending(p.id)} />
          ))}
          {working && <WorkingRow agent={agent!} />}
          {state === "failed" && <p className="text-agent-failed">턴이 오류로 끝났어요. 원본에서 내용을 확인해 주세요.</p>}
        </div>
      </div>
      {!atBottom && (
        <button
          className="absolute right-4 bottom-24 z-[1] flex size-7 items-center justify-center rounded-full border bg-popover text-popover-foreground shadow-md hover:bg-accent"
          title="맨 아래로"
          onClick={toBottom}
        >
          <ArrowDownIcon className="size-3.5" />
        </button>
      )}
      <div className={cn("mx-auto w-full max-w-4xl shrink-0", compact ? "px-2 pb-2" : "px-4 pb-3")}>
        {waiting &&
          (questions ? (
            <AskCard key={timeline.open!.id} questions={questions} onAnswer={(answers) => void send.keys(answerKeys(questions, answers))} onCancel={() => void send.interrupt()} onTerminal={onTerminal} />
          ) : !settled ? null : (
            <WaitCard tool={timeline.open} agent={agent!} onAllow={() => void send.raw("1")} onDeny={() => void send.interrupt()} onTerminal={onTerminal} />
          ))}
        {slash && (
          <div className="mb-1.5 flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-mono">{slash}</span> 명령을 보냈어요. claude 화면에 창이 떴을 수 있어요.
            </span>
            <button className="shrink-0 rounded px-1.5 py-0.5 text-foreground hover:bg-accent" onClick={onTerminal}>
              원본
            </button>
            <button className="flex size-4 shrink-0 items-center justify-center rounded hover:bg-foreground/10" title="닫기" onClick={() => setSlash(null)}>
              <XIcon className="size-3" />
            </button>
          </div>
        )}
        <Composer
          key={draft}
          draft={draft}
          host={host}
          keyboard={keyboard && !questions}
          working={working}
          compact={compact}
          onSend={(t, images) => {
            toBottom();
            void send.prompt(t, images).catch(model.fail);
            // 목록에 없는 명령(/resume, /config …)은 claude 가 터미널 화면에 창을 띄우기도 한다. 기록에 남지 않으므로
            // 보기는 그대로 두고 원본으로 가는 길만 알린다 (Orca 도 이런 명령은 터미널에 맡긴다)
            setSlash(unknownCommand(t, commands));
          }}
          onInterrupt={() => send.interruptAndReclaim().catch(() => null)}
          onError={model.fail}
          onSlash={() => setSlashTick((n) => n + 1)}
          commands={commands}
        />
        <StatusLine
          status={snap.status}
          agent={agent}
          models={models}
          efforts={efforts}
          busy={working || waiting}
          mode={mode}
          onMode={(target) => void setMode(target).then((ok) => ok || model.notice("이 세션에서는 그 권한 모드로 바꿀 수 없어요"))}
          onCommand={(t) => void send.prompt(t).catch(model.fail)}
        />
      </div>
    </div>
  );
}

const RowView = memo(function RowView({
  row,
  host,
  session,
  ws,
  actions,
  scroller,
  live,
  openId,
}: {
  row: Row;
  host: HostApi;
  session: SessionId;
  ws: WorkspaceId;
  actions: ChatActions;
  scroller: React.RefObject<HTMLDivElement | null>;
  /** 에이전트가 일하거나 묻는 중 (결과 없는 도구를 도는 중으로 그린다) */
  live: boolean;
  openId: string | null;
}) {
  switch (row.kind) {
    case "user":
      return (
        <div className="max-w-[80%] self-end rounded-2xl rounded-br-md bg-muted px-3.5 py-2 break-words whitespace-pre-wrap">
          {row.images.length > 0 && (
            <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
              {row.images.map((id) => (
                <ChatImage key={id} host={host} session={session} id={id} />
              ))}
            </div>
          )}
          {row.text}
        </div>
      );
    case "assistant":
      return (
        <div className="thm-chat-md min-w-0">
          <Suspense fallback={<div className="whitespace-pre-wrap">{row.text}</div>}>
            <Markdown host={host} worktree={ws} file="" text={row.text} scroller={() => scroller.current} openFile={actions.openFile} openUrl={actions.openUrl} notice={actions.notice} />
          </Suspense>
          {row.turnMs !== undefined && row.turnMs >= 1000 && <p className="mt-1.5 text-[11px] text-muted-foreground/70" title="턴에 걸린 시간">{duration(row.turnMs)}</p>}
        </div>
      );
    case "thinking":
      return (
        <details className="text-muted-foreground">
          <summary className="cursor-default text-xs">생각</summary>
          <div className="mt-1 border-l pl-3 whitespace-pre-wrap">{row.text}</div>
        </details>
      );
    case "tools":
      return (
        <div className="flex flex-col">
          {row.tools.map((t) => (
            <ToolRow key={t.id} tool={t} ws={ws} running={live && !t.result && t.id === openId} session={session} actions={actions} scroller={scroller} />
          ))}
        </div>
      );
    case "notice":
      return <NoticeRow type={row.type} text={row.text} />;
  }
});

function NoticeRow({ type, text }: { type: string; text: string }) {
  switch (type) {
    case "command":
      return <p className="font-mono text-xs text-muted-foreground">{text}</p>;
    case "command_output":
      return <pre className="overflow-x-auto border-l pl-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{text}</pre>;
    case "teammate": {
      const [from, ...body] = text.split("\n");
      return (
        <div className="rounded-md border px-3 py-2 break-words whitespace-pre-wrap">
          <p className="mb-0.5 text-[11px] text-muted-foreground">팀원 {from}</p>
          {body.join("\n")}
        </div>
      );
    }
    case "compact":
      return <Divider>대화 압축</Divider>;
    case "interrupted":
      return <p className="text-xs text-muted-foreground">중단</p>;
    case "error":
      return <p className="break-words whitespace-pre-wrap text-agent-failed">{text}</p>;
    default:
      return <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">{text}</p>;
  }
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      {children}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** 워크트리 안 경로는 워크트리 기준으로 줄여 보인다 */
function shortPath(s: string, ws: WorkspaceId): string {
  return s.startsWith(`${ws}/`) ? s.slice(ws.length + 1) : s;
}

/** 도구 호출 한 줄. 누르면 입력과 결과를 편다. 실패한 도구는 결과 첫 줄을 바로 보인다 */
function ToolRow({
  tool,
  ws,
  running,
  session,
  actions,
  scroller,
}: {
  tool: ToolCall;
  ws: WorkspaceId;
  running: boolean;
  session: SessionId;
  actions: ChatActions;
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const failed = tool.result?.isError;
  const summary = shortPath(toolSummary(tool), ws);
  return (
    <div className="min-w-0">
      <button className="group flex w-full min-w-0 items-center gap-2 rounded px-1 py-1 text-left hover:bg-accent/60" onClick={() => setOpen((v) => !v)}>
        <span className="flex size-3 shrink-0 items-center justify-center">
          {running ? (
            <span className="thm-spinner block size-2 rounded-full border-2 border-agent-working border-t-transparent" />
          ) : (
            <span className={cn("size-1.5 rounded-full", failed ? "bg-agent-failed" : tool.result ? "bg-muted-foreground/50" : "bg-muted-foreground/25")} />
          )}
        </span>
        <span className="shrink-0 font-mono text-xs font-medium">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{summary}</span>
        <CaretRightIcon className={cn("size-3 shrink-0 text-muted-foreground opacity-0 transition-transform group-hover:opacity-100", open && "rotate-90 opacity-100")} />
      </button>
      {failed && !open && <p className="truncate pl-6 font-mono text-xs text-agent-failed">{tool.result!.text.split("\n").find((l) => l.trim()) ?? "실패"}</p>}
      {open && <ToolDetail tool={tool} />}
      {open && (tool.name === "Agent" || tool.name === "Task") && <SubagentChat tool={tool} ws={ws} session={session} actions={actions} scroller={scroller} />}
    </div>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
/** claude 에게만 주는 안내라 보여 줄 것이 없는 도구 결과 (서브에이전트 · 팀원을 띄웠다는 알림) */
const INTERNAL_RESULT = /^(Async agent launched successfully|Spawned successfully)/;

function ToolDetail({ tool }: { tool: ToolCall }) {
  const i = tool.input;
  const block = "max-h-80 overflow-auto rounded border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-words thm-scroll";
  let input: React.ReactNode;
  if (tool.name === "Bash") input = <pre className={block}>{str(i.command)}</pre>;
  else if (tool.name === "Edit" || tool.name === "MultiEdit") {
    const edits = Array.isArray(i.edits) ? (i.edits as Record<string, unknown>[]) : [i];
    input = edits.map((e, n) => (
      <div key={n} className={cn(block, "p-0")}>
        <pre className="bg-agent-failed/10 p-2 whitespace-pre-wrap">{str(e.old_string)}</pre>
        <pre className="bg-agent-working/10 p-2 whitespace-pre-wrap">{str(e.new_string)}</pre>
      </div>
    ));
  } else if (tool.name === "Write") input = <pre className={block}>{str(i.content)}</pre>;
  else if (tool.name === "TodoWrite" && Array.isArray(i.todos)) {
    input = (
      <ul className="flex flex-col gap-0.5 text-xs">
        {(i.todos as Record<string, unknown>[]).map((t, n) => (
          <li key={n} className={cn(t.status === "completed" && "text-muted-foreground line-through", t.status === "in_progress" && "font-medium")}>
            {t.status === "completed" ? "☑" : "☐"} {str(t.content)}
          </li>
        ))}
      </ul>
    );
  } else if (tool.name === "Agent" || tool.name === "Task") input = <pre className={block}>{str(i.prompt)}</pre>;
  else if (Object.keys(i).length) input = <pre className={block}>{JSON.stringify(i, null, 2)}</pre>;
  return (
    <div className="mt-1 mb-2 ml-6 flex flex-col gap-1.5">
      {input}
      {tool.result && tool.result.text.trim() && !INTERNAL_RESULT.test(tool.result.text) && (
        <pre className={cn(block, tool.result.isError && "border-agent-failed/40 text-agent-failed")}>
          {tool.result.text}
          {tool.result.truncated && "\n… (뒤는 잘렸어요)"}
        </pre>
      )}
    </div>
  );
}

/** 서브에이전트가 한 일: 그 서브에이전트의 대화 기록을 같은 줄 모양으로 그린다. 펴 둔 동안 2초마다 따라간다 */
function SubagentChat({ tool, ws, session, actions, scroller }: { tool: ToolCall; ws: WorkspaceId; session: SessionId; actions: ChatActions; scroller: React.RefObject<HTMLDivElement | null> }) {
  const model = useModel();
  const host = model.services.host;
  const feed = chatFeed(host, model.hostKey, session, tool.id);
  const snap = useChat(feed, 2000);
  // 맨 앞 사용자 글은 위에 이미 보인 프롬프트다
  const rows = useMemo(() => buildTimeline(snap.items).rows.filter((r, i) => !(i === 0 && r.kind === "user")), [snap.items]);
  if (!snap.loaded) return null;
  return (
    <div className="mb-2 ml-6 flex max-h-72 flex-col gap-2 overflow-y-auto overscroll-contain border-l pl-3 thm-scroll">
      {snap.more && (
        <button className="self-start rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => feed.loadAll()}>
          이전 내용
        </button>
      )}
      {rows.length ? (
        rows.map((row) => <RowView key={row.id} row={row} host={host} session={session} ws={ws} actions={actions} scroller={scroller} live={false} openId={null} />)
      ) : (
        <p className="text-xs text-muted-foreground">서브에이전트가 남긴 기록이 아직 없어요.</p>
      )}
    </div>
  );
}

/** 사용자가 붙여 보낸 그림의 작은 판 */
function ChatImage({ host, session, id }: { host: HostApi; session: SessionId; id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    host.agentImage(session, id, true).then(
      (r) => alive && setSrc(`data:${r.mediaType};base64,${r.data}`),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [host, session, id]);
  if (!src) return <span className="h-16 w-24 rounded border bg-muted" />;
  return (
    <>
      <button className="cursor-zoom-in rounded" title="크게 보기" onClick={() => setOpen(true)}>
        <img src={src} alt="붙인 그림" className="max-h-28 rounded border" />
      </button>
      {open && <ImagePopup host={host} session={session} id={id} thumb={src} onClose={() => setOpen(false)} />}
    </>
  );
}

/** 붙인 그림을 창 가득 크게 본다. 원본을 받는 동안은 작은 판을 늘려 보인다. Esc 나 그림 밖을 누르면 닫는다 */
function ImagePopup({ host, session, id, thumb, onClose }: { host: HostApi; session: SessionId; id: string; thumb: string; onClose: () => void }) {
  const [full, setFull] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    host.agentImage(session, id, false).then(
      (r) => alive && setFull(`data:${r.mediaType};base64,${r.data}`),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [host, session, id]);
  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <DialogPrimitive.Content aria-describedby={undefined} className="fixed inset-0 z-50 flex flex-col outline-none" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
          <div className="flex h-10 shrink-0 items-center px-4 text-xs text-white/80">
            <DialogPrimitive.Title className="font-medium text-white">붙인 그림</DialogPrimitive.Title>
            {error && <span className="ml-3 text-white/60">원본을 읽지 못했어요: {error}</span>}
            <DialogPrimitive.Close className="ml-auto flex size-7 items-center justify-center rounded-md hover:bg-white/15" title="닫기 (Esc)">
              <XIcon className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center px-8 pb-6" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
            <img src={full ?? thumb} alt="붙인 그림" className={cn("max-h-full max-w-full object-contain shadow-2xl", !full && "min-h-[40%] blur-[1px]")} draggable={false} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PendingRow({ p, working, onDrop }: { p: PendingSend; working: boolean; onDrop: () => void }) {
  return (
    <div className="flex max-w-[80%] items-start gap-2 self-end rounded-2xl rounded-br-md bg-muted/50 px-3.5 py-2 text-muted-foreground">
      <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
        {p.images.length > 0 && (
          <span className="mb-1 flex flex-wrap gap-1.5">
            {p.images.map((i) => (
              <img key={i.path} src={i.url} alt="붙인 그림" className="h-14 rounded border object-cover" />
            ))}
          </span>
        )}
        {p.text}
      </span>
      <span className="shrink-0 text-[11px]">{working ? "대기 중" : "보내는 중"}</span>
      <button className="flex size-4 shrink-0 items-center justify-center rounded hover:bg-foreground/10" title="지우기" onClick={onDrop}>
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

function WorkingRow({ agent }: { agent: AgentInfo }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
      <span className="thm-spinner block size-2 rounded-full border-2 border-agent-working border-t-transparent" />
      작업 중 {duration(Math.max(0, Date.now() - agent.updated_at))}
    </div>
  );
}

/**
 * claude 가 묻는 창(AskUserQuestion). 질문을 하나씩 보이고, 여럿이면 위 이름표나 [이전] · [다음] 으로 오간다.
 * 여기서 고르거나 직접 쓰면 묻는 창에 같은 키를 넣는다
 */
function AskCard({ questions, onAnswer, onCancel, onTerminal }: { questions: Question[]; onAnswer: (answers: Answer[]) => void; onCancel: () => void; onTerminal: () => void }) {
  const [answers, setAnswers] = useState<Answer[]>(() => questions.map(() => ({ picks: [], other: "" })));
  const [at, setAt] = useState(0);
  const [sent, setSent] = useState(false);
  const many = questions.length > 1;
  // 질문 하나에 하나 고르기면 누르자마자 보낸다
  const instant = !many && !questions[0].multi;
  const done = (a: Answer) => a.picks.length > 0 || !!a.other.trim();
  const ready = answers.some(done);
  const last = at === questions.length - 1;
  const q = questions[at];
  const a = answers[at];
  const submit = (list: Answer[]) => {
    setSent(true);
    onAnswer(list);
    // 키가 먹지 않았으면(묻는 창이 다른 자리에 있었다) 다시 고를 수 있게 한다
    window.setTimeout(() => setSent(false), 6000);
  };
  const patch = (next: Partial<Answer>) => answers.map((x, i) => (i === at ? { ...x, ...next } : x));
  const pick = (oi: number) => {
    // 하나 고르기에서 선택지를 누르면 직접 쓴 답은 버린다 (둘 중 하나만 보낼 수 있다)
    const next = patch(q.multi ? { picks: a.picks.includes(oi) ? a.picks.filter((x) => x !== oi) : [...a.picks, oi].sort((x, y) => x - y) } : { picks: [oi], other: "" });
    setAnswers(next);
    if (instant) submit(next);
    // 하나 고르기는 고르면 다음 질문으로 넘어간다
    else if (!q.multi && !last) setAt(at + 1);
  };
  return (
    <div className={cn("mb-2 flex flex-col gap-2.5 rounded-lg border border-agent-attention/50 bg-card p-3", sent && "pointer-events-none opacity-60")}>
      {many && (
        <div className="flex flex-wrap items-center gap-1">
          {questions.map((x, i) => (
            <button
              key={i}
              className={cn("flex h-6 items-center gap-1 rounded-md px-2 text-xs", i === at ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
              onClick={() => setAt(i)}
            >
              {done(answers[i]) && <CheckIcon weight="bold" className="size-3 text-agent-done" />}
              {x.header || `질문 ${i + 1}`}
            </button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {at + 1}/{questions.length}
          </span>
        </div>
      )}
      <p className="font-medium">
        {q.question}
        {q.multi && <span className="ml-1.5 text-xs font-normal text-muted-foreground">여러 개 선택</span>}
      </p>
      <div className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto thm-scroll">
        {q.options.map((o, oi) => {
          const on = a.picks.includes(oi);
          return (
            <button key={oi} className={cn("flex flex-col rounded-md border px-2.5 py-1.5 text-left hover:bg-accent", on && "border-primary bg-primary/10")} onClick={() => pick(oi)}>
              <span>{o.label}</span>
              {o.description && o.description !== o.label && <span className="text-xs text-muted-foreground">{o.description}</span>}
            </button>
          );
        })}
        <input
          // 질문마다 새 칸이다 (앞 질문에 쓰던 조합 중 글자가 넘어오지 않게)
          key={at}
          className={cn("rounded-md border bg-transparent px-2.5 py-1.5 outline-none placeholder:text-muted-foreground/70 focus:border-ring", a.other.trim() && "border-primary bg-primary/10")}
          placeholder="직접 입력"
          aria-label="직접 입력"
          value={a.other}
          onChange={(e) => setAnswers(patch(q.multi ? { other: e.target.value } : { other: e.target.value, picks: [] }))}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229 || e.key !== "Enter") return;
            if (!last) setAt(at + 1);
            else if (ready) submit(answers);
          }}
        />
      </div>
      <div className="flex items-center gap-2">
        {many && (
          <>
            <Button size="xs" variant="outline" disabled={at === 0} onClick={() => setAt(at - 1)}>
              이전
            </Button>
            <Button size="xs" variant="outline" disabled={last} onClick={() => setAt(at + 1)}>
              다음
            </Button>
          </>
        )}
        <Button size="xs" disabled={!ready} onClick={() => submit(answers)}>
          보내기
        </Button>
        <Button size="xs" variant="outline" onClick={onCancel}>
          취소
        </Button>
        <button className="ml-auto text-xs text-muted-foreground hover:text-foreground" onClick={onTerminal}>
          원본
        </button>
      </div>
    </div>
  );
}

/** claude 권한 모드. label 은 claude 가 쓰는 이름 그대로, desc 는 목록을 펼쳤을 때만 보이는 설명, screen 은 claude 터미널 화면의 모드 줄에 나오는 글이다 */
const MODES = [
  { id: "default", label: "manual", desc: "도구마다 승인", screen: "manual mode on" },
  { id: "acceptEdits", label: "accept edits", desc: "파일 수정 자동 승인", screen: "accept edits on" },
  { id: "plan", label: "plan", desc: "수정 없이 계획만", screen: "plan mode on" },
  { id: "auto", label: "auto", desc: "위험한 작업만 승인", screen: "auto mode on" },
  { id: "bypassPermissions", label: "bypass permissions", desc: "승인 없이 실행", screen: "bypass permissions on" },
] as const;
type ModeId = (typeof MODES)[number]["id"];

/** 터미널 화면 글 맨 아래 몇 줄에서 지금 권한 모드를 읽는다. 모드 줄이 없으면 null */
function modeOnScreen(screen: string): ModeId | null {
  const tail = screen.trimEnd().split("\n").slice(-4).join("\n");
  return MODES.find((m) => tail.includes(m.screen))?.id ?? null;
}

/**
 * 지금 권한 모드와, 모드를 바꾸는 함수. claude 는 권한 모드를 shift+tab 으로 돌려 가며 바꾸고, 바뀐 모드를 다음 턴 전에는
 * 기록 · 훅 · 상태 줄 어디에도 알리지 않는다. 그래서 화면의 모드 줄을 읽어 확인한다: 바꿀 때는 shift+tab 을 한 번씩 보내며
 * 원하는 모드가 될 때까지 본다 (한 바퀴 돌아도 없으면 그 세션에서 쓸 수 없는 모드다. 처음 모드로 돌아와 있다)
 */
function usePermissionMode(host: HostApi, session: SessionId, state: string | undefined): [ModeId | null, (target: ModeId) => Promise<boolean>] {
  const [mode, setMode] = useState<ModeId | null>(null);
  const read = useCallback(
    () =>
      host.readScreen(session, false).then(
        (text) => {
          const m = modeOnScreen(text);
          if (m) setMode(m);
          return m;
        },
        () => null,
      ),
    [host, session],
  );
  // 원본 화면에서 바꾼 것도 따라가게 가끔 다시 읽는다. 턴이 시작 · 끝나면 바로 읽는다
  useEffect(() => {
    void read();
    const t = window.setInterval(() => void read(), 5000);
    return () => window.clearInterval(t);
  }, [read, state]);
  const change = useCallback(
    async (target: ModeId) => {
      const start = await read();
      if (!start) return false;
      let now: ModeId | null = start;
      for (let i = 0; i < 8 && now !== target; i++) {
        await host.sendText(session, "\x1b[Z");
        // claude 가 모드 줄을 다시 그릴 틈
        for (let k = 0; k < 10; k++) {
          await new Promise((r) => setTimeout(r, 120));
          const m = await read();
          if (m && m !== now) {
            now = m;
            break;
          }
        }
        if (now === start) break;
      }
      return now === target;
    },
    [host, session, read],
  );
  return [mode, change];
}

/** 묻는 도구가 아닌데 claude 가 사용자를 기다린다: 도구 권한 확인이거나 다른 창이다 */
function WaitCard({ tool, agent, onAllow, onDeny, onTerminal }: { tool: ToolCall | null; agent: AgentInfo; onAllow: () => void; onDeny: () => void; onTerminal: () => void }) {
  const permission = tool && !tool.result && tool.name === agent.tool_name && tool.name !== "AskUserQuestion";
  return (
    <div className="mb-2 flex flex-col gap-2 rounded-lg border border-agent-attention/50 bg-card p-3">
      {permission ? (
        <>
          <p className="font-medium">claude가 {tool.name} 실행을 허용할지 물어요</p>
          <p className="truncate font-mono text-xs text-muted-foreground">{toolSummary(tool)}</p>
          <div className="flex items-center gap-2">
            <Button size="xs" onClick={onAllow}>
              허용
            </Button>
            <Button size="xs" variant="outline" onClick={onDeny}>
              거절
            </Button>
            <button className="ml-auto text-xs text-muted-foreground hover:text-foreground" onClick={onTerminal}>
              원본
            </button>
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1">claude가 응답을 기다려요.</p>
          <Button size="xs" onClick={onTerminal}>
            <TerminalWindowIcon />
            원본
          </Button>
        </div>
      )}
    </div>
  );
}

interface Attached {
  /** 데몬 쪽 임시 파일 경로 (claude 입력창에 붙여 넣는다) */
  path: string;
  /** 미리 보기 주소 */
  url: string;
}

function Composer({
  host,
  keyboard,
  working,
  compact,
  onSend,
  onInterrupt,
  onError,
  onSlash,
  commands,
  draft,
}: {
  /** 쓰다 만 글 · 붙인 그림을 둘 곳 (`draftKey`). 이 키가 바뀌면 입력창을 새로 만든다 */
  draft: string;
  /** `/` 목록에 올릴 명령 */
  commands: SlashCommand[];
  /** `/` 를 치기 시작했다 */
  onSlash: () => void;
  host: HostApi;
  keyboard: boolean;
  working: boolean;
  compact?: boolean;
  onSend: (text: string, images: ChatDraft["images"]) => void;
  /** 멈춘다. claude 가 입력창에 되돌려 놓은 글이 있으면 그것을 돌려준다 */
  onInterrupt: () => Promise<ChatDraft | null>;
  onError: (e: unknown) => void;
}) {
  // 다른 탭 · 워크트리에 다녀오면 이 입력창은 없어졌다 다시 생긴다. 쓰던 것은 밖(chat-state)에 두고 이어 쓴다
  const [text, setText] = useState(() => loadDraft(draft).text);
  const [images, setImages] = useState<Attached[]>(() => loadDraft(draft).images);
  useEffect(() => saveDraft(draft, { text, images }), [draft, text, images]);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // 폰은 화면 키보드가 저절로 올라오지 않게 누를 때만 포커스를 준다
    if (keyboard && !compact) ref.current?.focus({ preventScroll: true });
  }, [keyboard, compact]);
  // 글에 맞춰 높이를 키운다 (칸 높이의 40% 까지)
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.max(120, window.innerHeight * 0.4))}px`;
  }, [text]);

  // `/` 명령 목록: `/낱말` 만 쳤을 때 입력창 위에 띄운다. 닫은 글(Esc)에는 다시 띄우지 않는다
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const matches = closedFor === text ? null : slashItems(text, commands);
  const menu = matches?.length ? matches : null;
  // 값이 있는 명령(/model)은 값 목록으로 넘어가고, 나머지는 바로 보낸다
  const choose = (item: SlashItem) => (item.send ? send(item.text) : setText(item.text));
  const pickAt = menu ? Math.min(cursor, menu.length - 1) : 0;
  useEffect(() => {
    setCursor(0);
    // Esc 로 닫은 것은 그 글에만 해당한다. 글이 바뀌면(지웠다 다시 치면) 다시 띄운다
    setClosedFor((c) => (c !== null && c !== text ? null : c));
  }, [text]);
  const slashing = text.startsWith("/");
  useEffect(() => {
    if (slashing) onSlash();
  }, [slashing]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = (t: string) => {
    if (!t && !images.length) return;
    // 그림 미리 보기 주소는 보낸 글이 기록에 나타날 때 놓는다 (멈추면 입력창으로 되돌린다)
    onSend(t, images);
    setImages([]);
    setText("");
  };
  // 멈춘 글이 돌아오면 쓰던 글 앞에 넣는다
  const interrupt = () =>
    void onInterrupt().then((back) => {
      if (!back) return;
      setText((cur) => (cur ? `${back.text}\n${cur}` : back.text));
      setImages((cur) => [...back.images, ...cur]);
    });
  const submit = () => {
    const t = text.trim();
    // 값이 있어야 하는 명령(/model, /effort)은 값 없이 보내지 않는다 (claude 가 터미널 화면에 고르는 창을 띄운다). 값 목록을 띄운다
    const bare = needsArg(t, commands);
    if (bare) {
      setClosedFor(null);
      return setText(`/${bare.name} `);
    }
    send(t);
  };
  // 그림은 데몬 쪽 임시 파일로 써 두고 보낼 때 그 경로를 claude 입력창에 붙여 넣는다
  const attach = async (files: File[]) => {
    for (const f of files) {
      const ext = f.type.slice("image/".length).replace("jpeg", "jpg").replace(/\+.*$/, "") || "png";
      try {
        const path = await host.savePasteImage(await toBase64(f), ext);
        setImages((list) => [...list, { path, url: URL.createObjectURL(f) }]);
      } catch (e) {
        onError(`그림을 붙이지 못했어요: ${e}`);
      }
    }
  };
  const imagesOf = (list: FileList | undefined | null) => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));

  return (
    <div className="relative">
      {menu && <SlashMenu items={menu} at={pickAt} onHover={setCursor} onPick={choose} />}
      <div
        className="flex flex-col gap-1.5 rounded-lg border bg-card p-1.5 focus-within:border-ring"
        onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
        onDrop={(e) => {
          const files = imagesOf(e.dataTransfer.files);
          if (!files.length) return;
          e.preventDefault();
          void attach(files);
        }}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-1 pt-1">
            {images.map((img) => (
              <span key={img.path} className="group relative">
                <img src={img.url} alt="붙인 그림" className="h-14 rounded border object-cover" />
                <button
                  className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full border bg-popover text-popover-foreground shadow-sm hover:bg-accent"
                  title="그림 빼기"
                  onClick={() => (URL.revokeObjectURL(img.url), setImages((list) => list.filter((x) => x.path !== img.path)))}
                >
                  <XIcon className="size-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            ref={ref}
            rows={1}
            className={cn("min-h-7 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 outline-none placeholder:text-muted-foreground/70 thm-scroll", compact && "text-[16px]")}
            placeholder="메시지 입력"
            value={text}
            enterKeyHint="send"
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = imagesOf(e.clipboardData.files);
              if (!files.length) return;
              e.preventDefault();
              void attach(files);
            }}
            onKeyDown={(e) => {
              // 한글 조합 중의 Enter 는 조합을 끝내는 것이다
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (menu) {
                const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
                if (move) {
                  e.preventDefault();
                  return setCursor((pickAt + move + menu.length) % menu.length);
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  return setText(menu[pickAt].send ? `${menu[pickAt].text} ` : menu[pickAt].text);
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  return setClosedFor(text);
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  return choose(menu[pickAt]);
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape" && working) {
                e.preventDefault();
                interrupt();
              }
            }}
          />
          {working && (
            <button className="flex size-7 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:bg-accent hover:text-foreground" title="중단 (Esc)" onClick={interrupt}>
              <StopIcon weight="fill" className="size-3" />
            </button>
          )}
          <button
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            title="보내기 (Enter)"
            disabled={!text.trim() && !images.length}
            onClick={submit}
          >
            <ArrowUpIcon weight="bold" className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/** 입력창 위에 뜨는 `/` 명령 목록. ↑↓ 로 고르고 Enter 로 보내고 Tab 으로 채운다 */
function SlashMenu({ items, at, onHover, onPick }: { items: SlashItem[]; at: number; onHover: (i: number) => void; onPick: (c: SlashItem) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.children[at]?.scrollIntoView({ block: "nearest" });
  }, [at]);
  return (
    <div ref={ref} className="absolute inset-x-0 bottom-full z-[2] mb-1 max-h-64 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg thm-scroll">
      {items.map((c, i) => (
        <button
          key={c.key}
          className={cn("flex w-full items-center gap-3 rounded-md px-2 py-1 text-left", i === at && "bg-accent")}
          // 누를 때 입력창 포커스를 빼앗지 않는다
          onPointerDown={(e) => e.preventDefault()}
          onPointerMove={() => i !== at && onHover(i)}
          onClick={() => onPick(c)}
        >
          {c.wide ? (
            <>
              <span className="min-w-0 flex-1 truncate text-xs">{c.label}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{c.desc}</span>
            </>
          ) : (
            <>
              <span className="max-w-[45%] min-w-28 shrink-0 truncate font-mono text-xs">{c.label}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.desc}</span>
            </>
          )}
          {!c.send && <CaretRightIcon className="size-3 shrink-0 text-muted-foreground" />}
        </button>
      ))}
    </div>
  );
}

/** 남은 시간을 `1일 23시간` · `3시간 5분` · `12분` 으로 */
function untilLabel(resetsAt: number): string {
  const m = Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}일 ${Math.floor((m % 1440) / 60)}시간`;
  if (m >= 60) return `${Math.floor(m / 60)}시간 ${m % 60}분`;
  return `${m}분`;
}

/**
 * 입력창 아래 상태 줄: 모델 · 생각 강도 · 권한 모드(눌러서 바꾼다), 백그라운드 작업, 사용량, 컨텍스트, 계정.
 * 값은 claude 가 상태 줄 명령에 넘겨 주는 것을 데몬이 받아 둔 것이다 (`agent.usage`, thuminal 실행기로 실행한 claude).
 * 그 값이 없는 세션(앞서 실행해 둔 claude)은 대화 기록에서 읽은 것(`status`)으로 대신한다.
 * 모델 · 강도 바꾸기는 `/model 값` · `/effort 값` 을 보내는 것이라 claude 가 새 세션 기본값으로도 저장한다
 */
function StatusLine({
  status,
  agent,
  models,
  efforts,
  busy,
  mode,
  onMode,
  onCommand,
}: {
  status: ChatStatus;
  agent: AgentInfo | null;
  models: SlashChoice[];
  efforts: SlashChoice[];
  busy: boolean;
  mode: ModeId | null;
  onMode: (target: ModeId) => void;
  onCommand: (text: string) => void;
}) {
  const u = agent?.usage ?? null;
  const model = u?.model_name ?? status.model ?? agent?.model ?? null;
  const effort = u?.effort ?? status.effort ?? null;
  const used = u?.context_tokens ?? status.context_tokens ?? null;
  const size = u?.context_size ?? status.context_window ?? null;
  const pct = u?.context_pct ?? (used !== null && size ? Math.min(100, Math.round((used / size) * 100)) : null);
  const tone = (p: number) => (p >= 85 ? "text-agent-failed" : p >= 60 ? "text-agent-attention" : "");
  const trigger = "flex h-5 items-center gap-1 rounded px-1 hover:bg-accent hover:text-foreground disabled:pointer-events-none";
  const caret = <CaretRightIcon className="size-2.5 rotate-90 opacity-60" />;
  const pick = (label: string, now: string | null, choices: SlashChoice[], command: string) => (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={busy}>
        <button className={trigger} title={busy ? `${label} (작업이 끝나면 바꿀 수 있어요)` : `${label} 바꾸기`}>
          {now ?? label}
          {caret}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-80 min-w-44 overflow-y-auto">
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">새 세션 기본값으로도 저장돼요</DropdownMenuLabel>
        {choices.map((c) => (
          <DropdownMenuItem key={c.value} onSelect={() => onCommand(`/${command} ${c.value}`)} className="gap-3 text-xs">
            <span className="font-mono">{c.value}</span>
            {c.desc && <span className="ml-auto text-muted-foreground">{c.desc}</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const limit = (label: string, p: number | null | undefined, resets: number | null | undefined) =>
    p == null ? null : (
      <span className={cn("tabular-nums", tone(p))} title={resets ? `${label} 한도의 ${p}%를 썼어요. ${untilLabel(resets)} 뒤에 다시 차요` : `${label} 한도의 ${p}%를 썼어요`}>
        {label} {p}%{resets ? <span className="opacity-70"> ↻{untilLabel(resets)}</span> : null}
      </span>
    );
  const now = MODES.find((m) => m.id === mode);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 px-0.5 text-[11px] text-muted-foreground">
      {pick("모델", model && modelLabel(model), models, "model")}
      {pick("생각 강도", effort, efforts, "effort")}
      {now && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild disabled={busy}>
            <button className={cn(trigger, mode === "bypassPermissions" && "text-agent-attention")} title={busy ? "권한 모드 (작업이 끝나면 바꿀 수 있어요)" : "권한 모드 바꾸기"}>
              {now.label}
              {caret}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="min-w-64">
            {MODES.map((m) => (
              <DropdownMenuItem key={m.id} onSelect={() => m.id !== mode && onMode(m.id)} className="gap-4 text-xs">
                <span className={cn("font-mono", m.id === mode && "font-medium")}>{m.label}</span>
                <span className="ml-auto text-muted-foreground">{m.desc}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!!agent?.background_tasks && <span className="px-1">백그라운드 {agent.background_tasks}</span>}
      <span className="ml-auto flex flex-wrap items-center justify-end gap-x-2.5">
        {limit("5시간", u?.five_hour_pct, u?.five_hour_resets)}
        {limit("7일", u?.seven_day_pct, u?.seven_day_resets)}
        <span className={cn("tabular-nums", pct !== null && tone(pct))} title="컨텍스트 사용량">
          {used === null ? (
            "컨텍스트 –"
          ) : (
            <>
              컨텍스트 {tokenLabel(used)}
              {size ? ` / ${tokenLabel(size)} (${pct}%)` : ""}
            </>
          )}
        </span>
        {u?.account && <span className="max-w-40 truncate" title={u.account}>{u.account.split("@")[0]}</span>}
      </span>
    </div>
  );
}
