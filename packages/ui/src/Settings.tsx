// 설정 창: 다크/라이트, 다크용·라이트용 터미널 테마, 화면 색을 터미널 테마에서 뽑을지.
// 테마를 누르면 바로 적용된다 (따로 저장 단추가 없다).

import { CheckIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useState } from "react";

import { type TerminalTheme, themes } from "@thuminal/themes";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { Label } from "./components/ui/label";
import { Switch } from "./components/ui/switch";
import { cn } from "./lib/utils";
import { useApp, useModel } from "./store";
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

export function SettingsDialog() {
  const model = useModel();
  const open = useApp((s) => s.dialog?.kind === "settings");
  const theme = useApp((s) => s.theme);
  const systemDark = useApp((s) => s.systemDark);
  const now = currentTheme(theme, systemDark);
  const [editing, setEditing] = useState<"dark" | "light">(now.scheme);
  const picked = themes.find((t) => t.id === theme[editing]) ?? now;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && model.setDialog(null)}>
      <DialogContent className="flex h-[min(640px,85vh)] flex-col gap-4 sm:max-w-[780px]">
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
          <DialogDescription>테마를 누르면 바로 바뀐다. 터미널 안에서 도는 프로그램도 새 색으로 답을 받는다.</DialogDescription>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  );
}
