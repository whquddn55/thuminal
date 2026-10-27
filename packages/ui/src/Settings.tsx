// 설정 창: 다크/라이트, 다크용·라이트용 터미널 테마, 화면 색을 터미널 테마에서 뽑을지, 터미널 글꼴, 에이전트 띄우는 옵션, 알림, 원격 접속,
// 원격 컴퓨터(다른 컴퓨터 데몬 등록).
// 누르면 바로 적용된다 (따로 저장 단추가 없다).

import { CheckIcon, CopyIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { renderSVG } from "uqr";

import { FILES_PROTOCOL_MINOR } from "@thuminal/term-core";
import type { AgentSettings, AgentSettingsState, RemoteApi, RemoteHost, RemoteHostsApi, RemoteStatus } from "@thuminal/term-core";
import { type TerminalTheme, themes } from "@thuminal/themes";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { cn } from "./lib/utils";
import { type SettingsSection, useApp, useModel } from "./store";
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
        <div style={{ color: p[8] }}>⏺ 파일 3개를 고쳤어요</div>
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
          기본값 (Orca와 같게)
        </button>
      </div>
      <div
        className="overflow-hidden rounded-lg border px-4 py-3 leading-[1.3] whitespace-pre"
        style={{ background: theme.background, color: theme.foreground, fontFamily: fontStack(font.family), fontSize: font.size, fontWeight: font.weight }}
      >
        {"❯ claude --resume 90e31298\n"}
        <span style={{ fontWeight: font.weightBold }}>{"● 굵은 글자: 스크롤이 굼뜨던 원인을 찾았어요\n"}</span>
        {"  fn readable(&self, wait_ms: i32) -> bool { 0O 1lI }\n"}
        {"  한글과 English가 섞인 줄 ─── │ ✔ ↻"}
      </div>
      <div className="flex flex-col gap-1 text-muted-foreground">
        <p>
          SF Mono는 macOS에 들어 있는 고정폭 글꼴이에요. 다른 글꼴은 이 컴퓨터에 설치된 이름을 그대로 적어 주세요. 프롬프트 아이콘처럼 그 글꼴에 없는 글자는{" "}
          <Code>MesloLGLDZ Nerd Font Mono</Code>로 채워요.
        </p>
        <p>
          터미널에서 <Code>⌘+</Code> <Code>⌘-</Code>로 모든 터미널 글자 크기를, 터미널 밖에서는 앱 화면 전체를 키우고 줄여요. <Code>⌘0</Code>을 누르면 원래대로 돌아와요.
          {zoom.terminal !== 0 && ` 지금 터미널: ${zoom.terminal > 0 ? "+" : ""}${zoom.terminal}px (${font.size + zoom.terminal}px).`}
          {zoom.ui !== 1 && ` 지금 화면 배율: ${Math.round(zoom.ui * 100)}%.`}
        </p>
      </div>
    </div>
  );
}

/** 에이전트 설정. 데몬이 들고 있어 앱을 꺼도 CLI·셸에서 띄우는 claude 에 그대로 쓰인다 */
function AgentSection() {
  const model = useModel();
  const host = model.services.host;
  const [state, setState] = useState<AgentSettingsState | null>(null);
  const [oldDaemon, setOldDaemon] = useState(false);
  useEffect(() => {
    void host.getAgentSettings().then(setState, model.fail);
    void host.daemon().then((d) => setOldDaemon((d.protocol?.[1] ?? 0) < FILES_PROTOCOL_MINOR), () => undefined);
  }, [host, model]);
  if (!state) return null;
  const { settings, skills } = state;
  const change = (next: AgentSettings) => {
    setState({ settings: next, skills });
    void host.setAgentSettings(next).then(setState, model.fail);
  };
  const disabled = settings.claude.disabled_skills ?? [];
  const setSkill = (name: string, on: boolean) =>
    change({ ...settings, claude: { ...settings.claude, disabled_skills: on ? disabled.filter((n) => n !== name) : [...disabled, name] } });
  return (
    <div className="flex flex-col gap-3">
      <Toggle
        checked={settings.claude.skip_permissions}
        onChange={(v) => change({ ...settings, claude: { ...settings.claude, skip_permissions: v } })}
        title="claude를 권한 확인 없이 실행"
      >
        thuminal 안에서 실행하는 claude에 <Code>--dangerously-skip-permissions</Code>를 붙여요. 파일 수정이나 명령 실행을 묻지 않고 바로 해요.
      </Toggle>
      <Toggle checked={settings.claude.teams} onChange={(v) => change({ ...settings, claude: { ...settings.claude, teams: v } })} title="에이전트 팀 쓰기">
        claude에게 팀을 만들라고 시키면 팀원 claude를 실행해요 (<Code>CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS</Code>). 리더 칸의 [팀원 N] 단추를 누르면
        팀원 목록이 팝업으로 열리고, 이름을 누르면 그 팀원 터미널을 볼 수 있어요. 시키지 않으면 아무 일도 하지 않아요.
      </Toggle>
      <div className="flex flex-col gap-2">
        <div className="font-medium">thuminal 스킬</div>
        <p className="text-xs text-muted-foreground">
          thuminal 안에서 실행하는 claude에만 얹는 스킬이에요 (<Code>thuminal:이름</Code>). 끈 스킬은 claude에게 보이지 않아요.
        </p>
        {skills.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {oldDaemon ? "지금 데몬이 이전 버전이라 스킬을 켜고 끌 수 없어요. 데몬을 다시 시작하면 여기서 고를 수 있어요. 그때까지는 모두 켜져 있어요." : "플러그인에 스킬이 없어요."}
          </p>
        ) : (
          skills.map((k) => (
            <Toggle key={k.name} checked={!disabled.includes(k.name)} onChange={(v) => setSkill(k.name, v)} title={k.name}>
              <span className="line-clamp-2" title={k.description}>
                {k.description}
              </span>
            </Toggle>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        바꾸면 다음에 실행하는 claude부터 적용돼요. 이미 열린 셸에서 치는 <Code>claude</Code>도 마찬가지예요. 지금 돌고 있는 claude는 다시 실행해야 해요.
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
        에이전트가 일을 마치거나 묻거나, 터미널 벨이 울리면 macOS 알림을 보내요. 알림을 누르면 그 칸으로 가요. 지금 보고 있는 칸이면 보내지 않아요. Dock에는 안 읽은
        워크트리 수가 표시돼요.
      </Toggle>
      <div className={cn("flex flex-col gap-3", sub)}>
        <Toggle checked={n.done} onChange={(v) => model.setNotify({ done: v })} title="에이전트가 일을 마쳤을 때">
          claude 턴이 끝나면 마지막 답과 함께 알려요.
        </Toggle>
        <Toggle checked={n.attention} onChange={(v) => model.setNotify({ attention: v })} title="에이전트가 묻거나 오류로 끝났을 때">
          권한 확인처럼 사용자를 부를 때, 턴이 오류로 끝났을 때 알려요.
        </Toggle>
        <Toggle checked={n.bell} onChange={(v) => model.setNotify({ bell: v })} title="터미널 벨과 터미널 알림">
          터미널 프로그램이 벨을 울리거나 알림(OSC 9/777)을 보내면 알려요.
        </Toggle>
        <Toggle checked={n.sound} onChange={(v) => model.setNotify({ sound: v })} title="알림 소리">
          알림과 함께 기본 소리를 내요.
        </Toggle>
      </div>
    </div>
  );
}

function ago(ms: number): string {
  if (!ms) return "연결한 적 없음";
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
        같은 Tailscale 망의 폰이나 다른 컴퓨터 브라우저에서 이 컴퓨터의 터미널과 에이전트를 보고 칠 수 있어요. 앱을 꺼도 데몬이 계속 수신 대기해요. 등록한 기기만 연결할 수 있어요.
      </Toggle>
      <div className="flex flex-col gap-1 rounded-md border px-3 py-2 text-xs">
        {st.listening.length ? (
          st.listening.map((a) => (
            <div key={a} className="font-mono text-muted-foreground">
              수신 대기 {a}
            </div>
          ))
        ) : (
          <div className="text-muted-foreground">수신 대기 안 함</div>
        )}
        {!st.tailnet.length && <div className="text-agent-attention">Tailscale 주소를 찾지 못했어요. Tailscale을 켜면 15초 안에 그 주소에서도 수신 대기해요.</div>}
        {st.error && <div className="whitespace-pre-wrap text-destructive">{st.error}</div>}
        {!st.web && <div className="text-agent-attention">웹 화면 파일이 없어 브라우저로 열면 빈 화면이 나와요. 개발 중이면 pnpm -C apps/web build를 실행해 주세요.</div>}
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
          같은 Wi‑Fi에서도 수신 대기 (암호화되지 않음)
        </label>
      </div>

      <div className="flex flex-col gap-2 rounded-md border p-3">
        <div className="text-sm font-medium">기기 등록</div>
        <p className="text-xs text-muted-foreground">
          기기마다 토큰이 든 주소를 만들어요. 폰 카메라로 QR을 찍으면 브라우저로 열리고, thuminal 안드로이드 앱에서는 [QR 찍기]로 찍어요.
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
                <b>{paired.name}</b> 기기를 등록했어요. 이 주소는 지금만 보여요.
              </div>
              {paired.urls.length ? (
                paired.urls.map((u) => (
                  <div key={u} className="flex items-center gap-1">
                    <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] select-all">{u}</code>
                    <CopyButton text={u} />
                  </div>
                ))
              ) : (
                <div className="text-agent-attention">폰이 닿을 주소가 없어요. Tailscale을 켜거나 같은 Wi‑Fi 수신 대기를 켜 주세요.</div>
              )}
            </div>
          </div>
        )}
        {apkUrl && (
          <div className="flex items-center gap-3 border-t pt-2">
            {qr(apkUrl)}
            <div className="flex min-w-0 flex-col gap-1 text-xs">
              <div>안드로이드 앱 내려받기. 폰이 Tailscale에 연결돼 있어야 해요.</div>
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
        {st.devices.length === 0 && <div className="text-xs text-muted-foreground">없어요</div>}
        {st.devices.map((d) => (
          <div key={d.id} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs">
            <span className={cn("size-2 rounded-full", d.connected ? "bg-agent-done" : "bg-muted-foreground/40")} />
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
            <span className="text-muted-foreground">{d.connected ? `연결 ${d.connected}` : ago(d.last_seen)}</span>
            <button
              className="rounded px-2 py-0.5 text-destructive hover:bg-destructive/10"
              onClick={() => confirm(`${d.name} 기기를 지울까요? 연결돼 있으면 바로 끊겨요.`) && void remote.removeDevice(d.id).then(setSt, model.fail)}
            >
              지우기
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const HOST_STATE: Record<RemoteHost["state"], string> = {
  connecting: "연결 중",
  connected: "연결됨",
  disconnected: "끊김",
  unauthorized: "토큰이 맞지 않음",
  version_mismatch: "버전이 다름",
};

/** 원격 컴퓨터: 다른 컴퓨터의 thuminal 데몬을 등록한다. 목록은 이 앱(hosts.json)에 남고, 끊기면 스스로 다시 붙는다 */
function HostsSection({ hosts }: { hosts: RemoteHostsApi }) {
  const model = useModel();
  const [list, setList] = useState<RemoteHost[]>([]);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => hosts.onChange(setList), [hosts]);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await hosts.add(url, name.trim() || undefined);
      setUrl("");
      setName("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
      <div className="flex flex-col gap-2 rounded-md border p-3">
        <div className="text-sm font-medium">원격 컴퓨터 등록</div>
        <p className="text-xs text-muted-foreground">
          원격 컴퓨터의 thuminal 설정 → 원격 접속에서 [기기 등록]을 누르거나 <code className="rounded bg-muted px-1 font-mono">thuminal remote pair 이름</code>{" "}
          으로 주소를 만들어 여기에 붙여 넣어 주세요. 연결은 Tailscale이 암호화하므로 Tailscale 주소(100.x.y.z)만 등록할 수 있어요.
        </p>
        <input
          className="h-8 min-w-0 rounded border bg-background px-2 font-mono text-xs"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && url.trim() && !busy && void add()}
          placeholder="http://100.x.y.z:6780/#token=…"
        />
        <div className="flex items-center gap-2">
          <input
            className="h-8 min-w-0 flex-1 rounded border bg-background px-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && url.trim() && !busy && void add()}
            placeholder="이름 (예: 작업 맥). 비우면 주소"
          />
          <button
            className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            disabled={!url.trim() || busy}
            onClick={() => void add()}
          >
            {busy ? "연결해 보는 중…" : "등록"}
          </button>
        </div>
        {error && <div className="text-xs whitespace-pre-wrap text-destructive">{error}</div>}
      </div>

      <div className="flex flex-col gap-1">
        <div className="text-sm font-medium">등록한 원격 컴퓨터</div>
        {list.length === 0 && <div className="text-xs text-muted-foreground">없어요</div>}
        {list.map((h) => (
          <div key={h.id} className="flex flex-col gap-0.5 rounded-md border px-3 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  h.state === "connected"
                    ? "bg-agent-done"
                    : h.state === "connecting"
                      ? "bg-agent-working"
                      : h.state === "disconnected"
                        ? "bg-muted-foreground/40"
                        : "bg-destructive",
                )}
              />
              <span className="min-w-0 truncate font-medium">{h.name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{h.address}</span>
              <span className={cn(h.state === "unauthorized" || h.state === "version_mismatch" ? "text-destructive" : "text-muted-foreground")}>
                {HOST_STATE[h.state]}
                {h.state === "disconnected" && h.retryInMs ? ` · ${Math.ceil(h.retryInMs / 1000)}초 뒤 다시 연결` : ""}
              </span>
              {h.daemonVersion && (
                <span className="text-muted-foreground" title="데몬 버전 · 프로토콜 버전">
                  {h.daemonVersion}
                  {h.protocol ? ` (${h.protocol[0]}.${h.protocol[1]})` : ""}
                </span>
              )}
              {h.state !== "connected" && (
                <button className="rounded px-2 py-0.5 hover:bg-accent" onClick={() => void hosts.reconnect(h.id).catch(model.fail)}>
                  다시 연결
                </button>
              )}
              <button
                className="rounded px-2 py-0.5 text-destructive hover:bg-destructive/10"
                onClick={() =>
                  confirm(`${h.name} 컴퓨터를 지울까요? 그 컴퓨터에 남은 이 기기 등록은 그 컴퓨터의 설정 → 원격 접속에서 지워 주세요.`) &&
                  void hosts.remove(h.id).catch(model.fail)
                }
              >
                지우기
              </button>
            </div>
            {h.warning && <div className="text-agent-attention">{h.warning}</div>}
            {h.state !== "connected" && h.error && <div className="whitespace-pre-wrap text-muted-foreground">{h.error}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 설정 창의 칸. "원격 컴퓨터" 는 데스크톱 껍데기에만 있다 */
type Section = SettingsSection;

export function SettingsDialog() {
  const model = useModel();
  const open = useApp((s) => s.dialog?.kind === "settings");
  const want = useApp((s) => (s.dialog?.kind === "settings" ? s.dialog.section : undefined));
  const theme = useApp((s) => s.theme);
  const systemDark = useApp((s) => s.systemDark);
  const now = currentTheme(theme, systemDark);
  const [editing, setEditing] = useState<"dark" | "light">(now.scheme);
  const [section, setSection] = useState<Section>("theme");
  // 칸을 정해 열면 (새 탭 메뉴의 "에이전트 설정…") 그 칸으로 간다
  useEffect(() => {
    if (open && want) setSection(want);
  }, [open, want]);
  const remote = model.services.host.remote;
  const hosts = model.services.host.hosts;
  const picked = themes.find((t) => t.id === theme[editing]) ?? now;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && model.setDialog(null)}>
      <DialogContent className="flex h-[min(640px,85vh)] flex-col gap-4 select-text sm:max-w-[780px]">
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>
            {section === "theme"
              ? "테마를 누르면 바로 바뀌어요. 터미널 안에서 도는 프로그램도 새 색으로 답을 받아요."
              : section === "font"
                ? "터미널 글꼴이에요. 바꾸면 바로 모든 터미널에 적용되고 이 앱에 남아요."
                : section === "agent"
                ? "에이전트를 실행할 때 붙일 옵션이에요. 누르면 바로 저장돼요."
                : section === "remote"
                  ? "폰이나 다른 컴퓨터에서 Tailscale로 연결해요. 설정은 데몬에 남아요."
                  : section === "hosts"
                  ? "다른 컴퓨터의 thuminal에 Tailscale로 연결해요. 목록은 이 앱에 남고, 끊기면 알아서 다시 연결해요."
                  : "언제 알릴지 골라요. 누르면 바로 저장돼요."}
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
              ...(hosts ? ([["hosts", "원격 컴퓨터"]] as ["hosts", string][]) : []),
            ]}
            onChange={setSection}
          />
        </div>
        {section === "remote" && remote ? (
          <RemoteSection remote={remote} />
        ) : section === "hosts" && hosts ? (
          <HostsSection hosts={hosts} />
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
                  {picked.id !== now.id && <span> (지금은 {now.scheme === "dark" ? "다크" : "라이트"} 모양이라 {now.name} 테마를 써요)</span>}
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
