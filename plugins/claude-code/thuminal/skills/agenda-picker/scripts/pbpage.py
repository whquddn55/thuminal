"""스킬 스크립트가 parallel-browser 로 브라우저를 다루게 하는 얇은 다리.

    from pbpage import Browser
    with Browser("agenda-selftest") as b:              # 세션 하나 (탭 묶음). 끝나면 닫는다
        pg = b.new_page(viewport=(1360, 900))          # 첫 탭을 쓰고, 다음부터는 새 탭
        pg.goto("http://127.0.0.1:8000/")
        pg.click("#send"); pg.screenshot("/tmp/a.png")

parallel-browser 는 사용자 Chrome · Edge 의 에이전트 전용 창에서 돌고 포커스를 가져가지 않는다. `parallel-browser nodejs`
프로세스 하나를 띄워 두고 JSON 한 줄씩 명령을 보낸다 (세션 메서드 이름을 그대로 부른다: "goto", "mouse.move", "cdp" …).
작업이 끝나면 세션을 닫는다 (사용자 요청: 각 작업 뒤 자기가 띄운 탭은 끈다). keep=True 면 남긴다.
Page 는 Playwright 동기 API 의 일부와 같은 이름 · 모양이라 Playwright 로 쓰던 스크립트를 조금만 고쳐 옮길 수 있다.
python3 3.9 표준 라이브러리만 쓴다.
"""
from __future__ import annotations

import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

MARK = "@@PB "

# parallel-browser nodejs 안에서 도는 쪽. 한 줄에 명령 하나를 받아 차례로 실행하고 결과를 MARK 를 붙여 돌려준다.
SERVER_JS = r"""
const cfg = JSON.parse(process.env.PBPAGE_CFG || '{}');
const s = await session(cfg.label || 'thuthi', cfg.options || {});
const send = (o) => process.stdout.write('@@PB ' + JSON.stringify(o) + '\n');
s.onDialog(async (d) => ({ accept: cfg.acceptDialogs !== false }));
send({ id: 0, ok: true, result: { handle: s.handle, tabId: s.tabId } });
let chain = Promise.resolve(), closing = false;
const run = async (m) => {
  try {
    if (m.path === '__close') { closing = true; if (!cfg.keep) await s.close(); return send({ id: m.id, ok: true, result: null }); }
    const parts = m.path.split('.');
    let obj = s;
    for (const p of parts.slice(0, -1)) obj = obj[p];
    const fn = obj[parts[parts.length - 1]];
    if (typeof fn !== 'function') throw new Error('no such method: ' + m.path);
    const r = await fn.apply(obj, m.args || []);
    send({ id: m.id, ok: true, result: r === undefined ? null : r });
  } catch (e) {
    send({ id: m.id, ok: false, error: String((e && e.stack) || e) });
  }
};
await new Promise((resolve) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) { const m = JSON.parse(line); chain = chain.then(() => run(m)); }
    }
  });
  process.stdin.on('end', resolve);
});
await chain;
if (!closing && !cfg.keep) { try { await s.close(); } catch (e) {} }
"""

# 페이지 JS 오류를 모아 두는 스크립트 (Playwright 의 pageerror 대신). 새 문서마다 먼저 돈다.
ERRORS_JS = """(() => { if (window.__pbErrors) return; window.__pbErrors = [];
  addEventListener('error', e => window.__pbErrors.push(String(e.message || e)));
  addEventListener('unhandledrejection', e => window.__pbErrors.push('unhandled: ' + String(e.reason))); })();"""

FN_RE = re.compile(r"^\s*(async\s+)?(function\b|\([^()]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)")


class PBError(RuntimeError):
    pass


def _pb_js():
    """parallel-browser CLI 의 js (bin/parallel-browser.js). npm link 가 건 곳 → thuthi-plugin 마켓플레이스 레포 순."""
    cands = []
    cmd = shutil.which("parallel-browser")
    if cmd:
        cands.append(Path(cmd).parent / "node_modules" / "parallel-browser" / "bin" / "parallel-browser.js")
    try:
        km = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "plugins" / "known_marketplaces.json"
        loc = (json.loads(km.read_text(encoding="utf-8")).get("thuthi-plugin") or {}).get("installLocation")
        if loc:
            cands.append(Path(loc) / "bin" / "parallel-browser.js")
    except (OSError, ValueError):
        pass
    return next((str(c) for c in cands if c.is_file()), None)


def pb_argv() -> list:
    """parallel-browser 를 부르는 명령 앞부분. Windows 는 npm 이 만든 parallel-browser.cmd 라 이름만으로는 실행되지 않고
    (WinError 2), .cmd 를 거치면 여러 줄 -e 인자가 깨진다 (Windows 실측). 그래서 node 로 js 를 직접 부른다."""
    if sys.platform == "win32":
        node, js = shutil.which("node"), _pb_js()
        if node and js:
            return [node, js]
        return [shutil.which("parallel-browser") or "parallel-browser"]
    return ["parallel-browser"]


def utf8_stdio() -> None:
    """Windows 콘솔(cp949)에서 ✓ · 한글을 찍다 UnicodeEncodeError 로 죽지 않게 stdout · stderr 를 UTF-8 로."""
    for f in (sys.stdout, sys.stderr):
        try:
            f.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


class Browser:
    """parallel-browser 세션 하나. 탭(Page) 여러 개를 가질 수 있다."""

    def __init__(self, label: str = "thuthi", *, keep: bool = False, accept_dialogs: bool = True,
                 budget: int = 4, timeout: float = 60):
        cfg = {"label": label, "keep": keep, "acceptDialogs": accept_dialogs, "options": {"budget": budget}}
        env = dict(os.environ, PBPAGE_CFG=json.dumps(cfg))
        self.proc = subprocess.Popen([*pb_argv(), "nodejs", "-e", SERVER_JS], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                     errors="replace", bufsize=1, env=env)
        self._q: dict[int, queue.Queue] = {}
        self._lock = threading.Lock()
        self._next = 1
        self._stderr: list[str] = []
        self._ready: queue.Queue = queue.Queue()
        self._q[0] = self._ready
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=lambda: self._stderr.extend(self.proc.stderr), daemon=True).start()
        try:
            hello = self._ready.get(timeout=timeout)
        except queue.Empty:
            self.proc.kill()
            raise PBError("parallel-browser 세션을 열지 못했다: " + "".join(self._stderr)[-500:])
        if not hello.get("ok"):
            raise PBError(hello.get("error", "세션 열기 실패"))
        self.handle = hello["result"]["handle"]
        self._first_tab = hello["result"]["tabId"]
        self._cur_tab = self._first_tab
        self.pages: list[Page] = []
        self.closed = False

    # -- 통신
    def _read(self):
        for line in self.proc.stdout:
            if not line.startswith(MARK):
                continue
            msg = json.loads(line[len(MARK):])
            q = self._q.get(msg.get("id"))
            if q:
                q.put(msg)
        for q in list(self._q.values()):   # 프로세스가 끝났다
            q.put({"ok": False, "error": "parallel-browser 프로세스가 끝났다: " + "".join(self._stderr)[-500:]})

    def call(self, path: str, *args, timeout: float = 60):
        if self.closed:
            raise PBError("세션이 닫혔다")
        with self._lock:
            mid = self._next
            self._next += 1
            q = self._q[mid] = queue.Queue()
            self.proc.stdin.write(json.dumps({"id": mid, "path": path, "args": list(args)}) + "\n")
            self.proc.stdin.flush()
        try:
            msg = q.get(timeout=timeout)
        except queue.Empty:
            raise PBError(f"{path}: {timeout}초 안에 답이 없다")
        finally:
            self._q.pop(mid, None)
        if not msg.get("ok"):
            raise PBError(f"{path}: {msg.get('error')}")
        return msg.get("result")

    def _use(self, tab):
        if tab != self._cur_tab:
            self.call("use", tab)
            self._cur_tab = tab

    # -- 탭
    def new_page(self, url: str = "", *, viewport=None, dpr: float = 1, color_scheme: str | None = "light",
                 collect_errors: bool = True) -> "Page":
        if not self.pages:
            tab = self._first_tab
        else:
            tab = self.call("newTab", "about:blank")
            tab = tab.get("tabId", tab) if isinstance(tab, dict) else tab
        pg = Page(self, tab)
        self.pages.append(pg)
        if viewport:
            pg.set_viewport(viewport[0], viewport[1], dpr)
        if color_scheme:
            pg.cdp("Emulation.setEmulatedMedia", {"features": [{"name": "prefers-color-scheme", "value": color_scheme}]})
        if collect_errors:
            pg.cdp("Page.addScriptToEvaluateOnNewDocument", {"source": ERRORS_JS})
        if url:
            pg.goto(url)
        return pg

    def close(self):
        if self.closed:
            return
        try:
            self.call("__close", timeout=20)
        except PBError:
            pass
        self.closed = True
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


class _Mouse:
    def __init__(self, pg: "Page"):
        self.pg = pg
        self._down = False

    def move(self, x, y, steps: int = 1):
        self.pg._call("mouse.move", x, y, {"steps": steps, "button": "left" if self._down else "none"})

    def down(self):
        self._down = True
        self.pg._call("mouse.down")

    def up(self):
        self._down = False
        self.pg._call("mouse.up")

    def click(self, x, y):
        self.pg._call("mouse.click", x, y)

    def wheel(self, dx, dy):
        self.pg._call("mouse.wheel", dx, dy)


class _Keyboard:
    def __init__(self, pg: "Page"):
        self.pg = pg

    def press(self, key: str):
        self.pg._call("press", key)

    def type(self, text: str, delay: float = 0):
        self.pg._call("type", text, {"delay": delay})


class Locator:
    """CSS 선택자 하나. count · first · click · inner_text 만 쓴다."""

    def __init__(self, pg: "Page", sel: str, nth: int | None = None):
        self.pg, self.sel, self.nth = pg, sel, nth

    def count(self) -> int:
        return self.pg.evaluate(f"document.querySelectorAll({json.dumps(self.sel)}).length")

    @property
    def first(self) -> "Locator":
        return Locator(self.pg, self.sel, 0)

    def _target(self) -> str:
        return f"css={self.sel}" + (f" >> nth={self.nth}" if self.nth is not None else "")

    def click(self):
        self.pg._call("click", self._target())

    def inner_text(self) -> str:
        return self.pg._el(self.sel, "e.innerText", self.nth or 0)

    def is_visible(self) -> bool:
        return self.pg._visible(self.sel)

    def focus(self):
        self.pg._el(self.sel, "(e.focus(), null)", self.nth or 0)

    def scroll_into_view_if_needed(self):
        self.pg._el(self.sel, "(e.scrollIntoView({block: 'center'}), null)", self.nth or 0)


class Page:
    """탭 하나. Playwright Page 와 같은 이름의 메서드 일부."""

    def __init__(self, browser: Browser, tab):
        self.b, self.tab = browser, tab
        self.mouse = _Mouse(self)
        self.keyboard = _Keyboard(self)
        self.viewport_size = None

    def _call(self, path, *args, timeout: float = 60):
        self.b._use(self.tab)
        return self.b.call(path, *args, timeout=timeout)

    def cdp(self, method: str, params: dict | None = None):
        return self._call("cdp", method, params or {})

    def set_viewport(self, width: int, height: int, dpr: float = 1):
        self.cdp("Emulation.setDeviceMetricsOverride", {"width": width, "height": height, "deviceScaleFactor": dpr, "mobile": False})
        self.viewport_size = {"width": width, "height": height}

    # -- 이동
    def goto(self, url: str, wait_until: str = "load", timeout: float = 30):
        # # 뒤만 바뀌면 문서를 다시 읽지 않아 load 가 오지 않는다. Playwright 처럼 같은 문서 안 이동으로 처리한다.
        cur = self.url() or ""
        if "#" in url and cur.split("#")[0] == url.split("#")[0]:
            self.evaluate(f"location.href = {json.dumps(url)}")
            return
        self._call("goto", url, {"waitUntil": wait_until, "timeout": int(timeout * 1000)}, timeout=timeout + 10)

    def reload(self):
        self._call("reload")

    def url(self) -> str:
        return self._call("url")

    def close(self):
        self._call("closeTab", self.tab)
        self.b.pages.remove(self)
        self.b._cur_tab = None

    # -- 읽기
    def evaluate(self, expr: str, arg=None):
        if FN_RE.match(expr):
            expr = f"({expr})({json.dumps(arg)})"
        return self._call("evaluate", expr)

    def _el(self, sel: str, body: str, nth: int = 0, timeout: float = 5):
        """선택자가 나올 때까지 기다렸다가 e 로 body 를 계산한다 (Playwright 의 자동 대기 대신)."""
        js = f"""(async () => {{ const end = Date.now() + {int(timeout * 1000)};
          for (;;) {{ const e = document.querySelectorAll({json.dumps(sel)})[{nth}];
            if (e) return {body};
            if (Date.now() > end) throw new Error('없다: ' + {json.dumps(sel)});
            await new Promise(r => setTimeout(r, 50)); }} }})()"""
        return self._call("evaluate", js)

    def inner_text(self, sel: str) -> str:
        return self._el(sel, "e.innerText")

    def get_attribute(self, sel: str, name: str):
        return self._el(sel, f"e.getAttribute({json.dumps(name)})")

    def _visible(self, sel: str) -> bool:
        return self.evaluate(f"""(e => !!e && e.checkVisibility() && e.getClientRects().length > 0)
            (document.querySelector({json.dumps(sel)}))""")

    def is_visible(self, sel: str) -> bool:
        return self._visible(sel)

    def locator(self, sel: str) -> Locator:
        return Locator(self, sel)

    def errors(self) -> list:
        return self.evaluate("window.__pbErrors || []") or []

    # -- 조작
    def click(self, sel: str):
        self._call("click", f"css={sel}")

    def fill(self, sel: str, text: str):
        self._call("fill", f"css={sel}", text)

    def hide_overlay(self, hide: bool = True):
        """parallel-browser 가 페이지에 띄우는 상태 표시 (파란 테두리 · 라벨 · [내가 하기]) 를 숨기거나 되살린다.

        스크린샷 · 녹화에 찍히지 않게 하려는 것이다. 사용자가 그 탭을 넘겨받는 버튼도 같이 숨으므로 찍는 동안만 숨긴다.
        """
        self.evaluate(f"""(() => {{ let st = document.getElementById('__pbpage_hide__');
          if ({'true' if hide else 'false'}) {{ if (!st) {{ st = document.createElement('style'); st.id = '__pbpage_hide__';
            st.textContent = '#__parallel_browser_overlay__, [data-parallel-browser] {{ display: none !important; }}';
            document.documentElement.appendChild(st); }} }}
          else if (st) st.remove(); }})()""")

    def screenshot(self, path: str, full_page: bool = False, clean: bool = True):
        """clean=True 면 상태 표시를 숨긴 채 찍고 되살린다."""
        if clean:
            self.hide_overlay(True)
        try:
            self._call("screenshot", str(path), {"fullPage": full_page}, timeout=40)
        finally:
            if clean:
                self.hide_overlay(False)

    def wait_for_timeout(self, ms: float):
        time.sleep(ms / 1000)
