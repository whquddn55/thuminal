// 설정 창: 왼쪽 칸 목록, 오른쪽 그 칸 내용. 칸은 테마, 글꼴, 단축키, 에이전트, 알림, 원격 접속(이 컴퓨터), 원격 컴퓨터(다른 컴퓨터 데몬 등록),
// 정보(버전 · 업데이트 확인). 내용은 "이름 · 설명 | 조작" 줄(Row)을 묶음(Group)으로 늘어놓는다.
// 누르면 바로 적용된다 (따로 저장 단추가 없다).

import {
  BellIcon,
  BroadcastIcon,
  CheckIcon,
  CopyIcon,
  DesktopIcon,
  InfoIcon,
  KeyboardIcon,
  MagnifyingGlassIcon,
  PaletteIcon,
  RobotIcon,
  TextAaIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { renderSVG } from "uqr";

import { DEFAULT_GROUP, FILES_PROTOCOL_MINOR } from "@thuminal/term-core";
import type { AgentSettings, AgentSettingsState, AppUpdate, RemoteApi, RemoteHost, RemoteHostsApi, RemoteStatus, UpdatesApi } from "@thuminal/term-core";
import { type TerminalTheme, themes } from "@thuminal/themes";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/ui/dialog";
import { Switch } from "./components/ui/switch";
import { normalizeGroups } from "./groups";
import { cn } from "./lib/utils";
import { IS_MAC, keyLabel } from "./platform";
import {
  clearShortcut,
  comboOf,
  isCustomized,
  keysOf,
  ownerOf,
  resetAllShortcuts,
  resetShortcut,
  SHORTCUT_ACTIONS,
  type ShortcutGroup,
  setRecordingShortcut,
  setShortcut,
  shortcutLabel,
  useShortcutOverrides,
} from "./shortcuts";
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
    <div className="flex h-80 flex-col rounded-md border">
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

const Code = ({ children }: { children: React.ReactNode }) => <code className="rounded bg-muted px-1 font-mono text-[0.92em]">{children}</code>;

/** 설정 묶음: 작은 제목 밑에 줄(Row)들을 가는 선으로 나눠 늘어놓는다. note 는 묶음 밑에 붙는 설명 */
function Group({ title, note, children }: { title?: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      {title && <h3 className="pb-1.5 text-xs font-medium text-muted-foreground">{title}</h3>}
      <div className="flex flex-col divide-y border-y">{children}</div>
      {note && <div className="pt-2 text-xs leading-relaxed text-muted-foreground">{note}</div>}
    </section>
  );
}

/** 설정 한 줄: 왼쪽 이름 · 설명, 오른쪽 조작 */
function Row({ title, desc, children, className }: { title: React.ReactNode; desc?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-11 items-center gap-6 py-2", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="text-sm">{title}</div>
        {desc && <div className="text-xs leading-relaxed text-muted-foreground">{desc}</div>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, title, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: React.ReactNode; children?: React.ReactNode; disabled?: boolean }) {
  return (
    <label className={cn("block cursor-pointer", disabled && "pointer-events-none opacity-50")}>
      <Row title={title} desc={children}>
        <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
      </Row>
    </label>
  );
}

const input = "h-7 rounded border bg-background px-2 text-xs outline-none focus:border-ring";
const button = "h-7 rounded-md border px-2.5 text-xs hover:bg-accent disabled:opacity-50";

function ThemeSection() {
  const model = useModel();
  const theme = useApp((s) => s.theme);
  const systemDark = useApp((s) => s.systemDark);
  const now = currentTheme(theme, systemDark);
  const [editing, setEditing] = useState<"dark" | "light">(now.scheme);
  const picked = themes.find((t) => t.id === theme[editing]) ?? now;
  return (
    <>
      <Group>
        <Row title="모양">
          <Segmented
            value={theme.mode}
            options={[
              ["system", "시스템 따라"],
              ["dark", "다크"],
              ["light", "라이트"],
            ]}
            onChange={(mode) => model.setTheme({ mode })}
          />
        </Row>
        <Toggle checked={theme.matchTerminal} onChange={(v) => model.setTheme({ matchTerminal: v })} title="화면 색도 터미널 테마에 맞추기">
          사이드바와 탭 줄 색을 터미널 테마에서 가져와요.
        </Toggle>
      </Group>
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h3 className="flex-1 text-xs font-medium text-muted-foreground">터미널 테마</h3>
          <Segmented
            value={editing}
            options={[
              ["dark", "다크일 때"],
              ["light", "라이트일 때"],
            ]}
            onChange={setEditing}
          />
        </div>
        <div className="grid grid-cols-[1fr_1.15fr] gap-4">
          <ThemeList scheme={editing} selected={theme[editing]} onPick={(id) => model.setTheme({ [editing]: id })} />
          <div className="flex flex-col gap-2">
            <Preview theme={picked} />
            <div className="text-xs text-muted-foreground">
              <span className="text-foreground">{picked.name}</span>
              {picked.id !== now.id && ` · 지금은 ${now.scheme === "dark" ? "다크" : "라이트"} 모양이라 ${now.name}을 써요`}
            </div>
          </div>
        </div>
      </section>
    </>
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
  const theme = currentTheme(useApp((s) => s.theme), useApp((s) => s.systemDark));
  const isDefault =
    font.family === DEFAULT_TERMINAL_FONT.family && font.size === DEFAULT_TERMINAL_FONT.size && font.weight === DEFAULT_TERMINAL_FONT.weight && font.weightBold === DEFAULT_TERMINAL_FONT.weightBold;
  const weightSelect = (value: number, set: (w: number) => void) => (
    <select className={input} value={value} onChange={(e) => set(Number(e.target.value))}>
      {WEIGHTS.map(([w, l]) => (
        <option key={w} value={w}>
          {l}
        </option>
      ))}
    </select>
  );
  return (
    <>
      <div
        className="overflow-hidden rounded-md border px-4 py-3 leading-[1.3] whitespace-pre"
        style={{ background: theme.background, color: theme.foreground, fontFamily: fontStack(font.family), fontSize: font.size, fontWeight: font.weight }}
      >
        {"❯ claude --resume 90e31298\n"}
        <span style={{ fontWeight: font.weightBold }}>{"● 굵은 글자: 스크롤이 굼뜨던 원인을 찾았어요\n"}</span>
        {"  fn readable(&self, wait_ms: i32) -> bool { 0O 1lI }\n"}
        {"  한글과 English가 섞인 줄 ─── │ ✔ ↻"}
      </div>
      <Group
        note={
          <>
            {IS_MAC ? "SF Mono는 macOS에 들어 있어요." : "SF Mono는 macOS 글꼴이라 이 컴퓨터에서는 기본 고정폭 글꼴로 보여요."} 다른 글꼴은 설치된 이름을 그대로 적어 주세요. 그 글꼴에 없는 글자(프롬프트 아이콘 등)는{" "}
            <Code>MesloLGLDZ Nerd Font Mono</Code>로 채워요.
          </>
        }
      >
        <Row title="글꼴">
          <input
            className={cn(input, "w-60 font-mono")}
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
        </Row>
        <Row
          title="크기"
          desc={
            <>
              터미널에서 <Code>{shortcutLabel("zoomIn")}</Code> <Code>{shortcutLabel("zoomOut")}</Code>로 잠시 키우고 줄이고, <Code>{shortcutLabel("zoomReset")}</Code>로 되돌려요.
              {zoom.terminal !== 0 && ` 지금 ${zoom.terminal > 0 ? "+" : ""}${zoom.terminal}px (${font.size + zoom.terminal}px).`}
            </>
          }
        >
          <input
            className={cn(input, "w-16 font-mono")}
            type="number"
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
            value={font.size}
            onChange={(e) => Number(e.target.value) && apply({ size: Number(e.target.value) })}
          />
        </Row>
        <Row title="굵기">{weightSelect(font.weight, (weight) => apply({ weight }))}</Row>
        <Row title="굵은 글자 굵기">{weightSelect(font.weightBold, (weightBold) => apply({ weightBold }))}</Row>
        <Row title="기본값" desc="SF Mono 14px · 굵기 500 (Orca와 같아요)">
          <button className={button} disabled={isDefault} onClick={() => apply({ ...DEFAULT_TERMINAL_FONT })}>
            되돌리기
          </button>
        </Row>
      </Group>
      {zoom.ui !== 1 && <p className="text-xs text-muted-foreground">지금 앱 화면 배율은 {Math.round(zoom.ui * 100)}%예요. 터미널 밖에서 {shortcutLabel("zoomReset")}을 누르면 되돌아가요.</p>}
    </>
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
    <>
      <Group title="claude">
        <Toggle checked={settings.claude.skip_permissions} onChange={(v) => change({ ...settings, claude: { ...settings.claude, skip_permissions: v } })} title="권한 확인 없이 실행">
          <Code>--dangerously-skip-permissions</Code>를 붙여요. 파일 수정이나 명령 실행을 묻지 않아요.
        </Toggle>
        <Toggle checked={settings.claude.teams} onChange={(v) => change({ ...settings, claude: { ...settings.claude, teams: v } })} title="에이전트 팀">
          팀을 만들라고 시키면 팀원 claude를 실행해요. 리더 칸의 [팀원 N]을 누르면 팀원 터미널을 볼 수 있어요.
        </Toggle>
      </Group>
      <Group title="thuminal 스킬" note="바꾸면 다음에 실행하는 claude부터 적용돼요. 이미 열린 셸에서 치는 claude도 마찬가지예요.">
        {skills.length === 0 ? (
          <Row title={<span className="text-muted-foreground">{oldDaemon ? "데몬이 이전 버전이라 고를 수 없어요. 데몬을 다시 시작하면 여기서 골라요." : "플러그인에 스킬이 없어요."}</span>} />
        ) : (
          skills.map((k) => (
            <Toggle key={k.name} checked={!disabled.includes(k.name)} onChange={(v) => setSkill(k.name, v)} title={<span className="font-mono text-xs">thuminal:{k.name}</span>}>
              <span className="line-clamp-2" title={k.description}>
                {k.description}
              </span>
            </Toggle>
          ))
        )}
      </Group>
    </>
  );
}

const SHORTCUT_GROUPS: ShortcutGroup[] = ["화면", "탭 · 칸", "글자 크기"];

/** 단축키 (이 앱에 남는다). [변경] 을 누르고 새 키를 누르면 바뀐다. 같은 키를 쓰던 동작에서는 그 키가 빠진다 */
function ShortcutsSection() {
  useShortcutOverrides();
  const [recording, setRecording] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    setRecordingShortcut(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      const c = comboOf(e);
      if (!c) return;
      // 수정키 없이 누르는 키는 글자 입력과 겹친다
      if (!/[⌃⌥⌘]/.test(c.mods)) return setMessage(IS_MAC ? "⌘ ⌃ ⌥ 중 하나와 같이 눌러 주세요." : "Ctrl이나 Alt와 같이 눌러 주세요.");
      const action = SHORTCUT_ACTIONS.find((a) => a.id === recording);
      if (!action) return setRecording(null);
      if (action.digits && !c.digit) return setMessage("이 동작은 수정키와 1~9 중 하나를 같이 눌러 주세요.");
      const key = action.digits ? `${c.mods}1~9` : c.combo;
      const owner = ownerOf(key, action.id);
      setShortcut(action.id, key);
      setMessage(owner ? `${keyLabel(key)} 키를 "${owner.label}"에서 빼서 "${action.label}"에 넣었어요.` : null);
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      setRecordingShortcut(false);
    };
  }, [recording]);
  const btn = "rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground";
  return (
    <>
      <div className="flex items-center gap-3 text-xs">
        <span className={cn("min-w-0 flex-1", message ? "text-agent-attention" : "text-muted-foreground")}>
          {message ?? `[변경]을 누르고 새 키를 눌러요. 브라우저 칸에 포커스가 있으면 ${IS_MAC ? "⌘" : "Ctrl"} 조합만 앱으로 와요.`}
        </span>
        <button className={button} onClick={() => (resetAllShortcuts(), setMessage(null))}>
          모두 기본값으로
        </button>
      </div>
      {SHORTCUT_GROUPS.map((g) => (
        <Group key={g} title={g}>
          {SHORTCUT_ACTIONS.filter((a) => a.group === g).map((a) => {
            const keys = keysOf(a.id);
            return (
              <div key={a.id} className="group flex h-9 items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                <span className="flex items-center gap-1 opacity-0 group-hover:opacity-100 has-[:focus-visible]:opacity-100">
                  <button className={cn(btn, !isCustomized(a.id) && "hidden")} onClick={() => resetShortcut(a.id)}>
                    기본값
                  </button>
                  <button className={cn(btn, !keys.length && "hidden")} onClick={() => clearShortcut(a.id)}>
                    지우기
                  </button>
                </span>
                {recording === a.id ? (
                  <span className="text-xs text-agent-attention">새 키를 눌러 주세요 (Esc 취소)</span>
                ) : keys.length ? (
                  keys.map((k) => (
                    <kbd key={k} className="rounded border bg-muted px-1.5 py-0.5 font-mono text-2xs">
                      {keyLabel(k)}
                    </kbd>
                  ))
                ) : (
                  <span className="text-xs text-muted-foreground">없음</span>
                )}
                <button className={btn} onClick={() => (setMessage(null), setRecording(recording === a.id ? null : a.id))}>
                  {recording === a.id ? "취소" : "변경"}
                </button>
              </div>
            );
          })}
        </Group>
      ))}
    </>
  );
}

/** 알림 설정 (이 앱에 남는다) */
function NotifySection() {
  const model = useModel();
  const n = useApp((s) => s.notify);
  return (
    <>
      <Group note="지금 보고 있는 칸 일은 알리지 않아요. 알림을 누르면 그 칸으로 가요.">
        <Toggle checked={n.enabled} onChange={(v) => model.setNotify({ enabled: v })} title="알림">
          {IS_MAC ? "macOS 알림을 보내고, Dock에 안 읽은 워크트리 수를 띄워요." : "데스크톱 알림을 보내요."}
        </Toggle>
      </Group>
      <Group title="알릴 때">
        <Toggle disabled={!n.enabled} checked={n.done} onChange={(v) => model.setNotify({ done: v })} title="에이전트가 일을 마쳤을 때">
          마지막 답과 함께 알려요.
        </Toggle>
        <Toggle disabled={!n.enabled} checked={n.attention} onChange={(v) => model.setNotify({ attention: v })} title="에이전트가 묻거나 오류로 끝났을 때">
          권한 확인처럼 사용자를 부를 때 알려요.
        </Toggle>
        <Toggle disabled={!n.enabled} checked={n.bell} onChange={(v) => model.setNotify({ bell: v })} title="터미널 벨과 터미널 알림">
          벨이나 OSC 9 · 777 알림을 보내면 알려요.
        </Toggle>
        <Toggle disabled={!n.enabled} checked={n.sound} onChange={(v) => model.setNotify({ sound: v })} title="소리" />
      </Group>
    </>
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

/** 복사 단추가 붙은 주소 한 줄 */
function Address({ text }: { text: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] select-all">{text}</code>
      <CopyButton text={text} />
    </div>
  );
}

const qr = (text: string) => <div className="size-32 shrink-0 rounded bg-white p-1.5 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: renderSVG(text, { pixelSize: 4 }) }} />;

/** 이 컴퓨터 이름 = 기본 워크스페이스 이름. 다른 컴퓨터 · 폰이 이 이름으로 보고, 바꾸면 거기도 같이 바뀐다 */
function ComputerName() {
  const model = useModel();
  const saved = useApp((s) => normalizeGroups(s.groups, s.repos).find((g) => g.id === DEFAULT_GROUP)?.name ?? "");
  const [name, setName] = useState(saved);
  useEffect(() => setName(saved), [saved]);
  const save = () => {
    if (name.trim() && name.trim() !== saved) model.renameGroup(DEFAULT_GROUP, name);
    else setName(saved);
  };
  return (
    <Row title="이 컴퓨터 이름" desc="다른 컴퓨터와 폰에 이 이름으로 보여요. 기본 워크스페이스 이름이기도 해서, 바꾸면 모두 같이 바뀌어요.">
      <input
        className={cn(input, "w-52 text-sm")}
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        onBlur={save}
      />
    </Row>
  );
}

/** 원격 접속: 폰·다른 컴퓨터 브라우저가 Tailscale 로 이 컴퓨터 데몬에 붙는다. 설정은 데몬이 들고 있어 앱을 꺼도 받는다 */
function RemoteSection({ remote }: { remote: RemoteApi }) {
  const model = useModel();
  const [st, setSt] = useState<RemoteStatus | null>(null);
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
  // 예전 데몬(부 버전 8 전)은 상태에 주소가 없다 (앱과 데몬은 함께 업데이트된다)
  const urls = st.urls ?? [];
  const host = st.tailnet.find((a) => !a.includes(":")) ?? st.tailnet[0];
  const apkUrl = host && st.apk && st.enabled ? `http://${host.includes(":") ? `[${host}]` : host}:${st.port}/download/thuminal.apk` : null;
  const problems = [
    !st.tailnet.length && "Tailscale 주소를 찾지 못했어요. Tailscale을 켜면 15초 안에 그 주소에서도 받아요.",
    st.error,
    !st.web && "웹 화면 파일이 없어 브라우저로 열면 빈 화면이 나와요. 개발 중이면 pnpm -C apps/web build를 실행해 주세요.",
  ].filter(Boolean);

  return (
    <>
      <Group>
        <ComputerName />
      </Group>
      <Group title="원격 접속">
        <Toggle checked={st.enabled} onChange={(v) => change({ enabled: v })} title="원격 접속">
          같은 Tailscale 망의 폰 · 다른 컴퓨터에서 이 컴퓨터의 터미널과 에이전트를 써요. 앱을 꺼도 데몬이 받아요.
        </Toggle>
        <Row title="포트" desc={st.listening.length ? `받는 주소 ${st.listening.join(", ")}` : "지금 받고 있지 않아요"}>
          <input
            className={cn(input, "w-20 font-mono")}
            value={port}
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={() => Number(port) && Number(port) !== st.port && change({ port: Number(port) })}
          />
        </Row>
        <Toggle checked={st.lan} onChange={(v) => change({ lan: v })} title="같은 Wi‑Fi에서도 받기">
          Tailscale 밖 연결이라 암호화되지 않아요.
        </Toggle>
        {problems.map((p) => (
          <div key={String(p)} className="py-2 text-xs whitespace-pre-wrap text-agent-attention">
            {p}
          </div>
        ))}
      </Group>

      <Group title="접속 주소" note="폰은 카메라나 thuminal 앱의 [QR 찍기]로 찍고, 다른 컴퓨터는 설정 → 원격 컴퓨터에 주소를 붙여 넣어요.">
        {urls.length ? (
          <div className="flex gap-4 py-3">
            {qr(urls[0])}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs">
              {!st.enabled && <div className="text-agent-attention">원격 접속이 꺼져 있어요. 켜야 이 주소로 연결할 수 있어요.</div>}
              {urls.map((u) => (
                <Address key={u} text={u} />
              ))}
              <div className="text-muted-foreground">{st.connected ? `지금 연결 ${st.connected}` : st.last_seen ? `마지막 연결 ${ago(st.last_seen)}` : "아직 연결한 기기가 없어요"}</div>
            </div>
          </div>
        ) : (
          <div className="py-2 text-xs text-agent-attention">폰이 닿을 주소가 없어요. Tailscale을 켜거나 같은 Wi‑Fi에서도 받기를 켜 주세요.</div>
        )}
        <Row title="토큰 바꾸기" desc="지금 주소로 연결된 폰 · 컴퓨터가 모두 끊기고, 새 주소로 다시 연결해야 해요.">
          <button
            className={cn(button, "text-destructive hover:bg-destructive/10")}
            onClick={() =>
              model.setDialog({
                kind: "confirm",
                title: "토큰을 바꿀까요?",
                body: "지금 주소로 연결된 폰 · 다른 컴퓨터가 모두 끊겨요. 다시 쓰려면 새 주소(QR)로 다시 연결해야 해요. 예전에 기기마다 만든 토큰도 함께 지워져요.",
                action: "토큰 바꾸기",
                run: () => void remote.rotate().then(setSt, model.fail),
              })
            }
          >
            토큰 바꾸기
          </button>
        </Row>
      </Group>

      {apkUrl && (
        <Group title="안드로이드 앱">
          <div className="flex items-center gap-4 py-3">
            {qr(apkUrl)}
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs">
              <div className="text-muted-foreground">QR을 찍어 내려받아요. 폰이 Tailscale에 연결돼 있어야 해요.</div>
              <Address text={apkUrl} />
            </div>
          </div>
        </Group>
      )}

      {st.devices.length > 0 && (
        <Group title="예전 기기 토큰" note="토큰을 하나로 바꾸기 전에 기기마다 만든 토큰이에요. 계속 연결할 수 있고, [토큰 바꾸기]를 누르면 함께 지워져요.">
          {st.devices.map((d) => (
            <Row
              key={d.id}
              title={
                <span className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", d.connected ? "bg-agent-done" : "bg-muted-foreground/40")} />
                  {d.name}
                </span>
              }
              desc={d.connected ? `연결 ${d.connected}` : ago(d.last_seen)}
            >
              <button
                className={cn(button, "text-destructive hover:bg-destructive/10")}
                onClick={() => confirm(`${d.name} 기기 토큰을 지울까요? 연결돼 있으면 바로 끊겨요.`) && void remote.removeDevice(d.id).then(setSt, model.fail)}
              >
                지우기
              </button>
            </Row>
          ))}
        </Group>
      )}
    </>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => hosts.onChange(setList), [hosts]);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await hosts.add(url);
      setUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Group
        title="추가"
        note={
          <>
            그 컴퓨터의 설정 → 원격 접속에 있는 접속 주소나 <Code>thuminal remote url</Code>이 찍는 주소를 붙여 넣어요. Tailscale 주소(100.x.y.z)만 돼요. 이름은 그 컴퓨터에서
            정한 이름으로 보여요.
          </>
        }
      >
        <div className="flex items-center gap-2 py-2.5">
          <input
            className={cn(input, "h-8 min-w-0 flex-1 font-mono")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && url.trim() && !busy && void add()}
            placeholder="http://100.x.y.z:6780/#token=…"
          />
          <button
            className="h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            disabled={!url.trim() || busy}
            onClick={() => void add()}
          >
            {busy ? "연결해 보는 중…" : "추가"}
          </button>
        </div>
        {error && <div className="py-2 text-xs whitespace-pre-wrap text-destructive">{error}</div>}
      </Group>

      <Group title="등록한 컴퓨터">
        {list.length === 0 && <Row title={<span className="text-muted-foreground">아직 없어요</span>} />}
        {list.map((h) => {
          const bad = h.state === "unauthorized" || h.state === "version_mismatch";
          const dot = h.state === "connected" ? "bg-agent-done" : h.state === "connecting" ? "bg-agent-working" : bad ? "bg-destructive" : "bg-muted-foreground/40";
          const state = `${HOST_STATE[h.state]}${h.state === "disconnected" && h.retryInMs ? ` · ${Math.ceil(h.retryInMs / 1000)}초 뒤 다시 연결` : ""}`;
          return (
            <Row
              key={h.id}
              title={
                <span className="flex items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full", dot)} />
                  <span className="truncate">{h.name}</span>
                  <span className={cn("text-xs", bad ? "text-destructive" : "text-muted-foreground")}>{state}</span>
                </span>
              }
              desc={
                <>
                  <span className="font-mono">{h.address}</span>
                  {h.daemonVersion && <span title="데몬 버전 · 프로토콜 버전"> · thuminal {h.daemonVersion}{h.protocol ? ` (${h.protocol[0]}.${h.protocol[1]})` : ""}</span>}
                  {h.warning && <div className="text-agent-attention">{h.warning}</div>}
                  {h.state !== "connected" && h.error && <div className="whitespace-pre-wrap">{h.error}</div>}
                </>
              }
            >
              {h.state !== "connected" && (
                <button className={button} onClick={() => void hosts.reconnect(h.id).catch(model.fail)}>
                  다시 연결
                </button>
              )}
              <button
                className={cn(button, "text-destructive hover:bg-destructive/10")}
                onClick={() =>
                  confirm(`${h.name} 컴퓨터를 지울까요? 그 컴퓨터에서 연결을 완전히 막으려면 그 컴퓨터의 설정 → 원격 접속에서 [토큰 바꾸기]를 눌러 주세요.`) &&
                  void hosts.remove(h.id).catch(model.fail)
                }
              >
                지우기
              </button>
            </Row>
          );
        })}
      </Group>
    </>
  );
}

/** 정보: 앱 · 데몬 버전과 업데이트 확인 */
function AboutSection({ updates }: { updates?: UpdatesApi }) {
  const model = useModel();
  const update = useApp((s) => s.update);
  const [app, setApp] = useState<string | null>(null);
  const [daemon, setDaemon] = useState<{ version: string; engine: string } | null>(null);
  // idle: 아직 안 눌렀다, checking, latest: 최신, 오류 글
  const [check, setCheck] = useState<"idle" | "checking" | "latest" | { error: string }>("idle");
  useEffect(() => {
    void updates?.version().then(setApp, () => undefined);
    void model.services.host.daemon().then(setDaemon, () => undefined);
  }, [updates, model]);
  const run = async () => {
    setCheck("checking");
    try {
      const found: AppUpdate | null = await model.checkUpdate(false);
      setCheck(found ? "idle" : "latest");
    } catch (e) {
      setCheck({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  const status =
    check === "checking"
      ? "확인하는 중…"
      : update
        ? `새 버전이 있어요: ${update.version}`
        : check === "latest"
          ? "최신 버전이에요."
          : typeof check === "object"
            ? `확인하지 못했어요: ${check.error}`
            : "6시간마다 저절로 확인해요.";
  return (
    <>
      <Group>
        <Row title="앱" desc={app ? `thuminal ${app}` : "웹 화면"} />
        <Row title="데몬" desc={daemon ? `thuminal ${daemon.version} · 엔진 ${daemon.engine}` : "읽는 중…"} />
      </Group>
      {updates && (
        <Group note={update?.notes ? <span className="whitespace-pre-wrap">{update.notes}</span> : undefined}>
          <Row title="업데이트" desc={<span className={cn(typeof check === "object" && "text-destructive", update && "text-foreground")}>{status}</span>}>
            <button className={button} disabled={check === "checking"} onClick={() => void run()}>
              업데이트 확인
            </button>
            {update && (
              <button className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90" onClick={() => model.confirmUpdate()}>
                업데이트 설치
              </button>
            )}
          </Row>
        </Group>
      )}
    </>
  );
}

type Section = SettingsSection;

const SECTIONS: { id: Section; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "theme", label: "테마", icon: <PaletteIcon />, desc: "누르면 바로 바뀌어요. 터미널 안 프로그램도 새 색을 받아요." },
  { id: "font", label: "터미널 글꼴", icon: <TextAaIcon />, desc: "모든 터미널에 바로 적용되고 이 앱에 남아요." },
  { id: "keys", label: "단축키", icon: <KeyboardIcon />, desc: "바꾸면 바로 적용되고 이 앱에 남아요." },
  { id: "agent", label: "에이전트", icon: <RobotIcon />, desc: "thuminal에서 실행하는 claude에 붙일 옵션이에요. 데몬에 남아 CLI에서 실행해도 같아요." },
  { id: "notify", label: "알림", icon: <BellIcon />, desc: "언제 알릴지 골라요." },
  { id: "remote", label: "원격 접속", icon: <BroadcastIcon />, desc: "폰이나 다른 컴퓨터에서 Tailscale로 이 컴퓨터에 연결해요. 설정은 데몬에 남아요." },
  { id: "hosts", label: "원격 컴퓨터", icon: <DesktopIcon />, desc: "다른 컴퓨터의 thuminal에 연결해요. 끊기면 알아서 다시 연결해요." },
  { id: "about", label: "정보", icon: <InfoIcon />, desc: "버전과 업데이트" },
];

export function SettingsDialog() {
  const model = useModel();
  const open = useApp((s) => s.dialog?.kind === "settings");
  const want = useApp((s) => (s.dialog?.kind === "settings" ? s.dialog.section : undefined));
  const update = useApp((s) => s.update);
  const [section, setSection] = useState<Section>("theme");
  // 칸을 정해 열면 (새 탭 메뉴의 "에이전트 설정…") 그 칸으로 간다
  useEffect(() => {
    if (open && want) setSection(want);
  }, [open, want]);
  const { remote, hosts, updates } = model.services.host;
  const shown = SECTIONS.filter((s) => (s.id === "remote" ? remote : s.id === "hosts" ? hosts : true));
  const cur = shown.find((s) => s.id === section) ?? shown[0];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && model.setDialog(null)}>
      <DialogContent className="flex h-[min(680px,88vh)] gap-0 overflow-hidden p-0 select-text sm:max-w-[880px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r bg-sidebar p-2">
          <DialogTitle className="px-2 pt-2 pb-3 text-sm">설정</DialogTitle>
          {shown.map((s) => (
            <button
              key={s.id}
              className={cn(
                "flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-sm [&_svg]:size-4 [&_svg]:shrink-0",
                s.id === cur.id ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
              )}
              onClick={() => setSection(s.id)}
            >
              {s.icon}
              <span className="flex-1 truncate">{s.label}</span>
              {s.id === "about" && update && <span className="size-1.5 rounded-full bg-primary" title={`새 버전 ${update.version}`} />}
            </button>
          ))}
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="shrink-0 px-7 pt-5 pb-4 pr-12">
            <h2 className="text-base font-semibold">{cur.label}</h2>
            <DialogDescription className="text-xs">{cur.desc}</DialogDescription>
          </header>
          <div key={cur.id} className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-7 pb-7 thm-scroll">
            {cur.id === "remote" && remote ? (
              <RemoteSection remote={remote} />
            ) : cur.id === "hosts" && hosts ? (
              <HostsSection hosts={hosts} />
            ) : cur.id === "font" ? (
              <FontSection />
            ) : cur.id === "keys" ? (
              <ShortcutsSection />
            ) : cur.id === "agent" ? (
              <AgentSection />
            ) : cur.id === "notify" ? (
              <NotifySection />
            ) : cur.id === "about" ? (
              <AboutSection updates={updates} />
            ) : (
              <ThemeSection />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
