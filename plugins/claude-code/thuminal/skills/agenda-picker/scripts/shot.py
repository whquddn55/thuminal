#!/usr/bin/env python3
"""안건 그림을 parallel-browser 로 찍는다. 안마다 같은 크기 · 같은 배율로 찍으려는 도구다.

    shot.py <URL 또는 HTML 파일> <out.png> [--size 1200x560] [--dpr 2] [--full | --fit] [--dark] [--wait 300]
    shot.py --batch shots.json          [{"src": …, "out": …, "size": "1200x560", "dark": false, "fit": true}, …] 를 한 세션으로

- --fit 은 높이를 내용 (body 아래 끝) 에 맞춰 자른다. 직접 그린 개념 그림 아래에 빈 자리가 찍히지 않게 쓴다 (--size 의 높이는 넘지 않는다).
- HTML 파일은 그 폴더를 127.0.0.1 임시 서버로 연다 (확장은 file:// 을 못 열 수 있다).
- 화면 크기 · 배율 · 라이트/다크(prefers-color-scheme) 를 고정하고, parallel-browser 상태 표시는 숨긴 채 찍는다.
- 사용자 Chrome · Edge 의 에이전트 창에서 돌고 포커스를 가져가지 않는다. 다 찍으면 탭 · 세션을 닫는다.
- 로그인이 필요한 앱 화면은 이 도구 대신 thuthi-browser:parallel-browser 스킬로 직접 몰아 찍는다 (같은 크기는
  `s.cdp('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor, mobile: false})`).
"""
from __future__ import annotations

import argparse
import functools
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))   # pbpage.py 는 이 폴더에 있다
from pbpage import Browser  # noqa: E402


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class Files:
    """HTML 파일이 든 폴더마다 임시 서버 하나."""

    def __init__(self):
        self.servers: dict[Path, ThreadingHTTPServer] = {}

    def url(self, src: str) -> str:
        if src.startswith(("http://", "https://", "data:")):
            return src
        p = Path(src).expanduser().resolve()
        if not p.is_file():
            raise SystemExit(f"파일이 없다: {p}")
        srv = self.servers.get(p.parent)
        if not srv:
            srv = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(p.parent)))
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            self.servers[p.parent] = srv
        return f"http://127.0.0.1:{srv.server_address[1]}/{quote(p.name)}"

    def close(self):
        for s in self.servers.values():
            s.shutdown()


def size_of(text: str) -> tuple[int, int]:
    w, h = text.lower().split("x")
    return int(w), int(h)


def main() -> int:
    for _f in (sys.stdout, sys.stderr):   # Windows 콘솔(cp949)에서 ✓ · 한글을 찍다 죽지 않게
        try:
            _f.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="안건 그림 찍기 (parallel-browser)")
    ap.add_argument("src", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--size", default="1200x560")
    ap.add_argument("--dpr", type=float, default=2)
    ap.add_argument("--full", action="store_true", help="페이지 전체 높이")
    ap.add_argument("--fit", action="store_true", help="높이를 내용에 맞춰 자른다 (--size 높이가 최대)")
    ap.add_argument("--dark", action="store_true", help="prefers-color-scheme: dark")
    ap.add_argument("--wait", type=int, default=300, help="뜬 뒤 기다릴 ms")
    ap.add_argument("--batch", help="여러 장을 한 세션으로: JSON 배열 파일")
    a = ap.parse_args()
    jobs = json.loads(Path(a.batch).read_text()) if a.batch else [{"src": a.src, "out": a.out}]
    if not jobs or not all(j.get("src") and j.get("out") for j in jobs):
        ap.error("src 와 out 이 필요하다")
    files = Files()
    try:
        with Browser("agenda-picker 그림") as b:
            pg = None
            for j in jobs:
                w, h = size_of(j.get("size", a.size))
                dpr = float(j.get("dpr", a.dpr))
                dark = bool(j.get("dark", a.dark))
                if pg is None:
                    pg = b.new_page(viewport=(w, h), dpr=dpr, color_scheme="dark" if dark else "light")
                else:
                    pg.set_viewport(w, h, dpr)
                    pg.cdp("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": "dark" if dark else "light"}]})
                pg.goto(files.url(j["src"]))
                pg.wait_for_timeout(int(j.get("wait", a.wait)))
                if j.get("fit", a.fit):
                    ch = pg.evaluate("""(() => { const b = document.body, cs = getComputedStyle(b);
                        let bottom = 0;
                        for (const el of b.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.width && r.height) bottom = Math.max(bottom, r.bottom); }
                        return Math.ceil(bottom + parseFloat(cs.paddingBottom) + parseFloat(cs.marginBottom)); })()""")
                    if 0 < ch < h:
                        h = ch
                        pg.set_viewport(w, h, dpr)
                        pg.wait_for_timeout(100)
                out = Path(j["out"]).expanduser()
                out.parent.mkdir(parents=True, exist_ok=True)
                pg.screenshot(str(out), full_page=bool(j.get("full", a.full)))
                print(f"{out}  ({w}x{h} @{dpr:g}x{' dark' if dark else ''})")
    finally:
        files.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
