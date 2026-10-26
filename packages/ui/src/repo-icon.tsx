// 저장소 표시: 저장소 안에서 찾은 아이콘 그림(데몬 `repo_icon`), 없으면 이름 첫 글자를 이름에서 뽑은 색 사각형에 (Orca 의 저장소 배지처럼).

import { useEffect, useState } from "react";

import type { HostApi } from "@thuminal/term-core";

import { cn } from "./lib/utils";
import { useModel } from "./store";

/** 저장소 id → 그림 data URL (없으면 null). 저장소마다 한 번만 묻는다. 묻기가 실패하면 지워서 다음에 다시 묻는다 */
const icons = new Map<string, Promise<string | null>>();
const resolved = new Map<string, string | null>();

function iconOf(host: HostApi, repo: string): Promise<string | null> {
  let p = icons.get(repo);
  if (!p) {
    p = host.repoIcon(repo).then(
      (icon) => {
        const url = icon ? `data:${icon.mime};base64,${icon.data}` : null;
        resolved.set(repo, url);
        return url;
      },
      () => {
        icons.delete(repo);
        return null;
      },
    );
    icons.set(repo, p);
  }
  return p;
}

export function RepoMark({ repo, name, className }: { repo: string; name: string; className?: string }) {
  const host = useModel().services.host;
  const [url, setUrl] = useState(() => resolved.get(repo) ?? null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    let live = true;
    setUrl(resolved.get(repo) ?? null);
    setBroken(false);
    void iconOf(host, repo).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [host, repo]);

  if (url && !broken) {
    return <img src={url} alt="" draggable={false} className={cn("size-4 shrink-0 rounded-[4px] object-contain", className)} onError={() => setBroken(true)} />;
  }
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9px] leading-none font-bold text-white uppercase", className)} style={{ background: `hsl(${h} 45% 45%)` }}>
      {[...name][0] ?? "?"}
    </span>
  );
}
