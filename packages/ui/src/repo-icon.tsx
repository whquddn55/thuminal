// 저장소 표시: 저장소 안에서 찾은 아이콘 그림(데몬 `repo_icon`), 없으면 이름 첫 글자를 이름에서 뽑은 색 사각형에 (Orca 의 저장소 배지처럼).

import { useEffect, useState } from "react";

import type { HostApi } from "@thuminal/term-core";

import { cn } from "./lib/utils";
import { useModel } from "./store";

/**
 * `<호스트>|<저장소 id>` → 그림 data URL (없으면 null). 저장소마다 한 번만 묻는다. 묻기가 실패하면 지워서 다음에 다시 묻는다.
 * 데몬이 다시 뜨면(찾는 규칙이 바뀌었을 수 있다) 그 호스트 것을 비워 다시 묻는다
 */
const icons = new Map<string, Promise<string | null>>();
const resolved = new Map<string, string | null>();
const watched = new WeakSet<HostApi>();
/** 다시 묻기를 기다리는 그림들 (데몬이 다시 뜨면 부른다) */
const reloaders = new Set<() => void>();

const keyOf = (host: HostApi, repo: string) => `${host.hostId ?? ""}|${repo}`;

function iconOf(host: HostApi, repo: string): Promise<string | null> {
  if (!watched.has(host)) {
    watched.add(host);
    host.onEvent((e) => {
      if (e.type !== "daemon_reconnected") return;
      const prefix = `${host.hostId ?? ""}|`;
      for (const k of [...icons.keys()]) if (k.startsWith(prefix)) icons.delete(k);
      for (const r of reloaders) r();
    });
  }
  const key = keyOf(host, repo);
  let p = icons.get(key);
  if (!p) {
    p = host.repoIcon(repo).then(
      (icon) => {
        const url = icon ? `data:${icon.mime};base64,${icon.data}` : null;
        resolved.set(key, url);
        return url;
      },
      () => {
        icons.delete(key);
        return null;
      },
    );
    icons.set(key, p);
  }
  return p;
}

export function RepoMark({ repo, name, className }: { repo: string; name: string; className?: string }) {
  const host = useModel().services.host;
  const [url, setUrl] = useState(() => resolved.get(keyOf(host, repo)) ?? null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    setUrl(resolved.get(keyOf(host, repo)) ?? null);
    setBroken(false);
    const load = () => void iconOf(host, repo).then((u) => live && (setUrl(u), setBroken(false)));
    load();
    reloaders.add(load);
    return () => {
      live = false;
      reloaders.delete(load);
    };
  }, [host, repo]);

  if (url && !broken) {
    return <img src={url} alt="" draggable={false} className={cn("size-5 shrink-0 rounded-[5px] bg-foreground/[0.07] object-contain ring-1 ring-foreground/15", className)} onError={() => setBroken(true)} />;
  }
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className={cn("flex size-5 shrink-0 items-center justify-center rounded-[5px] text-[11px] leading-none font-bold text-white uppercase", className)} style={{ background: `hsl(${h} 45% 45%)` }}>
      {[...name][0] ?? "?"}
    </span>
  );
}
