// 폰 화면: 원격 접속(웹·안드로이드 앱)에서 화면이 좁을 때 띄운다.
//
// 데스크톱 화면과 같은 AppModel 을 쓰고 그리기만 폰에 맞춘다. 세 화면을 오간다 (뒤로 가기는 브라우저 기록과 같이 간다):
// - 처음: 일하는 에이전트 목록 + 프로젝트별 워크트리
// - 워크트리: 그 워크트리의 터미널 목록, 새 터미널·에이전트 띄우기
// - 터미널: 터미널 하나 + 키 줄(Esc, Tab, Ctrl, 방향키 …) + 입력 줄(한 줄을 다 쓰고 보낸다. 한글·자동 완성이 편하다)
// 터미널을 누르면 폰 키보드로 바로 친다. 세션 크기는 마지막으로 입력한 화면을 따른다 (폰에서 치면 폰 크기, 데스크톱에서 치면 데스크톱 크기).

import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CaretRightIcon,
  ClipboardTextIcon,
  DotsThreeVerticalIcon,
  KeyboardIcon,
  PaperPlaneRightIcon,
  PlusIcon,
  TerminalWindowIcon,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Renderer, SessionId, SessionInfo, WorkspaceId, WorktreeInfo } from "@thuminal/term-core";

import { AgentIcon } from "./agent-icons";
import { AGENTS } from "./agents";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "./components/ui/dropdown-menu";
import { panesOf } from "./layout";
import { cn } from "./lib/utils";
import type { Services } from "./services";
import { agentStatus, type Status, StatusIndicator, statusOf } from "./Sidebar";
import { AppModel, FLOATING_WORKSPACE, ModelContext, OTHER_WORKSPACE, TEAM_LEADER_LABEL, TEAM_NAME_LABEL, useApp, useModel, worktreeTitle } from "./store";
import { rendererOptions } from "./terminal-font";
import "./styles.css";

/** 안드로이드 앱(apps/android)이 WebView 에 넣어 주는 기능 */
interface AppBridge {
  clipboardText(): string;
  copyText(text: string): void;
  forget(): void;
  changeServer(): void;
}

export function appBridge(): AppBridge | null {
  return (window as unknown as { ThuminalApp?: AppBridge }).ThuminalApp ?? null;
}

/** 원격 연결 상태를 알려 주는 껍데기 (웹 HostApi) */
export interface RemoteConnection {
  state: string;
  onState(cb: (s: string) => void): () => void;
  reconnectNow(): void;
}

type Screen = { kind: "home" } | { kind: "ws"; ws: WorkspaceId } | { kind: "term"; ws: WorkspaceId; session: SessionId };

const RANK: Status[] = ["attention", "error", "working", "done", "ready"];
const FONT_KEY = "thuminal.mobileFontSize";
/** 폰 터미널 글자 크기 기본값 (글꼴 · 굵기는 설정창 값을 쓴다) */
const MOBILE_FONT_SIZE = 12;

export function MobileApp({
  services,
  conn,
  onForget,
  onDesktopUi,
}: {
  services: Services;
  conn: RemoteConnection;
  /** 이 브라우저에 남긴 토큰을 지운다 */
  onForget: () => void;
  /** 데스크톱 화면으로 바꾼다 */
  onDesktopUi: () => void;
}) {
  const model = useMemo(() => new AppModel(services), [services]);
  useEffect(() => {
    void model.start({ gitStatus: false });
    return () => model.stop();
  }, [model]);
  return (
    <ModelContext.Provider value={model}>
      <Phone conn={conn} onForget={onForget} onDesktopUi={onDesktopUi} />
    </ModelContext.Provider>
  );
}

/** 화면 이동. 브라우저 기록에 같이 쌓아 안드로이드 뒤로 가기가 앞 화면으로 간다 */
function useNav(): [Screen, (s: Screen) => void, () => void] {
  const [screen, setScreen] = useState<Screen>(() => (history.state?.thm as Screen | undefined) ?? { kind: "home" });
  useEffect(() => {
    if (!history.state?.thm) history.replaceState({ thm: { kind: "home" } }, "");
    const onPop = (e: PopStateEvent) => setScreen((e.state?.thm as Screen | undefined) ?? { kind: "home" });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const go = (s: Screen) => {
    history.pushState({ thm: s }, "");
    setScreen(s);
  };
  const back = () => history.back();
  return [screen, go, back];
}

function Phone({ conn, onForget, onDesktopUi }: { conn: RemoteConnection; onForget: () => void; onDesktopUi: () => void }) {
  const [screen, go, back] = useNav();
  const [state, setState] = useState(conn.state);
  useEffect(() => conn.onState(setState), [conn]);
  const error = useApp((s) => s.error);
  const model = useModel();
  // 지금 화면의 터미널이 사라지면 처음 화면으로
  const gone = useApp((s) => screen.kind === "term" && !s.sessions[screen.session] && Object.keys(s.sessions).length > 0);
  useEffect(() => {
    if (gone) back();
  }, [gone]); // eslint-disable-line react-hooks/exhaustive-deps

  const menu = (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button className="flex size-9 items-center justify-center rounded-md text-muted-foreground active:bg-accent" aria-label="메뉴">
          <DotsThreeVerticalIcon weight="bold" className="size-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={onDesktopUi}>데스크톱 화면으로</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => location.reload()}>새로 고침</DropdownMenuItem>
        {appBridge() && <DropdownMenuItem onSelect={() => appBridge()?.changeServer()}>다른 데스크톱으로</DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onSelect={() => confirm("이 기기의 접속 정보를 지울까? 다시 쓰려면 데스크톱에서 등록해야 한다") && onForget()}>
          접속 정보 지우기
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground select-none" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      {state !== "open" && (
        <button className="shrink-0 bg-agent-attention/15 px-3 py-1.5 text-left text-[12px] text-foreground" onClick={() => conn.reconnectNow()}>
          {state === "unauthorized"
            ? "이 기기의 토큰이 더는 맞지 않는다. 데스크톱 설정 → 원격 접속에서 다시 등록한다"
            : state === "connecting"
              ? "데스크톱에 붙는 중…"
              : "데스크톱과 연결이 끊겼다. 다시 붙는 중 (누르면 바로)"}
        </button>
      )}
      {error && (
        <button className="shrink-0 bg-destructive/15 px-3 py-1.5 text-left text-[12px]" onClick={() => model.clearError()}>
          {error}
        </button>
      )}
      {screen.kind === "home" && <Home go={go} menu={menu} />}
      {screen.kind === "ws" && <WorkspaceScreen ws={screen.ws} go={go} back={back} menu={menu} />}
      {screen.kind === "term" && <TerminalScreen key={screen.session} ws={screen.ws} session={screen.session} go={go} back={back} />}
    </div>
  );
}

function Header({ title, sub, back, right }: { title: React.ReactNode; sub?: React.ReactNode; back?: () => void; right?: React.ReactNode }) {
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

/** 워크스페이스의 터미널 세션들 (탭 차례, 팀원 빼고) */
function terminalsOf(layout: { tabs: { root: Parameters<typeof panesOf>[0] }[] } | undefined): SessionId[] {
  return (layout?.tabs ?? []).flatMap((t) => panesOf(t.root).flatMap((p) => (p.type === "terminal" ? [p.session] : [])));
}

function wsTitle(ws: WorkspaceId, worktrees: WorktreeInfo[]): string {
  if (ws === FLOATING_WORKSPACE) return "떠 있는 터미널";
  if (ws === OTHER_WORKSPACE) return "기타";
  const w = worktrees.find((x) => x.path === ws);
  return w ? worktreeTitle(w) : ws.split("/").pop() || ws;
}

function sessionLabel(s: SessionInfo | undefined): string {
  if (!s) return "";
  return s.title || s.command?.join(" ") || `세션 ${s.id}`;
}

function Home({ go, menu }: { go: (s: Screen) => void; menu: React.ReactNode }) {
  const repos = useApp((s) => s.repos);
  const worktrees = useApp((s) => s.worktrees);
  const layouts = useApp((s) => s.layouts);
  const sessions = useApp((s) => s.sessions);
  const model = useModel();

  // 에이전트가 든 터미널: 급한 것부터
  const agents = Object.values(sessions)
    .filter((s) => s.agent && !s.labels[TEAM_LEADER_LABEL])
    .map((s) => ({ s, status: agentStatus(s.agent!), ws: model.workspaceOf(s.id) }))
    .filter((x) => x.ws !== null)
    .sort((a, b) => RANK.indexOf(a.status) - RANK.indexOf(b.status) || (b.s.agent?.updated_at ?? 0) - (a.s.agent?.updated_at ?? 0));

  const extra = [FLOATING_WORKSPACE, OTHER_WORKSPACE].filter((ws) => terminalsOf(layouts[ws]).length > 0);

  return (
    <>
      <Header title="thuminal" right={menu} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        {agents.length > 0 && (
          <Section title="에이전트">
            {agents.map(({ s, status, ws }) => (
              <Row key={s.id} onClick={() => go({ kind: "term", ws: ws!, session: s.id })}>
                <StatusIndicator status={status} />
                <AgentIcon kind={s.agent?.kind} className="size-4" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px]">{s.agent?.prompt || sessionLabel(s)}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {wsTitle(ws!, worktrees)} · {s.agent?.last_assistant_message || statusText(status)}
                  </div>
                </div>
              </Row>
            ))}
          </Section>
        )}
        {repos.map((r) => {
          const list = worktrees.filter((w) => w.repo === r.id);
          if (!list.length) return null;
          return (
            <Section key={r.id} title={r.name}>
              {list.map((w) => {
                const ids = terminalsOf(layouts[w.path]);
                const st = statusOf(ids.flatMap((id) => (sessions[id] ? [sessions[id]] : [])));
                return (
                  <Row key={w.path} onClick={() => go({ kind: "ws", ws: w.path })}>
                    <StatusIndicator status={st} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px]">{worktreeTitle(w)}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{w.branch || "(브랜치 없음)"}</div>
                    </div>
                    {ids.length > 0 && <span className="text-[11px] text-muted-foreground">{ids.length}</span>}
                    <CaretRightIcon className="size-4 text-muted-foreground" />
                  </Row>
                );
              })}
            </Section>
          );
        })}
        {extra.length > 0 && (
          <Section title="그 밖">
            {extra.map((ws) => (
              <Row key={ws} onClick={() => go({ kind: "ws", ws })}>
                <TerminalWindowIcon className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1 truncate text-[14px]">{wsTitle(ws, worktrees)}</div>
                <span className="text-[11px] text-muted-foreground">{terminalsOf(layouts[ws]).length}</span>
                <CaretRightIcon className="size-4 text-muted-foreground" />
              </Row>
            ))}
          </Section>
        )}
        {!repos.length && !extra.length && <p className="p-6 text-center text-[13px] text-muted-foreground">데스크톱에 등록한 프로젝트가 없다</p>}
      </div>
    </>
  );
}

function statusText(s: Status): string {
  return { attention: "묻고 있다", error: "오류로 끝났다", working: "일하는 중", interrupted: "멈췄다", done: "끝냈다", ready: "기다리는 중" }[s as string] ?? "";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-3">
      <h2 className="px-4 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Row({ onClick, children, className }: { onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button className={cn("flex min-h-12 w-full items-center gap-2.5 px-4 py-2 text-left active:bg-accent", className)} onClick={onClick}>
      {children}
    </button>
  );
}

function WorkspaceScreen({ ws, go, back, menu }: { ws: WorkspaceId; go: (s: Screen) => void; back: () => void; menu: React.ReactNode }) {
  const model = useModel();
  const worktrees = useApp((s) => s.worktrees);
  const layout = useApp((s) => s.layouts[ws]);
  const sessions = useApp((s) => s.sessions);
  const agents = useApp((s) => s.agents);
  const w = worktrees.find((x) => x.path === ws);
  const ids = terminalsOf(layout);
  const [busy, setBusy] = useState(false);

  /** 새 탭을 띄우고 그 터미널로 간다 */
  const launch = async (input?: string) => {
    setBusy(true);
    try {
      const before = new Set(terminalsOf(model.get().layouts[ws]));
      await model.newTab(ws, input);
      const made = terminalsOf(model.get().layouts[ws]).find((id) => !before.has(id));
      if (made !== undefined) go({ kind: "term", ws, session: made });
    } catch (e) {
      model.fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Header title={wsTitle(ws, worktrees)} sub={w?.branch} back={back} right={menu} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {ids.length === 0 && <p className="p-6 text-center text-[13px] text-muted-foreground">열린 터미널이 없다</p>}
        {ids.map((id) => {
          const s = sessions[id];
          const mates = Object.values(sessions).filter((m) => m.labels[TEAM_LEADER_LABEL] === String(id));
          return (
            <div key={id}>
              <Row onClick={() => go({ kind: "term", ws, session: id })}>
                {s?.agent ? <StatusIndicator status={agentStatus(s.agent)} /> : <TerminalWindowIcon className="size-4 text-muted-foreground" />}
                {s?.agent && <AgentIcon kind={s.agent.kind} />}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px]">{sessionLabel(s)}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {s?.state.state === "exited" ? "끝났다" : s?.agent?.last_assistant_message || s?.agent?.prompt || s?.cwd || ""}
                  </div>
                </div>
                <CaretRightIcon className="size-4 text-muted-foreground" />
              </Row>
              {mates.map((m) => (
                <Row key={m.id} className="pl-10" onClick={() => go({ kind: "term", ws, session: m.id })}>
                  {m.agent ? <StatusIndicator status={agentStatus(m.agent)} /> : <span className="size-3" />}
                  <div className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">팀원 · {m.labels[TEAM_NAME_LABEL] || sessionLabel(m)}</div>
                </Row>
              ))}
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 gap-2 border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <button disabled={busy} className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border text-[14px] active:bg-accent disabled:opacity-50" onClick={() => void launch()}>
          <PlusIcon className="size-4" /> 터미널
        </button>
        {AGENTS.filter((a) => agents.includes(a.cmd)).map((a) => (
          <button
            key={a.cmd}
            disabled={busy}
            className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-lg border text-[14px] active:bg-accent disabled:opacity-50"
            onClick={() => void launch(a.cmd)}
          >
            <AgentIcon kind={a.cmd} /> {a.cmd}
          </button>
        ))}
      </div>
    </>
  );
}

/** 폰 글자 크기로 렌더러 하나를 띄운다 (데스크톱 TerminalSurface 와 같고 글자 크기만 바꿀 수 있다) */
function useRenderer(ref: React.RefObject<HTMLDivElement | null>, fontSize: number): Renderer | null {
  const model = useModel();
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const font = useApp((s) => s.terminalFont);
  useEffect(() => {
    const { services } = model;
    const r = services.renderer(ref.current!, rendererOptions(font, fontSize));
    setRenderer(r);
    let raf = 0;
    const loop = () => {
      r.frame();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      setRenderer(null);
      r.dispose();
    };
  }, [model, ref, font, fontSize]);
  return renderer;
}

function TerminalScreen({ ws, session, go, back }: { ws: WorkspaceId; session: SessionId; go: (s: Screen) => void; back: () => void }) {
  const model = useModel();
  const s = useApp((st) => st.sessions[session]);
  const worktrees = useApp((st) => st.worktrees);
  const layout = useApp((st) => st.layouts[ws]);
  const generation = useApp((st) => st.generation);
  const [fontSize, setFontSize] = useState(() => Number(localStorage.getItem(FONT_KEY)) || MOBILE_FONT_SIZE);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const renderer = useRenderer(surfaceRef, fontSize);
  const [ctrl, setCtrl] = useState(false);
  const [line, setLine] = useState("");
  // 다른 화면이 세션 크기를 가져갔는지 (세션 정보가 바뀔 때마다 다시 본다)
  const [taken, setTaken] = useState(false);
  const c = model.controller(session);

  useLayoutEffect(() => {
    if (!renderer || !hostRef.current) return;
    c.show(hostRef.current, renderer, 0);
    return () => c.hide();
  }, [c, renderer, generation]);

  useEffect(() => {
    const t = window.setTimeout(() => setTaken(c.sizeTaken), 200);
    return () => window.clearTimeout(t);
  }, [c, s?.cols, s?.rows, renderer]);

  const changeFont = (d: number) => {
    const next = Math.min(20, Math.max(8, fontSize + d));
    localStorage.setItem(FONT_KEY, String(next));
    setFontSize(next);
  };

  const siblings = terminalsOf(layout);
  const key = (k: string, mods?: { ctrl?: boolean }) => {
    c.claimSize();
    c.sendKey(k, mods);
  };
  const sendLine = () => {
    c.sendText(line + "\r");
    setLine("");
  };
  const paste = async () => {
    // 안드로이드 앱 WebView 는 navigator.clipboard 를 막는다. 앱이 이어 준다
    const app = appBridge();
    if (app) {
      const text = app.clipboardText();
      if (text) c.paste(text);
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) c.paste(text);
    } catch {
      const text = prompt("붙여 넣을 글");
      if (text) c.paste(text);
    }
  };

  const status = s?.agent ? agentStatus(s.agent) : null;
  return (
    <>
      <Header
        title={
          <span className="flex items-center gap-1.5">
            {status && <StatusIndicator status={status} />}
            <span className="truncate">{sessionLabel(s)}</span>
          </span>
        }
        sub={wsTitle(ws, worktrees)}
        back={back}
        right={
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button className="flex size-9 items-center justify-center rounded-md text-muted-foreground active:bg-accent" aria-label="터미널 메뉴">
                <DotsThreeVerticalIcon weight="bold" className="size-5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem onSelect={(e) => (e.preventDefault(), changeFont(1))}>글자 크게 ({fontSize})</DropdownMenuItem>
              <DropdownMenuItem onSelect={(e) => (e.preventDefault(), changeFont(-1))}>글자 작게</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => c.claimSize()}>폰 크기에 맞추기</DropdownMenuItem>
              {siblings.length > 1 && <DropdownMenuSeparator />}
              {siblings
                .filter((id) => id !== session)
                .map((id) => (
                  <DropdownMenuItem key={id} onSelect={() => go({ kind: "term", ws, session: id })}>
                    {sessionLabel(model.get().sessions[id])}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
      {taken && (
        <button className="shrink-0 bg-accent px-3 py-1 text-left text-[12px] text-muted-foreground" onClick={() => (c.claimSize(), setTaken(false))}>
          데스크톱 크기로 그려지고 있다. 누르면 폰 크기로 맞춘다
        </button>
      )}
      <div ref={surfaceRef} className="relative min-h-0 flex-1" style={{ touchAction: "none" }}>
        <div ref={hostRef} className="absolute inset-x-1 inset-y-0.5" />
      </div>
      <div className="shrink-0 border-t bg-card pb-[env(safe-area-inset-bottom)]">
        {ctrl && (
          <KeyRow>
            {"CDZLRAEUWK".split("").map((ch) => (
              <Key
                key={ch}
                onPress={() => {
                  key(ch.toLowerCase(), { ctrl: true });
                  setCtrl(false);
                }}
              >
                ^{ch}
              </Key>
            ))}
          </KeyRow>
        )}
        <KeyRow>
          <Key onPress={() => key("Escape")}>Esc</Key>
          <Key onPress={() => key("Tab")}>Tab</Key>
          <Key active={ctrl} onPress={() => setCtrl((v) => !v)}>
            Ctrl
          </Key>
          <Key onPress={() => key("ArrowUp")} label="위">
            <ArrowUpIcon className="size-4" />
          </Key>
          <Key onPress={() => key("ArrowDown")} label="아래">
            <ArrowDownIcon className="size-4" />
          </Key>
          <Key onPress={() => key("ArrowLeft")} label="왼쪽">
            <ArrowLeftIcon className="size-4" />
          </Key>
          <Key onPress={() => key("ArrowRight")} label="오른쪽">
            <ArrowRightIcon className="size-4" />
          </Key>
          <Key onPress={() => key("c", { ctrl: true })}>^C</Key>
          <Key onPress={() => void paste()} label="붙여넣기">
            <ClipboardTextIcon className="size-4" />
          </Key>
          <Key onPress={() => (c.claimSize(), c.focus())} label="키보드">
            <KeyboardIcon className="size-4" />
          </Key>
        </KeyRow>
        <form
          className="flex items-center gap-1.5 px-2 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            sendLine();
          }}
        >
          <input
            className="h-10 min-w-0 flex-1 rounded-lg border bg-background px-3 text-[15px] outline-none focus:border-ring"
            placeholder="명령이나 메시지를 쓰고 보낸다"
            value={line}
            enterKeyHint="send"
            onChange={(e) => setLine(e.target.value)}
          />
          <button type="submit" className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground active:opacity-80" aria-label="보내기">
            <PaperPlaneRightIcon weight="fill" className="size-4" />
          </button>
        </form>
      </div>
    </>
  );
}

function KeyRow({ children }: { children: React.ReactNode }) {
  return <div className="flex gap-1 overflow-x-auto px-1.5 py-1.5 [scrollbar-width:none]">{children}</div>;
}

/** 키 줄 단추. 누를 때 터미널 키보드 포커스를 빼앗지 않는다 */
function Key({ children, onPress, active, label }: { children: React.ReactNode; onPress: () => void; active?: boolean; label?: string }) {
  return (
    <button
      aria-label={label}
      className={cn(
        "flex h-9 min-w-10 shrink-0 items-center justify-center rounded-md border px-2 font-mono text-[13px] active:bg-accent",
        active && "border-primary bg-primary/15 text-primary",
      )}
      onPointerDown={(e) => e.preventDefault()}
      onClick={onPress}
    >
      {children}
    </button>
  );
}

/** 토큰 없이 열었을 때: 데스크톱에서 등록하는 법을 알리고 주소·토큰을 붙여 넣게 한다 */
export function PairScreen({ onToken }: { onToken: (token: string) => void }) {
  const [text, setText] = useState("");
  const token = text.match(/token=([0-9a-f]{16,})/)?.[1] ?? (/^[0-9a-f]{16,}$/.test(text.trim()) ? text.trim() : null);
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-foreground">
      <h1 className="text-xl font-semibold">thuminal</h1>
      <p className="max-w-sm text-center text-[14px] leading-6 text-muted-foreground">
        이 기기는 아직 등록하지 않았다. 데스크톱 thuminal의 설정 → 원격 접속에서 [기기 등록]을 누르고, 나온 QR을 찍거나 주소를 붙여 넣는다.
      </p>
      <input
        className="h-11 w-full max-w-sm rounded-lg border bg-card px-3 text-[14px] outline-none focus:border-ring"
        placeholder="http://100.x.y.z:6780/#token=…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button
        disabled={!token}
        className="h-11 w-full max-w-sm rounded-lg bg-primary text-[14px] font-medium text-primary-foreground disabled:opacity-40"
        onClick={() => token && onToken(token)}
      >
        붙기
      </button>
    </div>
  );
}
