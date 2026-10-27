#!/usr/bin/env python3
"""picker.py 와 template.html 을 실제 브라우저(parallel-browser) 로 끝까지 돌려 본다.

    python3 selftest.py [안건폴더] [--shots /tmp/agenda-shots]

안건폴더(기본 references/example) 를 임시 폴더에 복사해 serve (독립 프로세스) + wait 를 띄우고, 대화에서 정한 안 미리 고르기 ·
라이트/다크 전환 · 바닥 카드에서 바로 고르기 · 안건 보기(머리 한 줄 · 반반 · 그림 높이 맞춤 · 그림 짝 · 설명 띠 + 펼치기 · 양쪽 같이 확대) · 고르기 · 메모 · 새로고침 유지 ·
보내기 · wait 출력 · 보안 검사(토큰 · Host) · 정적 사본 · 영상 그림(Range · 재생 · 확대) · 안건 변경 배너 · check 경고를 확인한다. 이어서 가짜 thuminal 로
thuminal 안 동작 (브라우저 탭 열기 · 칸 번호 기록 · 다시 열면 focus · 에이전트인지 확인 · 한 줄 넣기 · 넣은 뒤 칸 닫기 · 셸이면 넣지 않음 ·
데몬이 다시 떠 바뀐 세션 번호 따라가기), 가짜 소켓으로 인박스 전달, 요청 없을 때 서버가 스스로 끝나는 것을 본다.
--shots 를 주면 바닥 · 안건 보기 · 확대 · 펼친 띠 · 영상 확대를 PNG 로 남긴다 (Read 로 열어 본다).
exit 0 = 전부 통과. 브라우저는 parallel-browser (사용자 Chrome · Edge 의 에이전트 창, 포커스를 가져가지 않는다) 로 몰고,
화면은 1360×900 · 라이트 테마로 고정한다. 끝나면 띄운 탭 · 세션을 닫는다.
"""
import functools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import threading
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))   # pbpage.py 는 이 폴더에 있다
from pbpage import Browser  # noqa: E402

HERE = Path(__file__).resolve().parent
PICKER = HERE / "picker.py"
PY = "/usr/bin/python3" if os.path.exists("/usr/bin/python3") else sys.executable   # 시스템 3.9 호환까지 본다
# 바깥 thuminal 세션 · 이 Claude 세션 인박스 소켓의 값이 섞이면 진짜 세션에 보내기가 들어가고 진짜 데몬에 칸이 생긴다.
# 검사는 늘 이 값들을 지운 환경에서 시작한다 (검사가 진짜 터미널 · 세션 · 데몬에 아무것도 넣지 않게)
SCRUB_PREFIXES = ("THUMINAL_", "AGENDA_PICKER_", "ORCA_")
SCRUB_VARS = ("TERM_PROGRAM", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_CODE_SESSION_ID")
BASE_ENV = {k: v for k, v in os.environ.items() if k not in SCRUB_VARS and not k.startswith(SCRUB_PREFIXES)}

# 가짜 thuminal. 부른 인자와 THUMINAL_HOME · THUMINAL_SESSION_ID 를 옆 thuminal.log 에 적고, 옆 thuminal-state.json
# ({"agent", "panes": {번호: 주소}, "next", "restored", "delay"}) 로 진짜 CLI 의 --json 출력 모양을 흉내 낸다.
FAKE_THUMINAL = r'''#!/usr/bin/env python3
import json, os, sys, time
here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
with open(os.path.join(here, "thuminal.log"), "a") as f:
    f.write(json.dumps({"args": args, "home": os.environ.get("THUMINAL_HOME", ""),
                        "session": os.environ.get("THUMINAL_SESSION_ID", "")}, ensure_ascii=False) + "\n")
sf = os.path.join(here, "thuminal-state.json")
st = json.load(open(sf))
def save():
    json.dump(st, open(sf, "w"))
def layouts():
    tabs = [{"id": 1, "root": {"type": "pane", "pane": {"id": 1, "type": "terminal", "session": 7}}, "focused": 1}]
    tabs += [{"id": int(n), "root": {"type": "pane", "pane": {"id": int(n), "type": "doc", "doc": {"kind": "browser", "url": u}}},
              "focused": int(n)} for n, u in st["panes"].items()]
    return [{"workspace": "/fake/wt", "tabs": tabs, "active_tab": 1}]
def fail(msg):
    print("thuminal: 데몬이 오류로 답했다: " + msg, file=sys.stderr)
    sys.exit(1)
cmd = args[:2]
if cmd == ["term", "ls"]:
    agent = {"kind": "claude", "state": "idle"} if st["agent"] else None
    me = {"id": 12, "restored_from": 7, "created_at": 2000} if st.get("restored") else {"id": 7, "restored_from": None, "created_at": 1000}
    print(json.dumps([dict(me, state={"state": "running"}, agent=agent),
                      {"id": 3, "state": {"state": "running"}, "agent": None, "restored_from": None, "created_at": 5}]))
elif cmd == ["browser", "open"]:
    n = st["next"]
    st["next"] += 1
    st["panes"][str(n)] = args[2]
    save()
    print(json.dumps({"layouts": layouts(), "created": [n], "panes": [{"pane": n, "tab": n, "session": None}]}))
elif cmd == ["pane", "ls"]:
    print(json.dumps(layouts()))
elif cmd in (["pane", "focus"], ["pane", "close"]):
    n = args[2].lstrip("p")
    if n not in st["panes"]:
        fail("NotFound 칸 %s 이 없다" % args[2])
    if cmd[1] == "close":
        del st["panes"][n]
        save()
    else:
        print(args[2])
elif cmd == ["term", "send"]:
    time.sleep(float(st.get("delay") or 0))   # 진짜 send --enter 도 글이 화면에 찍힐 때까지 기다린다
else:
    fail("모르는 명령 " + " ".join(args))
'''

fails = []


def check(ok, msg):
    print(("  ok   " if ok else "  FAIL ") + msg)
    if not ok:
        fails.append(msg)


def wait_for(fn, timeout=6.0, step=0.1):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(step)
    return fn()


def http(url, method="GET", headers=None, body=None):
    req = urllib.request.Request(url, method=method, headers=headers or {}, data=body)
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def serve(d, env=None, *extra):
    """serve 는 서버를 떼어 내고 바로 끝나야 한다. (URL, 서버 pid) 를 돌려준다."""
    t0 = time.time()
    r = subprocess.run([PY, str(PICKER), "serve", str(d), *extra], capture_output=True, text=True, timeout=20, env=env or BASE_ENV)
    url = next((ln.split(" ", 1)[1].strip() for ln in r.stdout.splitlines() if ln.startswith("URL: ")), None)
    pid = (json.loads((d / ".picker" / "server.json").read_text()) if url else {}).get("pid", 0)
    return url, pid, time.time() - t0, r


def static_server(d):
    """정적 사본(index.html) 을 picker 서버 없이 여는 서버. 확장은 file:// 을 못 열 수 있어 http 로 연다."""
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass
    h = functools.partial(Quiet, directory=str(d))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}/index.html"


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def check_cli(d):
    """picker.py check: 옛 방식 라이트/다크 그림 경고, decided 오류."""
    d2 = d.parent / "check"
    shutil.copytree(d, d2)
    sp = json.loads((d2 / "agenda.json").read_text())
    ag = sp["agendas"][0]
    f = sorted(x for x in (d2 / "shots").iterdir() if x.is_file())[0].relative_to(d2).as_posix()   # 어느 안건 폴더든 있는 그림
    ag["options"][0]["shots"] = [{"src": f, "caption": "다크"}, {"src": f, "caption": "라이트"}]
    (d2 / "agenda.json").write_text(json.dumps(sp, ensure_ascii=False))
    r = subprocess.run([PY, str(PICKER), "check", str(d2)], capture_output=True, text=True)
    check(r.returncode == 0 and "한 항목으로 묶으면" in r.stdout, "check: 라이트 · 다크를 따로 넣으면 묶으라고 경고")
    ag["decided"] = "없는안"
    (d2 / "agenda.json").write_text(json.dumps(sp, ensure_ascii=False))
    r = subprocess.run([PY, str(PICKER), "check", str(d2)], capture_output=True, text=True)
    check(r.returncode == 1 and "decided" in r.stdout, "check: decided 가 없는 안 id 면 오류")
    del ag["decided"]
    (d2 / "shots" / "clip.mp4").write_bytes(b"")
    ag["options"][0]["shots"] = [{"light": f, "dark": "shots/clip.mp4"}]
    (d2 / "agenda.json").write_text(json.dumps(sp, ensure_ascii=False))
    r = subprocess.run([PY, str(PICKER), "check", str(d2)], capture_output=True, text=True)
    check(r.returncode == 1 and "한쪽만 영상" in r.stdout, "check: light · dark 중 한쪽만 영상이면 오류")


def make_clip(path, negate=False):
    """2초짜리 시험 영상 (ffmpeg testsrc2). 다크 쪽은 색을 뒤집어 라이트와 구별한다."""
    vf = ["-vf", "negate"] if negate else []
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x400:rate=24", "-t", "2", *vf,
                        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-movflags", "+faststart", str(path)], capture_output=True, text=True)
    return r.returncode == 0


def check_video(b, vd, shots):
    """영상 그림: 서버의 Range 응답, 바닥 카드는 첫 장면만, 안건 보기는 소리 없이 반복 재생 · 테마 따라 바뀜 · 양쪽 같이 확대."""
    (vd / "shots").mkdir(parents=True)
    if not shutil.which("ffmpeg"):
        print("  -- ffmpeg 가 없어 영상 검사를 건너뛴다 (brew install ffmpeg)")
        return None
    if not (make_clip(vd / "shots" / "v-light.mp4") and make_clip(vd / "shots" / "v-dark.mp4", True)):
        check(False, "ffmpeg 로 시험 영상을 만든다")
        return None
    clip = {"light": "shots/v-light.mp4", "dark": "shots/v-dark.mp4"}
    (vd / "agenda.json").write_text(json.dumps({"title": "영상 검사", "agendas": [{
        "id": "vid", "title": "움직이는 화면", "current": {"title": "지금", "shots": [clip]},
        "options": [{"id": "A", "title": "영상 안", "shots": [clip]}, {"id": "B", "title": "그림 없는 안"}]}]}, ensure_ascii=False))
    url, _, _, _ = serve(vd)
    check(bool(url), "영상 안건 폴더도 serve 된다")
    if not url:
        return vd

    size = (vd / "shots" / "v-light.mp4").stat().st_size
    def get(rng):
        req = urllib.request.Request(url + "shots/v-light.mp4", headers={"Range": rng} if rng else {})
        try:
            with urllib.request.urlopen(req, timeout=3) as r:
                return r.status, r.headers.get("Content-Range"), r.headers.get("Content-Type"), len(r.read())
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Content-Range"), None, 0
    check(get("bytes=0-1") == (206, f"bytes 0-1/{size}", "video/mp4", 2), "Range 요청이면 206 으로 그 구간만 (Safari 영상 재생)")
    check(get("bytes=-10") == (206, f"bytes {size - 10}-{size - 1}/{size}", "video/mp4", 10), "끝에서 n 바이트 Range")
    check(get("bytes=0-")[0] == 206 and get("bytes=0-")[3] == size, "열린 Range 는 끝까지")
    check(get(f"bytes={size}-")[:2] == (416, f"bytes */{size}"), "파일 밖 Range 는 416")
    check(get(None)[0] == 200 and get(None)[3] == size, "Range 가 없으면 200 으로 전체")

    pg = b.new_page(viewport=(1360, 900))
    pg.goto(url)
    pg.wait_for_timeout(600)
    vstate = lambda sel_: pg.evaluate(f"""(v => v && v.tagName === 'VIDEO' ? {{ paused: v.paused, t: v.currentTime, muted: v.muted, loop: v.loop,
        ready: v.readyState, w: v.videoWidth, src: v.getAttribute('src'), l: v.dataset.l, d: v.dataset.d }} : null)(document.querySelector({json.dumps(sel_)}))""")
    check(pg.locator(".card video, .card img").count() == 0, "바닥 카드에는 그림 · 영상이 없다 (안 목록만)")
    pg.locator(".card .card-head").first.click()
    pg.wait_for_timeout(1200)
    r1 = vstate("#cmp-right .pane-shot .media")
    ok = wait_for(lambda: (vstate("#cmp-right .pane-shot .media") or {}).get("t", 0) > 0.2, 4)
    check(bool(r1) and not r1["paused"] and r1["muted"] and r1["loop"] and bool(ok), f"안건 보기의 영상은 소리 없이 반복 재생 ({r1})")
    check(bool(vstate("#cmp-left .pane-shot .media")), "지금 쪽도 영상")
    pg.locator('#cmp [data-set-theme="dark"]').click()
    ok = wait_for(lambda: (lambda v: v and v["src"] == v["d"] and not v["paused"])(vstate("#cmp-right .pane-shot .media")), 4)
    check(bool(ok), "다크로 바꾸면 다크 영상으로 바뀌고 계속 재생")
    pg.locator('#cmp [data-set-theme="light"]').click()
    pg.wait_for_timeout(300)
    r = pg.evaluate("(e => (r => [r.x, r.y, r.width, r.height])(e.getBoundingClientRect()))(document.querySelector('#cmp-right .pane-shot .media'))")
    check(r[2] > 300, f"영상이 칸에 맞게 커진다 ({r[2]:.0f}px)")
    pg.mouse.click(r[0] + r[2] * 0.6, r[1] + r[3] * 0.5)
    pg.wait_for_timeout(200)
    t = pg.evaluate("[...document.querySelectorAll('.pane-shot .media')].map(v => getComputedStyle(v).transform)")
    check(len(t) == 2 and all(x.startswith("matrix(2,") for x in t), f"영상을 누르면 양쪽이 같이 2배 ({t})")
    if shots:
        pg.screenshot(path=str(shots / "7-video-zoom.png"))
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(150)
    check(set(pg.evaluate("[...document.querySelectorAll('.pane-shot .media')].map(v => getComputedStyle(v).transform)")) == {"none"},
          "Esc 로 영상 확대도 풀린다")
    errs = pg.errors()
    check(not errs, f"영상 페이지 JS 오류 없음 {errs}")
    pg.close()
    return vd


def steps_of(ag, op):
    """페이지와 같은 규칙으로 (지금 그림 있음, 안 그림 있음) 짝 목록을 만든다."""
    def caps(b):
        return [("" if isinstance(s, str) else str(s.get("caption") or "")) for s in ((b or {}).get("shots") or [])]
    L, R = caps(ag.get("current")), caps(op)
    if L + R and all(L + R):
        names = []
        for c in L + R:
            if c not in names:
                names.append(c)
        return [(c in L, c in R) for c in names]
    return [(i < len(L), i < len(R)) for i in range(max(len(L), len(R), 1))]


def main():
    for _f in (sys.stdout, sys.stderr):   # Windows 콘솔(cp949)에서 ✓ · 한글을 찍다 죽지 않게
        try:
            _f.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    args = sys.argv[1:]
    shots = None
    if "--shots" in args:
        i = args.index("--shots")
        shots = Path(args[i + 1])
        shots.mkdir(parents=True, exist_ok=True)
        del args[i:i + 2]
    src = Path(args[0]) if args else HERE.parent / "references" / "example"
    tmp = Path(tempfile.mkdtemp(prefix="agenda-selftest-"))
    d = tmp / "agenda"
    shutil.copytree(src, d, ignore=shutil.ignore_patterns(".picker", "selections.json", "submissions", "index.html"))
    spec = json.loads((d / "agenda.json").read_text())
    ag1, ag2 = spec["agendas"][0], spec["agendas"][-1]
    op1, op2 = ag1["options"][0], ag2["options"][-1]
    pre = {a["id"]: a["decided"] for a in spec["agendas"] if a.get("decided")}
    print(f"폴더: {d}")
    check_cli(d)

    # serve 는 서버를 독립 프로세스(새 세션)로 떼어 내고 바로 끝난다
    url, spid, took, r = serve(d)
    check(bool(url) and r.returncode == 0, f"serve 가 URL 을 찍고 끝난다 ({url}, {took:.1f}초)")
    check(alive(spid) and os.getpgid(spid) == spid and os.getsid(spid) == spid, "서버는 새 세션의 독립 프로세스다 (setsid)")
    check("wait" in r.stdout and "thuminal 세션" not in r.stdout, "thuminal 밖이면 보내기는 wait 가 받는다고 알린다")
    url2, spid2, _, r2 = serve(d)
    check(url2 == url and spid2 == spid and "이미 떠 있다" in r2.stdout, "다시 serve 하면 떠 있는 서버를 그대로 쓴다")
    waiter = subprocess.Popen([PY, str(PICKER), "wait", str(d)], stdout=subprocess.PIPE, text=True, env=BASE_ENV)
    od = vd = None

    errs = []
    grab = lambda page, tag="": errs.extend(f"{tag}{e}" for e in page.errors())   # 새로 읽기 전에 페이지 JS 오류를 모은다
    try:
        with Browser("agenda-picker selftest") as b:
            pg = b.new_page(viewport=(1360, 900))
            pg.goto(url)
            pg.wait_for_timeout(300)

            n = len(spec["agendas"])
            sel = d / "selections.json"
            check(pg.locator(".card").count() == n, f"바닥에 안건 카드 {n}개")
            check(pg.inner_text("#progress").startswith(f"결정 {len(pre)} / {n}"), f"진행 표시 {len(pre)} (대화에서 정한 안은 미리 골라져 있다)")
            if pre:
                aid, oid = next(iter(pre.items()))
                card = pg.locator(f'.card[data-ag="{aid}"]').inner_text()
                check("대화에서 정함" in card, "미리 고른 안건 카드에 '대화에서 정함'")
                ok = wait_for(lambda: sel.exists() and json.loads(sel.read_text())["picks"].get(aid) == oid)
                check(bool(ok), "미리 고른 안이 selections.json 에도 써진다")
            wait_for(lambda: "저장됨" in pg.inner_text("#save"), 4)
            check("저장됨" in pg.inner_text("#save"), "저장 상태 표시")
            if shots:
                pg.screenshot(path=str(shots / "1-base.png"), full_page=True)

            # 라이트 / 다크 전환: 페이지와 그림이 같이 바뀐다
            theme = lambda: pg.evaluate("document.documentElement.dataset.theme")
            check(theme() == "light", "처음 테마는 시스템 설정 (검사는 라이트로 고정)")
            pg.locator('.bar [data-set-theme="dark"]').click()
            pg.wait_for_timeout(100)
            check(theme() == "dark", "다크로 바꾸면 페이지가 다크로")
            grab(pg)
            pg.reload()
            pg.wait_for_timeout(300)
            check(theme() == "dark", "고른 테마는 새로고침해도 남는다")
            if shots:
                pg.screenshot(path=str(shots / "1b-base-dark.png"), full_page=True)
            pg.locator('.bar [data-set-theme="light"]').click()

            # 바닥 카드: 안마다 한 줄, 누르면 그 자리에서 고르고 다시 누르면 푼다. 줄 끝 링크는 그 안을 연 안건 보기로
            c0 = f'.card[data-ag="{ag1["id"]}"]'
            check(pg.locator(f"{c0} .hopt").count() == len(ag1["options"]), f"바닥 카드에 안 {len(ag1['options'])}줄")
            check(all(o["title"][:6] in pg.inner_text(c0) for o in ag1["options"]), "바닥 카드에 안 제목이 다 보인다")
            was = pre.get(ag1["id"])
            last = ag1["options"][-1]["id"]
            hp = f'{c0} [data-hpick="{last}"]'
            if was == last:
                pg.click(hp); pg.wait_for_timeout(80)
            pg.click(hp)
            ok = wait_for(lambda: sel.exists() and json.loads(sel.read_text())["picks"].get(ag1["id"]) == last)
            check(bool(ok) and pg.get_attribute(hp, "aria-pressed") == "true" and "picked" in pg.get_attribute(f"{c0} .hopt:has({hp.split(' ', 1)[1]})", "class"),
                  "바닥 카드에서 안 줄을 누르면 고르고 selections.json 에 써진다")
            check(pg.evaluate("document.activeElement && document.activeElement.dataset.hpick") == last, "고른 뒤에도 포커스가 그 줄에 남는다")
            pg.click(hp)
            ok = wait_for(lambda: last not in (json.loads(sel.read_text())["picks"].get(ag1["id"]) or ""))
            check(bool(ok), "다시 누르면 푼다")
            if was:
                pg.click(f'{c0} [data-hpick="{was}"]')
                wait_for(lambda: json.loads(sel.read_text())["picks"].get(ag1["id"]) == was)
            if len(ag1["options"]) > 1:
                pg.click(f'{c0} .hopt-view[data-view="1"]')
                pg.wait_for_timeout(250)
                check(pg.evaluate("document.getElementById('cmp').open") and pg.get_attribute("#cell-opt", "data-key") == ag1["options"][1]["id"],
                      "줄 끝 링크는 그 안을 연 안건 보기로")
                pg.keyboard.press("Escape")
                pg.wait_for_timeout(200)

            # 안건 보기: 카드를 누르면 팝업 없이 바로 반반 보기 (왼쪽 지금, 오른쪽 안)
            cmp_open = lambda: pg.evaluate("document.getElementById('cmp').open")
            viewing = lambda: pg.get_attribute("#cell-opt", "data-key")
            oidx = lambda ag, oid: [o["id"] for o in ag["options"]].index(oid)
            tab = lambda ag, oid: pg.click(f'#cmp-tabs .otab[data-opt="{oidx(ag, oid)}"]')
            box = lambda sel_: pg.evaluate(f"(e => e ? (r => [r.x, r.y, r.width, r.height])(e.getBoundingClientRect()) : null)(document.querySelector({json.dumps(sel_)}))")
            op1b = ag1["options"][1]
            pg.locator(".card .card-head").first.click()
            pg.wait_for_timeout(250)
            check(cmp_open() and pg.evaluate("document.getElementById('pop') === null"), "카드 제목을 누르면 바로 반반 보기 (팝업은 없다)")
            check(pg.evaluate("location.hash") == "#" + ag1["id"], "주소에 #안건id")
            check(pg.evaluate("getComputedStyle(document.documentElement).overflow") == "hidden", "보는 동안 배경 스크롤 잠김")
            check(pg.locator("#cmp-tabs .otab").count() == len(ag1["options"]), f"머리에 안 바꾸기 버튼 {len(ag1['options'])}개")
            first = pre.get(ag1["id"]) or next((o["id"] for o in ag1["options"] if o.get("recommended")), ag1["options"][0]["id"])
            check(viewing() == first, "처음에는 고른 안 → 권장안 → 첫 안 순으로 보인다")
            check(("no-left" not in pg.get_attribute("#cmp-stage", "class")) == bool(ag1.get("current")), "지금 상태가 있으면 왼쪽 칸")

            # 머리 한 줄 · 배경 줄과 바닥 줄 없음 · 그림 칸은 그림 높이에 맞는다 · 설명은 접지 않는다
            head = box(".cmp-head")
            check(head[3] <= 56, f"머리는 한 줄이다 ({head[3]:.0f}px)")
            check(all(box(x)[1] < head[1] + head[3] for x in ("#cmp-title", "#cmp-tabs", "#cmp-pos", "#cmp .seg", "#cmp .x")),
                  "머리 한 줄에 제목 · 안 버튼 · 안건 n/m · 테마 · × 가 있다")
            check(pg.locator("#cmp-ctx, .cmp-foot, #cmp-full").count() == 0, "배경 설명 줄 · 바닥 줄 · 전체 화면은 없다")
            # 보이는 그림 중 가장 세로로 긴 것은 칸을 꽉 채운다 (아래가 비지 않는다). 그림이 없으면 건너뛴다
            pg.wait_for_timeout(300)
            gaps = pg.evaluate("""[...document.querySelectorAll('#cmp-stage .pane-shot')].filter(p => p.offsetWidth).map(p => {
                const m = p.querySelector('.media'); return m ? p.clientHeight - m.getBoundingClientRect().height : null; }).filter(g => g !== null)""")
            if gaps:
                check(min(gaps) <= 3, f"그림 칸 높이가 그림에 맞는다 (남는 세로 {min(gaps):.0f}px)")
            check(pg.locator("#cmp-left .pane-label").count() == 0 or box("#cmp-left .pane-label")[1] + box("#cmp-left .pane-label")[3] <= box("#cmp-left .pane-shot, #cmp-left .noimg")[1] + 1,
                  "지금 · 안 표는 그림 위 머리 줄이라 그림을 가리지 않는다")
            rich_h = pg.evaluate("(e => e ? e.clientHeight : 0)(document.querySelector('#band-right .rich'))")
            clipped = pg.evaluate("(e => e ? e.scrollHeight - e.clientHeight : 0)(document.querySelector('#band-right .rich'))")
            check(rich_h > 0 and clipped <= 1, f"안 설명은 접지 않고 다 보인다 ({rich_h}px)")
            check(pg.locator("#cmp-pickbtn").is_visible() and pg.locator("#cmp-next").is_visible()
                  and box("#cmp-pickbtn")[0] > box("#band-right")[0], "[이 안으로] · [다음 안건] 은 안 칸 오른쪽")
            check(not pg.locator("#memo").is_visible(), "접혀 있으면 메모 칸은 숨어 있다")

            # 그림 짝: caption 이 모두 있으면 이름으로, 아니면 순서로. 짝이 없는 칸은 비우고 사유를 적는다
            for o in ag1["options"]:
                tab(ag1, o["id"])
                pg.wait_for_timeout(80)
                steps = steps_of(ag1, o)
                for i, (has_l, has_r) in enumerate(steps):
                    if i:
                        pg.keyboard.press("ArrowRight")
                        pg.wait_for_timeout(80)
                    where = f"[{o['id']} 그림 {i + 1}/{len(steps)}]"
                    if len(steps) > 1:
                        check(f"그림 {i + 1} / {len(steps)}" in pg.inner_text("#cmp-right .pane-label"), f"{where} 그림 번호")
                    if ag1.get("current"):
                        check(pg.locator("#cmp-left .noimg").count() == (0 if has_l else 1), f"{where} 왼쪽: {'지금 그림' if has_l else '짝 없음 안내'}")
                    check(pg.locator("#cmp-right .noimg").count() == (0 if has_r else 1), f"{where} 오른쪽: {'안 그림' if has_r else '짝 없음 안내'}")
                check(viewing() == o["id"], f"[{o['id']}] ← → 는 그림만 넘기고 안은 바꾸지 않는다")
                for _ in range(len(steps) - 1):
                    pg.keyboard.press("ArrowLeft")
                pg.wait_for_timeout(80)
            if len(op1b["id"]) == 1:
                tab(ag1, op1["id"])
                pg.keyboard.press(op1b["id"].lower())
                pg.wait_for_timeout(80)
                check(viewing() == op1b["id"], "A · B · C 키로 안을 바꾼다")
            tab(ag1, op1["id"])
            pg.wait_for_timeout(80)
            if pg.get_attribute("#cmp-pickbtn", "aria-pressed") != "true":
                pg.click("#cmp-pickbtn")
            pg.wait_for_timeout(100)
            check(pg.inner_text("#cmp-pickbtn") == "✓ 선택됨"
                  and "picked" in pg.get_attribute(f'#cmp-tabs .otab[data-opt="{oidx(ag1, op1["id"])}"]', "class")
                  and "picked" in pg.get_attribute("#cmp-right", "class") and "picked" in pg.get_attribute("#cell-opt", "class"),
                  "[이 안으로] 를 누르면 버튼 · 안 버튼 · 그림 칸 · 설명 칸에 반영")

            # 펼치기: 설명 전체 + 안건 배경 + 메모
            more = pg.locator("#cell-opt [data-more]")
            check("메모" in more.inner_text(), f"오른쪽 펼치기는 메모도 있다고 알린다 ({more.inner_text()})")
            more.click()
            pg.wait_for_timeout(150)
            check("open" in pg.get_attribute("#band", "class") and pg.locator("#memo").is_visible(), "[펼치기] 로 열면 메모 칸이 보인다")
            if ag1.get("context"):
                check("안건 배경" in pg.inner_text("#band-ctx"), "펼치면 안건 배경이 나온다")
            full_h = pg.evaluate("document.querySelector('#band-right .rich').clientHeight")
            check(full_h >= rich_h, f"펼치면 설명이 다 보인다 ({rich_h}px → {full_h}px)")
            pg.fill("#memo", "칩 글자도 조금 키워 줘\n두 번째 줄")
            ok = wait_for(lambda: sel.exists() and json.loads(sel.read_text())["picks"].get(ag1["id"]) == op1["id"]
                          and "두 번째 줄" in json.loads(sel.read_text())["memos"].get(ag1["id"], ""))
            check(bool(ok), "selections.json 에 선택 · 메모가 써진다")
            if shots:
                pg.screenshot(path=str(shots / "3b-band-open.png"))
            pg.locator("#cell-opt [data-more]").click()
            pg.wait_for_timeout(100)
            check("open" not in pg.get_attribute("#band", "class") and "메모 있음" in more.inner_text(), "접으면 '메모 있음' 으로 알린다")

            pg.locator("#cmp-stage").focus()
            pg.locator('#cmp [data-set-theme="dark"]').click()
            pg.wait_for_timeout(100)
            if pg.locator("#cmp-right img").count():
                check(theme() == "dark" and pg.get_attribute("#cmp-right img", "src") == pg.get_attribute("#cmp-right img", "data-d"),
                      "안건 보기에서도 테마 전환 · 그림 따라 바뀜")
            if shots:
                pg.screenshot(path=str(shots / "2-view-dark.png"))
            pg.locator('#cmp [data-set-theme="light"]').click()
            pg.wait_for_timeout(100)
            if shots:
                pg.screenshot(path=str(shots / "2-view.png"))

            # 그림을 누르면 양쪽 같은 자리를 같이 2배로. 휠 배율 · 끌어 옮기기도 같이. Esc · 다시 누르면 원래대로
            if pg.locator("#cmp-right .pane-shot img").count() and pg.locator("#cmp-left .pane-shot img").count():
                zs = lambda: pg.evaluate("[...document.querySelectorAll('.pane-shot img')].map(i => getComputedStyle(i).transform)")
                # 그림 위 한 점을 (그림 크기에 대한 비율로) 화면 좌표로: 양쪽에서 같은 비율 점이 칸 안 같은 자리에 와야 한다
                where = lambda side, u, v: pg.evaluate(f"""(() => {{ const im = document.querySelector('#cmp-{side} .pane-shot img');
                    const r = im.getBoundingClientRect(), p = im.closest('.pane').getBoundingClientRect();
                    return [r.left + r.width * {u} - p.left, r.top + r.height * {v} - p.top]; }})()""")
                scale = lambda: pg.evaluate("(m => m ? +m[1] : 1)(/matrix\\(([\\d.]+)/.exec(getComputedStyle(document.querySelector('#cmp-right .pane-shot img')).transform))")
                ib = box("#cmp-right .pane-shot img")
                cx, cy = ib[0] + ib[2] * 0.7, ib[1] + ib[3] * 0.4
                before = where("right", 0.7, 0.4)
                pg.mouse.click(cx, cy)
                pg.wait_for_timeout(150)
                t = zs()
                check(abs(scale() - 2) < 0.01 and len(set(t)) <= 2 and all(x != "none" for x in t), f"그림을 누르면 양쪽이 같이 2배 ({t})")
                after = where("right", 0.7, 0.4)
                check(abs(after[0] - before[0]) < 2 and abs(after[1] - before[1]) < 2, "누른 자리가 제자리에 있다 (그 자리를 키운다)")
                l, rr = where("left", 0.7, 0.4), where("right", 0.7, 0.4)
                check(abs(l[0] - rr[0]) < 3 and abs(l[1] - rr[1]) < 3, f"왼쪽도 같은 자리를 키운다 (왼 {l[0]:.0f},{l[1]:.0f} · 오 {rr[0]:.0f},{rr[1]:.0f})")
                check(pg.is_visible("#zoom-hint") and "2.0배" in pg.inner_text("#zoom-hint"), "확대 중 안내 (배율 · 휠 · 끌기 · Esc)")
                if shots:
                    pg.screenshot(path=str(shots / "3-zoom.png"))
                pg.mouse.move(cx, cy)
                pg.mouse.wheel(0, -300)
                pg.wait_for_timeout(150)
                s2 = scale()
                check(s2 > 2.1, f"휠을 올리면 더 커진다 ({s2:.2f}배)")
                l0, r0 = where("left", 0.5, 0.5), where("right", 0.5, 0.5)
                pg.mouse.move(cx, cy)
                pg.mouse.down()
                pg.mouse.move(cx + 40, cy + 30, steps=4)
                pg.mouse.move(cx + 80, cy + 60, steps=4)
                pg.mouse.up()
                pg.wait_for_timeout(150)
                l1, r1 = where("left", 0.5, 0.5), where("right", 0.5, 0.5)
                check(r1[0] - r0[0] > 20 and abs((l1[0] - l0[0]) - (r1[0] - r0[0])) < 3 and abs((l1[1] - l0[1]) - (r1[1] - r0[1])) < 3,
                      f"끌면 양쪽이 같이 옮겨진다 (오른쪽 {r1[0] - r0[0]:.0f},{r1[1] - r0[1]:.0f} · 왼쪽 {l1[0] - l0[0]:.0f},{l1[1] - l0[1]:.0f})")
                check(abs(scale() - s2) < 0.01, "끌기는 배율을 바꾸지 않는다 (누르기로 치지 않는다)")
                tab(ag1, op1b["id"])
                pg.wait_for_timeout(200)
                check(abs(scale() - s2) < 0.01, "확대 중에 안을 바꿔도 같은 자리를 계속 본다")
                tab(ag1, op1["id"])
                pg.wait_for_timeout(150)
                pg.keyboard.press("Escape")
                pg.wait_for_timeout(150)
                check(cmp_open() and set(zs()) == {"none"} and not pg.is_visible("#zoom-hint"), "Esc 는 확대만 풀고 안건 보기는 남는다")
                pg.mouse.click(cx, cy)
                pg.wait_for_timeout(100)
                pg.mouse.click(cx, cy)
                pg.wait_for_timeout(100)
                check(set(zs()) == {"none"}, "확대 중에 다시 누르면 원래대로")

            pg.keyboard.press("Enter")
            pg.wait_for_timeout(300)
            nxt = spec["agendas"][1] if n > 1 else None
            if nxt:
                check(cmp_open() and pg.evaluate("location.hash") == "#" + nxt["id"] and nxt["title"][:6] in pg.inner_text("#cmp-title"),
                      "Enter 는 지금 안을 고르고 다음 안건으로")
                check(not pg.locator("#memo").is_visible(), "다음 안건은 띠가 접힌 채로 열린다")
            ok = wait_for(lambda: json.loads(sel.read_text())["picks"].get(ag1["id"]) == op1["id"])
            check(bool(ok), "Enter 로 고른 안이 저장된다")
            for _ in range(n - 1):   # 남은 안건을 [다음 안건 →] 으로 훑는다
                cur = spec["agendas"][[a["id"] for a in spec["agendas"]].index(pg.evaluate("location.hash")[1:])]
                has_left = "no-left" not in pg.get_attribute("#cmp-stage", "class")
                check(has_left == bool(cur.get("current")), f"[{cur['id']}] 지금 상태가 있으면 반반, 없으면 안만 넓게")
                check(("no-left" not in pg.get_attribute("#band", "class")) == bool(cur.get("current")), f"[{cur['id']}] 설명 띠도 같이")
                if cur.get("decided"):
                    check(viewing() == cur["decided"] and "대화에서 정함" in pg.inner_text("#band-right")
                          and "대화에서 정한 안" in pg.evaluate("document.getElementById('band-ctx').textContent"),
                          f"[{cur['id']}] 대화에서 정한 안부터, '대화에서 정함' 표시")
                for o in cur["options"]:
                    if not o.get("shots"):
                        tab(cur, o["id"])
                        pg.wait_for_timeout(100)
                        check("그림이 없다" in pg.inner_text("#cmp-right .noimg"), f"[{cur['id']}] 그림 없는 안 {o['id']} 는 빈 칸 안내")
                if shots:
                    pg.screenshot(path=str(shots / f"4-view-{cur['id']}.png"))
                if cur is spec["agendas"][-1]:
                    break
                pg.click("#cmp-next")
                pg.wait_for_timeout(250)
            if n > 1:
                pg.click("#cmp-prev")
                pg.wait_for_timeout(200)
                check(pg.evaluate("location.hash") == "#" + spec["agendas"][-2]["id"], "머리의 ‹ 로 이전 안건")
            pg.keyboard.press("Escape")
            pg.wait_for_timeout(200)
            check(not cmp_open(), "Esc 로 목록으로")
            check(pg.evaluate("location.hash") == "", "닫으면 주소의 # 가 지워진다")
            check(op1["title"][:6] in pg.locator(".card").first.inner_text(), "바닥 카드에 고른 안이 보인다")

            # 새로고침해도 남는다
            grab(pg)
            pg.reload()
            pg.wait_for_timeout(300)
            first_card = pg.locator(".card").first.inner_text()
            check(op1["title"][:6] in first_card and "두 번째 줄" in first_card, "새로고침 뒤에도 선택 · 메모 유지")

            # 주소로 바로 열기 + 마지막 안건 고르기
            grab(pg)
            pg.goto(url + "#" + ag2["id"])
            pg.wait_for_timeout(300)
            check(cmp_open() and ag2["title"][:6] in pg.inner_text("#cmp-title"), "#안건id 로 열면 그 안건이 바로 열린다")
            tab(ag2, op2["id"])
            pg.wait_for_timeout(80)
            # 그림 데이터 (figure): 페이지가 줄 · 상자를 HTML 로 만들어 그린다 (Claude 는 데이터만 쓴다)
            fig_op = next((o for o in ag2["options"] if any(isinstance(x, dict) and x.get("figure") for x in o.get("shots") or [])), None)
            if fig_op:
                tab(ag2, fig_op["id"])
                fig = next(x["figure"] for x in fig_op["shots"] if isinstance(x, dict) and x.get("figure"))
                want = sum(len(ln.get("nodes") or []) for ln in fig.get("lanes") or [])
                ok = wait_for(lambda: pg.evaluate("(f => f && f.contentDocument ? f.contentDocument.querySelectorAll('.node').length : -1)(document.querySelector('#cmp-right .media.frame[data-fig] iframe'))") == want, 4)
                check(bool(ok), f"figure 데이터로 그래프를 그린다 (상자 {want}개)")
                tab(ag2, op2["id"])
                pg.wait_for_timeout(80)
            # HTML 개념 그림: iframe 으로 칸 너비에 바로 그린다 (글자 원래 크기), 칸 높이는 내용 높이, 테마를 문서에 넘긴다
            html_src = next((x if isinstance(x, str) else (x.get("src") or x.get("light") or "") for x in op2.get("shots") or []), "")
            if html_src.lower().endswith((".html", ".htm")):
                ok = wait_for(lambda: pg.evaluate("(f => !!(f && f.contentDocument && f.contentDocument.body && f.contentDocument.body.children.length))(document.querySelector('#cmp-right .media.frame iframe'))"), 4)
                check(bool(ok), "HTML 그림은 안건 보기 칸에 iframe 으로 그려진다")
                fr = pg.evaluate("""(() => { const f = document.querySelector('#cmp-right .media.frame iframe'), ps = f.closest('.pane-shot');
                    const doc = f.contentDocument; return { sandbox: f.getAttribute('sandbox'), w: f.clientWidth, psw: ps.clientWidth, tf: f.style.transform,
                    h: f.clientHeight, content: Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight), theme: doc.documentElement.dataset.theme }; })()""")
                check(fr["sandbox"] == "allow-same-origin", f"HTML 그림 iframe 은 스크립트를 막는다 (sandbox={fr['sandbox']!r})")
                check(abs(fr["w"] - fr["psw"]) <= 1 and not fr["tf"], f"HTML 그림은 칸 너비로 그려 글자가 원래 크기다 ({fr['w']} / {fr['psw']}px)")
                check(abs(fr["h"] - fr["content"]) <= 2, f"iframe 높이가 내용 높이에 맞는다 ({fr['h']} / {fr['content']}px)")
                check(fr["theme"] == "light", "그림 문서에 페이지 테마 (light) 를 단다")
                pg.locator('#cmp [data-set-theme="dark"]').click()
                pg.wait_for_timeout(150)
                check(pg.evaluate("document.querySelector('#cmp-right .media.frame iframe').contentDocument.documentElement.dataset.theme") == "dark",
                      "다크로 바꾸면 그림 문서도 다크")
                pg.locator('#cmp [data-set-theme="light"]').click()
                with urllib.request.urlopen(url + html_src, timeout=3) as r:
                    check(r.headers.get("Content-Security-Policy") == "sandbox allow-same-origin", "서버는 폴더 안 HTML 에 CSP sandbox 를 붙인다 (주소로 바로 열어도 스크립트가 돌지 않는다)")
                if shots:
                    pg.screenshot(path=str(shots / "4b-view-html.png"))
            if pg.get_attribute("#cmp-pickbtn", "aria-pressed") != "true":
                pg.click("#cmp-pickbtn")
            pg.click("#cmp-next")  # 마지막 안건이면 목록으로
            pg.wait_for_timeout(200)
            check(not cmp_open(), "마지막 안건의 [목록으로]")
            pg.fill("#note", "전체적으로 좋다")
            pg.wait_for_timeout(700)
            check(pg.inner_text("#progress") == f"결정 2 / {n}" if n == 2 else True, "진행 표시 갱신")
            if shots:
                pg.screenshot(path=str(shots / "5-base-picked.png"), full_page=True)

            # 보내기 → wait 가 찍고 끝난다 (thuminal 밖)
            pg.click("#send")
            try:
                out, _ = waiter.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                waiter.kill()
                out = ""
            check(waiter.returncode == 0, "wait 가 보내기를 받고 끝난다")
            check(f"선택: {op1['id']}. {op1['title']}" in out and f"선택: {op2['id']}. {op2['title']}" in out, "wait 출력에 두 선택")
            check("메모: 칩 글자도 조금 키워 줘" in out and "두 번째 줄" in out, "wait 출력에 메모 (여러 줄)")
            if ag2.get("decided") and ag2["decided"] != op2["id"]:
                check(f"대화에서 정한 {ag2['decided']} 에서 바꿈" in out, "wait 출력에 '대화에서 정한 안에서 바꿈'")
            check("전체 메모: 전체적으로 좋다" in out, "wait 출력에 전체 메모")
            sub1 = json.loads((d / "submissions" / "0001.json").read_text())
            check(sub1.get("via") == "wait" and "선택:" in sub1.get("message", ""), "submissions/0001.json 에 전달 경로 · 읽을 메시지")
            ok = wait_for(lambda: "전달됐다" in pg.inner_text("#send-info"), 6)
            check(bool(ok), "페이지에 'Claude 에 전달됐다'")
            print("\n--- wait 출력 ---\n" + out + "---")

            # 기다리는 wait 가 없을 때 보낸 것은 다음 wait 가 바로 받는다
            pg.click("#send")
            wait_for(lambda: (d / "submissions" / "0002.json").exists())
            late = subprocess.run([PY, str(PICKER), "wait", str(d)], capture_output=True, text=True, timeout=8, env=BASE_ENV)
            check("(#2," in late.stdout, "밀린 보내기를 다음 wait 가 바로 받는다")

            # 보안: 토큰 · Host
            tok = (d / ".picker" / "token").read_text().strip()
            check(http(url + "api/submit", "POST", {"Content-Type": "application/json"}, b"{}") == 403, "토큰 없으면 403")
            check(http(url + "api/meta", headers={"X-Picker-Token": tok, "Host": "evil.example:80"}) == 403, "다른 Host 면 403")
            check(http(url + ".picker/token") == 404, ".picker 는 내려주지 않는다")
            check(http(url + "api/meta", headers={"X-Picker-Token": tok}) == 200, "토큰 있으면 200")

            # 안건이 바뀌면 배너
            sp = json.loads((d / "agenda.json").read_text())
            sp["title"] += " (수정)"
            (d / "agenda.json").write_text(json.dumps(sp, ensure_ascii=False))
            ok = wait_for(lambda: pg.is_visible("#banner"), 5)
            check(bool(ok), "agenda.json 이 바뀌면 새로고침 배너")

            # 정적 사본 (서버 없이 연 index.html)
            ssrv, surl = static_server(d)
            pg2 = b.new_page(viewport=(1360, 900))
            pg2.goto(surl)
            pg2.wait_for_timeout(300)
            check(pg2.inner_text("#send") == "메시지 복사", "서버 없이 연 정적 사본은 보내기 대신 복사")
            check(op1["title"][:6] in pg2.locator(".card").first.inner_text(), "정적 사본에도 마지막 선택이 들어 있다")
            grab(pg2, "static: ")
            pg2.close()
            ssrv.shutdown()

            # 영상 그림 (ffmpeg 로 만든 시험 영상)
            vd = check_video(b, tmp / "video", shots)

            # ---- thuminal 안: 브라우저 탭을 이 세션 워크스페이스에 열고, 서버가 Claude 입력창에 한 줄을 넣는다 (가짜 thuminal 로)
            od = tmp / "thuminal"
            shutil.copytree(src, od, ignore=shutil.ignore_patterns(".picker", "selections.json", "submissions", "index.html"))
            fake, log, tstate = tmp / "fake-thuminal", tmp / "thuminal.log", tmp / "thuminal-state.json"
            fake.write_text(FAKE_THUMINAL)
            fake.chmod(0o755)
            log.write_text("")
            tm_set = lambda **kw: tstate.write_text(json.dumps(dict(json.loads(tstate.read_text()) if tstate.exists() else
                                                                    {"agent": "claude", "panes": {}, "next": 7, "restored": False}, **kw)))
            tm_set()
            tm_home = str(tmp / "tm-home")
            # THUMINAL_CLI 는 일부러 진짜처럼 없는 경로로 둔다. AGENDA_PICKER_THUMINAL 이 앞선다
            tenv = dict(BASE_ENV, THUMINAL_SESSION_ID="7", THUMINAL_HOME=tm_home, THUMINAL_CLI=str(tmp / "no-such-thuminal"),
                        AGENDA_PICKER_THUMINAL=str(fake))
            calls = lambda: [json.loads(x) for x in log.read_text().splitlines() if x.strip()]
            argv = lambda: [c["args"] for c in calls()]
            ourl, opid, _, r = serve(od, tenv)
            check(bool(ourl) and "thuminal 세션 입력창 (s7)" in r.stdout, "thuminal 안이면 보내기를 이 세션 입력창에 넣는다고 알린다" + ("" if "(s7)" in r.stdout else f" {r.stdout[-160:]}"))
            tgt = json.loads((od / ".picker" / "target.json").read_text())
            check(tgt.get("session") == "7" and tgt.get("home") == tm_home and tgt.get("cli") == str(fake) and tgt.get("createdAt") == 1000,
                  f"target.json 에 세션 · 데이터 폴더 · CLI · 세션 만든 때 ({tgt})")
            ro = subprocess.run([PY, str(PICKER), "open", str(od)], capture_output=True, text=True, timeout=20, env=tenv)
            opens = [a for a in argv() if a[:2] == ["browser", "open"]]
            tabf = od / ".picker" / "tab.json"
            tinfo = json.loads(tabf.read_text()) if tabf.exists() else {}
            check(ro.returncode == 0 and len(opens) == 1 and opens[0][2] == ourl and "--json" in opens[0] and "--in" not in opens[0],
                  f"open 은 browser open <url> --json 으로 이 셸의 워크스페이스에 탭을 연다 ({ro.stdout.strip()} {ro.stderr.strip()})")
            check(tinfo.get("pane") == "p7" and tinfo.get("workspace") == "/fake/wt" and tinfo.get("url") == ourl,
                  f"tab.json 에 새 칸 번호 · 워크스페이스 ({tinfo})")
            ro = subprocess.run([PY, str(PICKER), "open", str(od)], capture_output=True, text=True, timeout=20, env=tenv)
            check(len([a for a in argv() if a[:2] == ["browser", "open"]]) == 1 and ["pane", "focus", "p7"] in argv()
                  and "이미 열려 있어" in ro.stdout, "다시 open 하면 그 칸이 있으니 새로 열지 않고 pane focus 만 한다")
            pg3 = b.new_page(viewport=(1360, 900))
            pg3.goto(ourl)
            pg3.wait_for_timeout(400)
            check("받을 준비가 안 돼" not in pg3.inner_text("#send-info"), "wait 없이도 받을 준비가 돼 있다 (thuminal 세션)")
            tm_set(delay=2)
            n0 = len(calls())
            pg3.evaluate("document.getElementById('send').click()")   # 응답을 기다리지 않고 누른다
            ok = wait_for(lambda: "넣는 중" in pg3.inner_text("#send-info"), 3)
            check(bool(ok) and "전달됐다" not in pg3.inner_text("#send-info"), "넣는 동안은 '넣는 중' (먼저 '전달됐다' 로 보이지 않는다)")
            ok = wait_for(lambda: any(a[:2] == ["term", "send"] for a in argv()), 6)
            tm_set(delay=0)
            cs = calls()[n0:]
            ls_i = next((i for i, c in enumerate(cs) if c["args"][:2] == ["term", "ls"]), -1)
            send_i = next((i for i, c in enumerate(cs) if c["args"][:2] == ["term", "send"]), -1)
            check(bool(ok) and 0 <= ls_i < send_i, "넣기 전에 term ls 로 그 세션에 에이전트가 있는지 보고 term send")
            sc = cs[send_i] if send_i >= 0 else {"args": [], "home": "", "session": ""}
            text = sc["args"][-1] if sc["args"] else ""
            check(sc["args"][:4] == ["term", "send", "--enter", "7"] and sc["home"] == tm_home and sc["session"] == "7",
                  f"serve 를 부른 세션(s7) 에 그 데몬(THUMINAL_HOME) 으로 --enter 를 붙여 넣는다 ({sc})")
            check("\n" not in text and "\r" not in text and str(od / "submissions" / "0001.json") in text and "결정" in text,
                  f"넣는 글은 한 줄 (요약 + submissions 경로): {text}")
            check("칩 글자" not in text, "사용자가 쓴 메모는 입력창에 넣지 않는다 (파일에서 읽는다)")
            ok = wait_for(lambda: ["pane", "close", "p7"] in argv(), 5)
            check(bool(ok) and not tabf.exists(), "넣은 뒤 그 브라우저 칸을 pane close 로 닫고 tab.json 을 지운다")
            ok = wait_for(lambda: "입력창에 넣었다" in pg3.inner_text("#send-info"), 6)
            check(bool(ok), "페이지에 'Claude 입력창에 넣었다'")
            osub = json.loads((od / "submissions" / "0001.json").read_text())
            check(osub.get("via") == "thuminal" and "이 세션에 다시 들어온다" in osub.get("message", ""), "submission 메시지는 thuminal 전달에 맞는 안내")
            late = subprocess.run([PY, str(PICKER), "wait", str(od), "--timeout", "1.5"], capture_output=True, text=True, timeout=8, env=BASE_ENV)
            check(late.returncode == 3, "thuminal 로 넣은 것은 뒤에 띄운 wait 가 다시 받지 않는다")

            # 그 세션이 셸로 돌아갔으면(agent 없음) 넣지 않고 페이지에 알린다. 칸은 닫지 않는다
            tm_set(agent="")
            subprocess.run([PY, str(PICKER), "open", str(od)], capture_output=True, text=True, timeout=20, env=tenv)
            check(json.loads(tabf.read_text()).get("pane") == "p8" if tabf.exists() else False, "칸을 닫은 뒤 다시 open 하면 새 칸을 연다")
            n_send = sum(1 for a in argv() if a[:2] == ["term", "send"])
            pg3.click("#send")
            ok = wait_for(lambda: "넣지 못했다" in pg3.inner_text("#send-info"), 6)
            check(bool(ok), "셸이면 페이지에 '넣지 못했다'")
            check(sum(1 for a in argv() if a[:2] == ["term", "send"]) == n_send, "셸이면 term send 를 하지 않는다")
            pg3.wait_for_timeout(1800)
            check(["pane", "close", "p8"] not in argv() and tabf.exists(), "못 넣었으면 칸을 닫지 않는다")
            if shots:
                pg3.locator("#send-info").scroll_into_view_if_needed()
                pg3.screenshot(path=str(shots / "6-thuminal-not-claude.png"))
            late = subprocess.run([PY, str(PICKER), "wait", str(od), "--timeout", "3"], capture_output=True, text=True, timeout=8, env=BASE_ENV)
            check("(#2," in late.stdout, "못 넣은 것은 뒤에 띄운 wait 가 받을 수 있다")

            # 데몬이 다시 떠 세션 번호가 바뀌었으면 옛 번호를 restored_from 에 든 세션에 넣는다
            tm_set(agent="claude", restored=True)
            pg3.click("#send")
            ok = wait_for(lambda: any(a[:4] == ["term", "send", "--enter", "12"] for a in argv()), 6)
            check(bool(ok) and not any(a[:4] == ["term", "send", "--enter", "7"] for a in argv()[-3:]),
                  "데몬이 다시 떠 번호가 바뀌면 restored_from 으로 찾은 새 세션(s12)에 넣는다")
            grab(pg3, "thuminal: ")
            pg3.close()
            grab(pg)

            # ---- Claude 세션 인박스 소켓: 타이핑 없이 보낸 내용 전체를 바로 넣는다 (가짜 소켓 서버로, POSIX)
            if hasattr(__import__("socket"), "AF_UNIX") and sys.platform != "win32":
                import socket as _so
                ibd = tmp / "inbox"
                shutil.copytree(src, ibd, ignore=shutil.ignore_patterns(".picker", "selections.json", "submissions", "index.html"))
                sock_path = Path(tempfile.mkdtemp(prefix="cc-sock-")) / "1.sock"
                got_lines: list = []
                srv = _so.socket(_so.AF_UNIX, _so.SOCK_STREAM)
                srv.bind(str(sock_path))
                srv.listen(5)

                def accept_loop():
                    while True:
                        try:
                            c, _ = srv.accept()
                        except OSError:
                            return
                        buf = b""
                        while True:
                            chunk = c.recv(65536)
                            if not chunk:
                                break
                            buf += chunk
                        got_lines.extend(json.loads(x) for x in buf.decode().splitlines() if x.strip())
                        c.close()
                threading.Thread(target=accept_loop, daemon=True).start()
                log.write_text("")
                tm_set(agent="claude", restored=False)
                ienv = dict(tenv, CLAUDE_CODE_MESSAGING_SOCKET=str(sock_path), CLAUDE_CODE_MESSAGING_TOKEN="tok-selftest",
                            CLAUDE_CODE_SESSION_ID="sess-selftest")
                iurl2, _, _, r = serve(ibd, ienv)
                check(bool(iurl2) and "인박스" in r.stdout, f"인박스 소켓이 있으면 그리로 보낸다고 알린다 {r.stdout[-200:] if '인박스' not in r.stdout else ''}")
                ibf = ibd / ".picker" / "inbox.json"
                check(ibf.is_file() and (ibf.stat().st_mode & 0o777) == 0o600, "인박스 토큰은 0600 파일에 적는다")
                pg4 = b.new_page(viewport=(1360, 900))
                pg4.goto(iurl2)
                pg4.wait_for_timeout(400)
                pg4.evaluate("document.querySelector('#note') && (document.querySelector('#note').value = '인박스 메모 글')")
                pg4.evaluate("document.getElementById('send').click()")
                ok = wait_for(lambda: len(got_lines) >= 2, 5)
                check(bool(ok) and got_lines[0] == {"type": "auth", "token": "tok-selftest"} and got_lines[1].get("type") == "user",
                      f"소켓에 auth(토큰) + user 메시지 두 줄 {json.dumps(got_lines, ensure_ascii=False)[:200]}")
                content = (got_lines[1].get("message") or {}).get("content", "") if len(got_lines) > 1 else ""
                check(content.startswith("[agenda-picker] 사용자가 안건 선택을 보냈다") and "\n" in content and "결정" in content,
                      "보낸 내용 전체가 여러 줄 그대로 들어간다")
                check(not any(a[:2] == ["term", "send"] for a in argv()), "인박스로 넣었으면 thuminal 입력창에 타이핑하지 않는다")
                ok = wait_for(lambda: "세션에 바로 넣었다" in pg4.inner_text("#send-info"), 6)
                check(bool(ok), "페이지에 'Claude 세션에 바로 넣었다'")
                dl = json.loads((ibd / ".picker" / "delivery.json").read_text())
                check(dl.get("via") == "inbox" and dl.get("ok") and dl.get("tookSec", 9) < 2, f"인박스 전달은 빠르다 ({dl.get('tookSec')}초)")
                # 세션이 끝나 소켓이 사라지면 thuminal 세션 입력창으로 넘어간다
                srv.close()
                sock_path.unlink()
                pg4.click("#send")
                ok = wait_for(lambda: any(a[:2] == ["term", "send"] for a in argv()), 8)
                check(bool(ok), "소켓이 없으면 thuminal 세션 입력창으로 넘어간다")
                pg4.close()
                subprocess.run([PY, str(PICKER), "stop", str(ibd)], capture_output=True, env=BASE_ENV)

            check(not errs, f"페이지 JS 오류 없음 {errs}")
    finally:
        subprocess.run([PY, str(PICKER), "stop", str(d)], capture_output=True, env=BASE_ENV)
        for x in (od, vd):
            if x:
                subprocess.run([PY, str(PICKER), "stop", str(x)], capture_output=True, env=BASE_ENV)
        if waiter.poll() is None:
            waiter.kill()
    check(wait_for(lambda: not alive(spid), 3), "stop 으로 서버가 끝난다")

    # 요청 없이 idle 초가 지나면 서버가 스스로 끝난다 (기본 12시간, 여기서는 2초)
    idle_d = tmp / "idle"
    shutil.copytree(src, idle_d, ignore=shutil.ignore_patterns(".picker", "selections.json", "submissions", "index.html"))
    iurl, ipid, _, _ = serve(idle_d, None, "--idle", "2")
    check(bool(iurl) and alive(ipid), "idle 서버가 뜬다")
    check(wait_for(lambda: not alive(ipid), 8, 0.2), "요청 없이 idle 초가 지나면 서버가 스스로 끝난다")
    check(not (idle_d / ".picker" / "server.json").exists(), "끝나면 server.json 을 지운다")

    print(f"\n{'통과' if not fails else '실패 %d개' % len(fails)}  (임시 폴더 {tmp})")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
