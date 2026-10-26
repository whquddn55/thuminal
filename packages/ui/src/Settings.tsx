// 설정 창: 다크/라이트, 다크용·라이트용 터미널 테마, 화면 색을 터미널 테마에서 뽑을지, 터미널 글꼴, 에이전트 띄우는 옵션, 알림, 원격 접속.
// 누르면 바로 적용된다 (따로 저장 단추가 없다).

import { CheckIcon, CopyIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { renderSVG } from "uqr";

import type { AgentSettings, RemoteApi, RemoteStatus } from "@thuminal/term-core";
import { type TerminalTheme, themes } from "@thuminal/themes";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { cn } from "./lib/utils";
import { useApp, useModel } from "./store";
import { DEFAULT_TERMINAL_FONT, FONT_SIZE_MAX, FONT_SIZE_MIN, fontStack } from "./terminal-font";
import { currentTheme } from "./theme";

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-md border p-0.5">
      {options.map(([v, l]) => (
        <button key={v} className={cn("rounded px-3 py-1 text-xs", value === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** 테마로 그린 작은 터미널 (실제 엔진이 아니라 같은 색으로 흉내 낸 글) */
function Preview({ theme }: { theme: TerminalTheme }) {
  const p = theme.palette;
  return (
    <div className="overflow-hidden rounded-lg border font-mono text-xs leading-[1.6]" style={{ background: theme.background, color: theme.foreground }}>
      <div className="px-3 py-2.5">
        <div>
          <span style={{ color: p[2] }}>➜</span> <span style={{ color: p[6] }}>~/thuminal</span> <span style={{ color: p[4] }}>git:(</span>
          <span style={{ color: p[1] }}>main</span>
          <span style={{ color: p[4] }}>)</span> <span style={{ color: p[3] }}>✗</span> claude
        </div>
        <div style={{ color: p[8] }}>⏺ 파일 3개를 고쳤다</div>
        <div>
          <span style={{ color: p[2] }}>+ 더한 줄</span> <span style={{ color: p[1] }}>- 지운 줄</span> <span style={{ color: p[5] }}>const</span>{" "}
          <span style={{ color: p[4] }}>split</span> = <span style={{ color: p[3] }}>"right"</span>
        </div>
        <div>
          <span style={{ background: theme.selectionBackground, color: theme.selectionForeground }}>고른 글자</span>{" "}
          <span style={{ background: theme.cursor, color: theme.cursorText }}>█</span>
        </div>
      </div>
      <div className="grid grid-cols-8">
        {p.map((c, i) => (
          <span key={i} className="h-4" style={{ background: c }} title={`${i} ${c}`} />
        ))}
      </div>
    </div>
  );
}

function ThemeList({ scheme, selected, onPick }: { scheme: "dark" | "light"; selected: string; onPick: (id: string) => void }) {
  const [q, setQ] = useState("");
  const list = themes.filter((t) => t.scheme === scheme && t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex min-h-0 flex-col rounded-lg border">
      <div className="flex items-center gap-2 border-b px-2.5">
        <MagnifyingGlassIcon className="size-3.5 text-muted-foreground" />
        <input className="h-8 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" placeholder="테마 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1 thm-scroll">
        {list.map((t) => (
          <button
            key={t.id}
            className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent", t.id === selected && "bg-accent")}
            onClick={() => onPick(t.id)}
          >
            <span className="flex h-4 w-8 shrink-0 overflow-hidden rounded-sm border" style={{ background: t.background }}>
              {[1, 2, 4, 5].map((i) => (
                <span key={i} className="mt-auto h-1.5 flex-1" style={{ background: t.palette[i] }} />
              ))}
            </span>
            <span className="flex-1 truncate">{t.name}</span>
            {t.id === selected && <CheckIcon className="size-3.5" />}
          </button>
        ))}
      </div>
    </div>
  );
}

const Code = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-muted px-1">{children}</code>;

function Toggle({ checked, onChange, title, children }: { checked: boolean; onChange: (v: boolean) => void; title: string; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-3 rounded-lg border p-3 text-xs">
      <Switch className="mt-0.5" checked={checked} onCheckedChange={onChange} />
      <span className="flex flex-col gap-1">
        <span className="text-sm">{title}</span>
        <span className="text-muted-foreground">{children}</span>
      </span>
    </label>
  );
}

const FONT_SUGGESTIONS = ["SF Mono", "MesloLGLDZ Nerd Font Mono", "Menlo", "JetBrains Mono", "D2Coding", "Fira Code"];
const WEIGHTS: [number, string][] = [
  [300, "300 가늘게"],
  [400, "400 보통"],
  [500, "500 중간"],
  [600, "600"],
  [700, "700 굵게"],
  [800, "800"],
];

/** 터미널 글꼴 (이 앱에 남는다). 데스크톱 · 웹 · 폰 터미널이 같이 바뀐다 (폰은 글자 크기만 폰 화면 값을 쓴다) */
function FontSection() {
  const model = useModel();
  const font = useApp((s) => s.terminalFont);
  const zoom = useApp((s) => s.zoom);
  const [family, setFamily] = useState(font.family);
  useEffect(() => setFamily(font.family), [font.family]);
  const apply = (patch: Parameters<typeof model.setTerminalFont>[0]) => void model.setTerminalFont(patch).catch(model.fail);
  const select = "h-7 rounded border bg-background px-2 text-xs";
  const theme = currentTheme(useApp((s) => s.theme), useApp((s) => s.systemDark));
  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1 text-xs">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
        <label className="flex flex-col gap-1">
          글꼴 이름
          <input
            className="h-7 w-64 rounded border bg-background px-2 font-mono"
            value={family}
            list="thm-font-suggestions"
            onChange={(e) => setFamily(e.target.value)}
            onBlur={() => family.trim() && family !== font.family && apply({ family: family.trim() })}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
          <datalist id="thm-font-suggestions">
            {FONT_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1">
          크기
          <input
            className="h-7 w-16 rounded border bg-background px-2 font-mono"
            type="number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            value={font.size}
            onChange={(e) => Number(e.target.value) && apply({ size: Number(e.target.value) })}
          />
        </label>
        <label className="flex flex-col gap-1">
          굵기
          <select className={select} value={font.weight} onChange={(e) => apply({ weight: Number(e.target.value) })}>
            {WEIGHTS.map(([w, l]) => (
              <option key={w} value={w}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          굵은 글자
          <select className={select} value={font.weightBold} onChange={(e) => apply({ weightBold: Number(e.target.value) })}>
            {WEIGHTS.map(([w, l]) => (
              <option key={w} value={w}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button className="h-7 rounded-md border px-3 hover:bg-accent" onClick={() => apply({ ...DEFAULT_TERMINAL_FONT })}>
          기본값 (Orca 와 같게)
        </button>
      </div>
      <div
        className="overflow-hidden rounded-lg border px-4 py-3 leading-[1.3] whitespace-pre"
        style={{ background: theme.background, color: theme.foreground, fontFamily: fontStack(font.family), fontSize: font.size, fontWeight: font.weight }}
      >
        {"❯ claude --resume 90e31298\n"}
        <span style={{ fontWeight: font.weightBold }}>{"● 굵은 글자: 스크롤이 굼뜨던 원인을 찾았다\n"}</span>
        {"  fn readable(&self, wait_ms: i32) -> bool { 0O 1lI }\n"}
        {"  한글과 English 가 섞인 줄 ─── │ ✔ ↻"}
      </div>
      <div className="flex flex-col gap-1 text-muted-foreground">
        <p>
          SF Mono 는 macOS 에 들어 있는 고정폭 글꼴이다. 다른 글꼴은 이 컴퓨터에 설치된 이름을 그대로 적는다. 프롬프트 아이콘처럼 그 글꼴에 없는 글자는{" "}
          <Code>MesloLGLDZ Nerd Font Mono</Code> 로 채운다.
        </p>
        <p>
          터미널에서 <Code>⌘+</Code> <Code>⌘-</Code> 로 모든 터미널 글자 크기를, 터미널 밖에서는 앱 화면 전체를 키우고 줄인다. <Code>⌘0</Code> 은 원래대로.
          {zoom.terminal !== 0 && ` 지금 터미널은 ${zoom.terminal > 0 ? "+" : ""}${zoom.terminal}px (${font.size + zoom.terminal}px).`}
          {zoom.ui !== 1 && ` 지금 화면 배율은 ${Math.round(zoom.ui * 100)}%.`}
        </p>
      </div>
    </div>
  );
}

/** 에이전트 설정. 데몬이 들고 있어 앱을 꺼도 CLI·셸에서 띄우는 claude 에 그대로 쓰인다 */
function AgentSection() {
  const model = useModel();
  const host = model.services.host;
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  useEffect(() => {
    void host.getAgentSettings().then(setSettings, model.fail);
  }, [host, model]);
  if (!settings) return null;
  const change = (next: AgentSettings) => {
    setSettings(next);
    void host.setAgentSettings(next).then(setSettings, model.fail);
  };
  return (
    <div className="flex flex-col gap-3">
      <Toggle
        checked={settings.claude.skip_permissions}
        onChange={(v) => change({ ...settings, claude: { ...settings.claude, skip_permissions: v } })}
        title="claude 를 권한 확인 없이 띄우기"
      >
        thuminal 안에서 띄우는 claude 에 <Code>--dangerously-skip-permissions</Code> 를 붙인다. 파일 수정·명령 실행을 묻지 않고 바로 한다.
      </Toggle>
      <Toggle checked={settings.claude.teams} onChange={(v) => change({ ...settings, claude: { ...settings.claude, teams: v } })} title="에이전트 팀 쓰기">
        claude 에게 팀을 만들라고 시키면 팀원 claude 를 띄운다 (<Code>CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS</Code>). 리더 칸의 [팀원 N] 단추를 누르면
        팀원 목록이 팝업으로 뜨고, 이름을 누르면 그 팀원 터미널을 본다. 시키지 않으면 아무 일도 하지 않는다.
      </Toggle>
      <p className="text-xs text-muted-foreground">
        바꾸면 다음에 띄우는 claude 부터 적용된다 (이미 열린 셸에서 치는 <Code>claude</Code> 도). 지금 돌고 있는 claude 는 다시 띄워야 한다.
      </p>
    </div>
  );
}

/** 알림 설정 (이 앱에 남는다) */
function NotifySection() {
  const model = useModel();
  const n = useApp((s) => s.notify);
  const sub = !n.enabled && "pointer-events-none opacity-50";
  return (
    <div className="flex flex-col gap-3">
      <Toggle checked={n.enabled} onChange={(v) => model.setNotify({ enabled: v })} title="알림 쓰기">
        에이전트가 일을 마치거나 묻거나, 터미널 벨이 울리면 macOS 알림을 띄운다. 알림을 누르면 그 칸으로 간다. 지금 보고 있는 칸이면 띄우지 않는다. Dock 에는 안 읽은
        워크트리 수가 뜬다.
      </Toggle>
      <div className={cn("flex flex-col gap-3", sub)}>
        <Toggle checked={n.done} onChange={(v) => model.setNotify({ done: v })} title="에이전트가 일을 마쳤을 때">
          claude 턴이 끝나면 마지막 답과 함께 알린다.
        </Toggle>
        <Toggle checked={n.attention} onChange={(v) => model.setNotify({ attention: v })} title="에이전트가 묻거나 오류로 끝났을 때">
          권한 확인처럼 사용자를 부를 때, 턴이 오류로 끝났을 때 알린다.
        </Toggle>
        <Toggle checked={n.bell} onChange={(v) => model.setNotify({ bell: v })} title="터미널 벨과 터미널 알림">
          터미널 프로그램이 벨을 울리거나 알림(OSC 9 · 777)을 보내면 알린다.
        </Toggle>
        <Toggle checked={n.sound} onChange={(v) => model.setNotify({ sound: v })} title="알림 소리">
          알림과 함께 기본 소리를 낸다.
        </Toggle>
      </div>
    </div>
  );
}

function ago(ms: number): string {
  if (!ms) return "붙은 적 없음";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  if (s < 86400) return `${Math.round(s / 3600)}시간 전`;
  return `${Math.round(s / 86400)}일 전`;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      title="복사"
      onClick={() => void navigator.clipboard.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}
    >
      {done ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

/** 원격 접속: 폰·다른 컴퓨터 브라우저가 Tailscale 로 이 컴퓨터 데몬에 붙는다. 설정은 데몬이 들고 있어 앱을 꺼도 받는다 */
function RemoteSection({ remote }: { remote: RemoteApi }) {
  const model = useModel();
  const [st, setSt] = useState<RemoteStatus | null>(null);
  const [name, setName] = useState("내 폰");
  const [paired, setPaired] = useState<{ name: string; urls: string[] } | null>(null);
  const [port, setPort] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () => void remote.status().then((r) => alive && setSt(r), model.fail);
    load();
    // 붙어 있는 기기 수가 바뀌는 것을 보인다
    const t = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [remote, model]);
  useEffect(() => {
    if (st) setPort((p) => p || String(st.port));
  }, [st]);
  if (!st) return null;
  const change = (c: { enabled?: boolean; port?: number; lan?: boolean }) => void remote.set(c).then(setSt, model.fail);
  const pair = async () => {
    try {
      const r = await remote.pair(name);
      setPaired({ name: r.device.name, urls: r.urls });
      setSt(await remote.status());
    } catch (e) {
      model.fail(e);
    }
  };
  const host = st.tailnet.find((a) => !a.includes(":")) ?? st.tailnet[0];
  const apkUrl = host && st.apk && st.enabled ? `http://${host.includes(":") ? `[${host}]` : host}:${st.port}/download/thuminal.apk` : null;
  const qr = (text: string) => <div className="size-40 shrink-0 rounded bg-white p-1.5 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: renderSVG(text, { pixelSize: 4 }) }} />;

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
      <Toggle checked={st.enabled} onChange={(v) => change({ enabled: v })} title="원격 접속 켜기">
        같은 Tailscale 망의 폰이나 다른 컴퓨터 브라우저에서 이 컴퓨터의 터미널과 에이전트를 보고 친다. 앱을 꺼도 데몬이 계속 받는다. 등록한 기기만 붙을 수 있다.
      </Toggle>
      <div className="flex flex-col gap-1 rounded-md border px-3 py-2 text-xs">
        {st.listening.length ? (
          st.listening.map((a) => (
            <div key={a} className="font-mono text-muted-foreground">
              받는 중 {a}
            </div>
          ))
        ) : (
          <div className="text-muted-foreground">받고 있지 않다</div>
        )}
        {!st.tailnet.length && <div className="text-agent-attention">Tailscale 주소를 찾지 못했다. Tailscale 을 켜면 15초 안에 그 주소에서도 받는다.</div>}
        {st.error && <div className="whitespace-pre-wrap text-destructive">{st.error}</div>}
        {!st.web && <div className="text-agent-attention">웹 화면 파일이 없어 브라우저로 열면 빈 화면이다 (개발 중이면 pnpm -C apps/web build).</div>}
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
        <label className="flex items-center gap-2">
          포트
          <input
            className="h-7 w-20 rounded border bg-background px-2 font-mono"
            value={port}
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
            onBlur={() => Number(port) && Number(port) !== st.port && change({ port: Number(port) })}
          />
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={st.lan} onCheckedChange={(v) => change({ lan: v })} />
          같은 Wi‑Fi 에서도 받기 (내용이 암호화되지 않는다)
        </label>
      </div>

      <div className="flex flex-col gap-2 rounded-md border p-3">
        <div className="text-sm font-medium">기기 등록</div>
        <p className="text-xs text-muted-foreground">
          기기마다 토큰이 든 주소를 만든다. 폰 카메라로 QR 을 찍으면 브라우저로 열리고, thuminal 안드로이드 앱에서는 [QR 찍기] 로 찍는다.
        </p>
        <div className="flex items-center gap-2">
          <input className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="기기 이름" />
          <button className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90" onClick={() => void pair()}>
            기기 등록
          </button>
        </div>
        {paired && (
          <div className="flex gap-3 pt-1">
            {paired.urls[0] ? qr(paired.urls[0]) : null}
            <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
              <div>
                <b>{paired.name}</b> 를 등록했다. 이 주소는 지금만 보인다.
              </div>
              {paired.urls.length ? (
                paired.urls.map((u) => (
                  <div key={u} className="flex items-center gap-1">
                    <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] select-all">{u}</code>
                    <CopyButton text={u} />
                  </div>
                ))
              ) : (
                <div className="text-agent-attention">폰이 닿을 주소가 없다. Tailscale 을 켜거나 같은 Wi‑Fi 받기를 켠다.</div>
              )}
            </div>
          </div>
        )}
        {apkUrl && (
          <div className="flex items-center gap-3 border-t pt-2">
            {qr(apkUrl)}
            <div className="flex min-w-0 flex-col gap-1 text-xs">
              <div>안드로이드 앱 내려받기 (폰이 Tailscale 에 붙어 있어야 한다)</div>
              <div className="flex items-center gap-1">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] select-all">{apkUrl}</code>
                <CopyButton text={apkUrl} />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium">등록한 기기</div>
        {st.devices.length === 0 && <div className="text-xs text-muted-foreground">없다</div>}
        {st.devices.map((d) => (
          <div key={d.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs">
            <span className={cn("size-2 rounded-full", d.connected ? "bg-agent-done" : "bg-muted-foreground/40")} />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="text-muted-foreground">{d.connected ? `연결 ${d.connected}` : ago(d.last_seen)}</span>
            <button
              className="rounded px-2 py-0.5 text-destructive hover:bg-destructive/10"
              onClick={() => confirm(`${d.name} 를 지울까? 붙어 있으면 바로 끊긴다`) && void remote.removeDevice(d.id).then(setSt, model.fail)}
            >
              지우기
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SettingsDialog() {
  const model = useModel();
  const open = useApp((s) => s.dialog?.kind === "settings");
  const theme = useApp((s) => s.theme);
  const systemDark = useApp((s) => s.systemDark);
  const now = currentTheme(theme, systemDark);
  const [editing, setEditing] = useState<"dark" | "light">(now.scheme);
  const [section, setSection] = useState<"theme" | "font" | "agent" | "notify" | "remote">("theme");
  const remote = model.services.host.remote;
  const picked = themes.find((t) => t.id === theme[editing]) ?? now;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && model.setDialog(null)}>
      <DialogContent className="flex h-[min(640px,85vh)] flex-col gap-4 select-text sm:max-w-[780px]">
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>
            {section === "theme"
              ? "테마를 누르면 바로 바뀐다. 터미널 안에서 도는 프로그램도 새 색으로 답을 받는다."
              : section === "font"
                ? "터미널 글꼴이다. 바꾸면 바로 모든 터미널에 적용되고 이 앱에 남는다."
                : section === "agent"
                ? "에이전트를 띄울 때 붙일 옵션이다. 누르면 바로 저장된다."
                : section === "remote"
                  ? "폰·다른 컴퓨터에서 Tailscale 로 붙는다. 설정은 데몬에 남는다."
                  : "언제 알릴지 고른다. 누르면 바로 저장된다."}
          </DialogDescription>
        </DialogHeader>
        <div className="self-start">
          <Segmented
            value={section}
            options={[
              ["theme", "테마"],
              ["font", "글꼴"],
              ["agent", "에이전트"],
              ["notify", "알림"],
              ...(remote ? ([["remote", "원격 접속"]] as ["remote", string][]) : []),
            ]}
            onChange={setSection}
          />
        </div>
        {section === "remote" && remote ? (
          <RemoteSection remote={remote} />
        ) : section === "font" ? (
          <FontSection />
        ) : section === "agent" ? (
          <AgentSection />
        ) : section === "notify" ? (
          <NotifySection />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">모양</Label>
                <Segmented
                  value={theme.mode}
                  options={[
                    ["system", "시스템 따라"],
                    ["dark", "다크"],
                    ["light", "라이트"],
                  ]}
                  onChange={(mode) => model.setTheme({ mode })}
                />
              </div>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={theme.matchTerminal} onCheckedChange={(v) => model.setTheme({ matchTerminal: v })} />
                화면 색도 터미널 테마에 맞추기
              </label>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-[1fr_1.1fr] gap-4">
              <div className="flex min-h-0 flex-col gap-2">
                <Segmented
                  value={editing}
                  options={[
                    ["dark", "다크 테마"],
                    ["light", "라이트 테마"],
                  ]}
                  onChange={setEditing}
                />
                <ThemeList scheme={editing} selected={theme[editing]} onPick={(id) => model.setTheme({ [editing]: id })} />
              </div>
              <div className="flex flex-col gap-2">
                <div className="text-xs text-muted-foreground">
                  미리보기: <span className="text-foreground">{picked.name}</span>
                  {picked.id !== now.id && <span> (지금은 {now.scheme === "dark" ? "다크" : "라이트"} 모양이라 {now.name} 를 쓴다)</span>}
                </div>
                <Preview theme={picked} />
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
