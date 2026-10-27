#!/usr/bin/env python3
"""agenda-picker: 안건 선택 페이지를 만들고, 띄우고, 사용자가 보낸 선택을 받는다.

    picker.py check  <dir>            agenda.json 검사 (exit 1 = 오류)
    picker.py build  <dir>            index.html 정적 파일 생성 (file:// 로 열 때용, 보내기 대신 복사)
    picker.py serve  <dir> [--open]   로컬 서버를 독립 프로세스로 띄우고 URL 을 찍은 뒤 바로 끝난다 (요청 없이 12시간이면 서버도 끝난다)
    picker.py open   <dir>            페이지를 연다. thuminal 안이면 이 세션 워크스페이스의 브라우저 탭 (보내면 그 칸을 닫는다), 밖이면 open -g
    picker.py wait   <dir>            사용자가 보낼 때까지 기다렸다가 선택 내용을 찍고 끝난다 (인박스 소켓이 없는 thuminal 밖에서 run_in_background 로)
    picker.py status <dir>
    picker.py stop   <dir>

폴더 안 파일:
    agenda.json            Claude 가 쓰는 안건 정의
    selections.json        페이지가 쓰는 현재 선택 (고를 때마다 갱신)
    submissions/0001.json  [Claude 로 보내기] 한 번에 하나
    index.html             정적 사본 (서버가 선택이 바뀔 때마다 다시 쓴다)
    .picker/               token, server.json, server.log, waiter.pid, consumed, tab.json (thuminal 브라우저 칸),
                           target.json (보내기를 넣을 thuminal 세션), inbox.json (Claude 세션 인박스 소켓 · 토큰, 0600),
                           delivery.json (마지막 전달 결과)

[Claude 로 보내기] 전달 경로:
    인박스      serve · open 을 부른 Claude 세션의 인박스 소켓($CLAUDE_CODE_MESSAGING_SOCKET)에 보낸 내용 전체를 넣는다.
    thuminal 안 소켓이 없으면 serve · open 을 부른 thuminal 세션($THUMINAL_SESSION_ID) 입력창에 서버가 한 줄을 넣는다
                (thuminal term send --enter). 넣기 전에 그 세션에 아직 에이전트가 떠 있는지 term ls 의 agent 로 본다
                (비었으면 셸이라 넣지 않는다).
    그 밖       백그라운드 wait 가 끝나며 세션을 깨운다. wait 가 떠 있으면 thuminal 안에서도 wait 가 받는다.

thuminal 명령은 샌드박스 안에서도 데몬 소켓에 닿아 serve · open · stop 을 샌드박스 안에서 돌려도 된다 (2026-10-27 확인).
포트 · 소켓 · 폴더 쓰기가 막히면 샌드박스 밖에서 다시 돌린다.

python3 3.9 표준 라이브러리만 쓴다.
"""
from __future__ import annotations

import argparse
import binascii
import functools
import hashlib
import html
import json
import os
import re
import secrets
import shlex
import signal
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

SELF = Path(__file__).resolve()
TEMPLATE = SELF.parent / "template.html"

SPEC_F = "agenda.json"
STATE_F = "selections.json"
SUBS_D = "submissions"
PRIV_D = ".picker"

ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
SHOT_KEYS = ("src", "light", "dark")
# 라이트 · 다크를 따로 넣은 옛 방식 그림을 알아본다 (캡션이나 파일 이름으로).
THEME_CAPTIONS = {"라이트", "다크", "light", "dark", "라이트 모드", "다크 모드"}
THEME_FILE_RE = re.compile(r"[-_.](light|dark)\.\w+$", re.I)
# 이 확장자면 페이지가 <img> 대신 <video> (소리 없이 반복 재생) 로 그린다. template.html 의 isVideo 와 맞춘다.
VIDEO_RE = re.compile(r"\.(mp4|webm|mov|m4v)$", re.I)
# 이 확장자면 페이지가 스크린샷 대신 iframe 으로 바로 그린다 (개념 그림). template.html 의 isFrame 과 맞춘다.
FRAME_RE = re.compile(r"\.html?$", re.I)
# 그림 데이터 (figure) 를 그릴 때 쓰는 공통 스타일. 페이지가 figure 를 HTML 로 만들 때 넣고, 그림 HTML 파일도 링크해 쓴다.
FIG_CSS = SELF.parent.parent / "references" / "diagram" / "base.css"
FIG_KINDS = {"", "new", "warn", "muted"}
SIZE_RE = re.compile(r"^\d{2,5}x\d{2,5}$")
RANGE_RE = re.compile(r"bytes=(\d*)-(\d*)")
SUB_RE = re.compile(r"^(\d{4,})\.json$")
MAX_BODY = 2 * 1024 * 1024
POLL_SEC = 0.5
TAB_CLOSE_DELAY = 1.5
IDLE_SEC = 12 * 3600   # 요청 없이 이만큼 지나면 서버가 스스로 끝난다
LINE_MAX = 600


# ---------------------------------------------------------------- 공통

def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def show_time(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return str(iso)


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_json(path: Path, obj) -> None:
    atomic_write(path, json.dumps(obj, ensure_ascii=False, indent=2) + "\n")


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def pid_alive(pid) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def priv(d: Path) -> Path:
    p = d / PRIV_D
    p.mkdir(exist_ok=True)
    return p


def token_of(d: Path) -> str:
    f = priv(d) / "token"
    if f.exists():
        return f.read_text().strip()
    t = secrets.token_urlsafe(24)
    f.write_text(t)
    f.chmod(0o600)
    return t


def dir_key(d: Path) -> str:
    return hashlib.sha1(str(d).encode()).hexdigest()[:12]


def preferred_port(d: Path) -> int:
    # 폴더마다 같은 포트를 쓰려고 한다. 서버를 다시 띄워도 열려 있던 탭이 새로고침만으로 이어진다.
    return 47100 + binascii.crc32(str(d).encode()) % 1800


def spec_version(d: Path) -> str:
    try:
        return hashlib.sha1((d / SPEC_F).read_bytes()).hexdigest()[:12]
    except FileNotFoundError:
        return ""


def latest_seq(d: Path) -> int:
    best = 0
    try:
        for name in os.listdir(d / SUBS_D):
            m = SUB_RE.match(name)
            if m:
                best = max(best, int(m.group(1)))
    except FileNotFoundError:
        pass
    return best


def read_consumed(d: Path) -> int:
    try:
        return int((d / PRIV_D / "consumed").read_text().strip() or 0)
    except (FileNotFoundError, ValueError):
        return 0


def read_pid(path: Path) -> int:
    try:
        return int(path.read_text().strip())
    except (FileNotFoundError, ValueError):
        return 0


def watch_parent(on_orphan) -> None:
    """부모(Claude 세션의 셸)가 사라지면 따라 끝낸다. 세션이 끝난 뒤 서버 · 대기가 남지 않게."""
    ppid = os.getppid()
    if ppid == 1:
        return

    def loop():
        while True:
            time.sleep(2)
            if os.getppid() != ppid:
                on_orphan()
                return

    threading.Thread(target=loop, daemon=True).start()


# ---------------------------------------------------------------- 안건 정의

def norm_shots(raw) -> list:
    """그림 한 항목: "shots/A.png" · {"src", "caption"} · {"light", "dark", "caption"} (페이지 테마에 맞는 쪽만 보인다)."""
    out = []
    for s in raw if isinstance(raw, list) else []:
        if isinstance(s, str):
            s = {"src": s}
        if isinstance(s, dict):
            item = {k: str(s.get(k) or "") for k in (*SHOT_KEYS, "caption", "size")}
            item["figure"] = s.get("figure")
            out.append(item)
    return out


def decided_of(ag: dict) -> str:
    dv = ag.get("decided")
    ok = isinstance(dv, str) and any(isinstance(o, dict) and o.get("id") == dv for o in ag.get("options") or [])
    return dv if ok else ""


def load_spec(d: Path):
    """(spec, errors, warnings). spec 을 못 읽으면 None."""
    path = d / SPEC_F
    if not path.exists():
        return None, [f"{path} 가 없다"], []
    try:
        spec = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return None, [f"{SPEC_F} JSON 오류: {e}"], []
    errs, warns = validate(spec, d)
    return spec, errs, warns


def figure_errors(fig) -> list:
    """figure: {"title", "lanes": [{"who", "nodes": ["글|작은 글", {"t", "s", "k"}]}], "html", "css", "note"}. lanes 나 html 중 하나는 있어야 한다."""
    if not isinstance(fig, dict):
        return ["figure 가 객체가 아니다"]
    errs = []
    lanes, frag = fig.get("lanes"), fig.get("html")
    if lanes is None and not frag:
        errs.append("figure 에 lanes (그래프) 나 html (자유 그림) 이 없다")
    for k in ("title", "note", "html", "css"):
        if fig.get(k) is not None and not isinstance(fig.get(k), str):
            errs.append(f"figure.{k} 는 문자열이어야 한다")
    if lanes is not None:
        if not isinstance(lanes, list) or not lanes:
            return errs + ["figure.lanes 는 비지 않은 배열이어야 한다"]
        for i, ln in enumerate(lanes, 1):
            nodes = ln.get("nodes") if isinstance(ln, dict) else None
            if not isinstance(nodes, list) or not nodes:
                errs.append(f"figure.lanes[{i}].nodes 가 비었다")
                continue
            for j, n in enumerate(nodes, 1):
                if isinstance(n, str):
                    continue
                if not isinstance(n, dict) or not str(n.get("t") or "").strip():
                    errs.append(f"figure.lanes[{i}].nodes[{j}] 는 \"글|작은 글\" 이나 {{\"t\": …}} 여야 한다")
                elif str(n.get("k") or "") not in FIG_KINDS:
                    errs.append(f"figure.lanes[{i}].nodes[{j}].k 는 new · warn · muted 중 하나다: {n.get('k')!r}")
    return errs


def validate(spec, d: Path):
    errs, warns = [], []
    if not isinstance(spec, dict):
        return ["최상위가 객체가 아니다"], warns
    if not str(spec.get("title", "")).strip():
        errs.append("title 이 비었다")
    ags = spec.get("agendas")
    if not isinstance(ags, list) or not ags:
        errs.append("agendas 가 비었다")
        return errs, warns

    html_fields = [("lead", spec.get("lead"))]
    text_fields = [("title", spec.get("title"))]
    seen = set()
    for i, ag in enumerate(ags, 1):
        where = f"agendas[{i}]"
        if not isinstance(ag, dict):
            errs.append(f"{where} 가 객체가 아니다")
            continue
        aid = ag.get("id")
        if not isinstance(aid, str) or not ID_RE.match(aid):
            errs.append(f"{where}.id 가 없거나 형식이 틀렸다 (영문 · 숫자로 시작, 영문 · 숫자 · - _ . 만): {aid!r}")
        elif aid in seen:
            errs.append(f"{where}.id 가 겹친다: {aid}")
        else:
            seen.add(aid)
            where = f"안건 {aid}"
        if not str(ag.get("title", "")).strip():
            errs.append(f"{where}: title 이 비었다")
        text_fields.append((f"{where}.title", ag.get("title")))
        html_fields += [(f"{where}.summary", ag.get("summary")), (f"{where}.context", ag.get("context"))]

        blocks = []
        cur = ag.get("current")
        if cur is not None:
            if isinstance(cur, dict):
                blocks.append((f"{where}.current", cur))
            else:
                errs.append(f"{where}: current 가 객체가 아니다")

        opts = ag.get("options")
        if not isinstance(opts, list) or not opts:
            errs.append(f"{where}: options 가 비었다")
            opts = []
        elif len(opts) < 2:
            warns.append(f"{where}: 안이 1개뿐이다")
        oseen, recs = set(), 0
        for j, op in enumerate(opts, 1):
            ow = f"{where}.options[{j}]"
            if not isinstance(op, dict):
                errs.append(f"{ow} 가 객체가 아니다")
                continue
            oid = op.get("id")
            if not isinstance(oid, str) or not ID_RE.match(oid):
                errs.append(f"{ow}.id 가 없거나 형식이 틀렸다: {oid!r}")
            elif oid in oseen:
                errs.append(f"{ow}.id 가 겹친다: {oid}")
            else:
                oseen.add(oid)
                ow = f"{where} 안 {oid}"
            if not str(op.get("title", "")).strip():
                errs.append(f"{ow}: title 이 비었다")
            if op.get("recommended"):
                recs += 1
            blocks.append((ow, op))
        if recs > 1:
            warns.append(f"{where}: 권장안이 {recs}개다 (보통 하나)")
        dv = ag.get("decided")
        if dv is not None and (not isinstance(dv, str) or dv not in oseen):
            errs.append(f"{where}: decided 는 이 안건의 안 id 여야 한다 ({', '.join(sorted(oseen))}): {dv!r}")
        if ag.get("decidedNote") is not None and dv is None:
            warns.append(f"{where}: decidedNote 만 있고 decided 가 없다")
        text_fields.append((f"{where}.decidedNote", ag.get("decidedNote")))

        # 비교 보기는 지금 그림과 안 그림을 caption 이 모두 있으면 이름으로, 아니면 순서로 짝짓는다.
        cur_shots = norm_shots(cur.get("shots")) if isinstance(cur, dict) else []
        for bw, b in blocks:
            caps = [s["caption"].strip() for s in norm_shots(b.get("shots"))]
            dup = sorted({c for c in caps if c and caps.count(c) > 1})
            if dup:
                warns.append(f"{bw}: 같은 caption 이 겹친다 ({', '.join(dup)}). 짝을 이름으로 맞추므로 그림마다 다른 이름을 단다")
            if b is not cur:
                pair = caps + [s["caption"].strip() for s in cur_shots]
                if any(pair) and not all(pair):
                    warns.append(f"{bw}: 지금 · 이 안의 그림 중 일부에만 caption 이 있다. 모두 있어야 이름으로 짝을 맞추고, 아니면 순서로 맞춘다")
        for bw, b in blocks:
            text_fields.append((f"{bw}.title", b.get("title")))
            html_fields.append((f"{bw}.body", b.get("body")))
            if b.get("shots") is not None and not isinstance(b.get("shots"), list):
                errs.append(f"{bw}: shots 가 배열이 아니다")
            shots = norm_shots(b.get("shots"))
            for s in shots:
                paths = [s[k] for k in SHOT_KEYS if s[k]]
                if s["figure"] is not None:
                    if paths:
                        errs.append(f"{bw}: 그림 항목에 figure 와 src · light · dark 를 같이 썼다 (하나만)")
                    errs += [f"{bw}: {e}" for e in figure_errors(s["figure"])]
                    if isinstance(s["figure"], dict) and re.search(r"<script|\son[a-z]+\s*=", str(s["figure"].get("html") or ""), re.I):
                        warns.append(f"{bw}: figure.html 에 <script> 나 on* 속성이 있다. 그림의 스크립트는 막힌다 (CSS · SVG 로만 그린다)")
                elif not paths:
                    errs.append(f"{bw}: 그림 항목에 figure · src · light · dark 가 다 없다")
                for src in paths:
                    if re.match(r"^(https?:|data:)", src):
                        continue
                    parts = [p for p in src.split("/") if p]
                    if src.startswith("/") or ".." in parts or any(p.startswith(".") for p in parts):
                        errs.append(f"{bw}: 그림 경로는 폴더 안 상대 경로여야 한다: {src!r}")
                    elif not (d / src).is_file():
                        errs.append(f"{bw}: 스크린샷 파일이 없다: {src}")
                if s["light"] and s["dark"] and bool(VIDEO_RE.search(s["light"])) != bool(VIDEO_RE.search(s["dark"])):
                    errs.append(f"{bw}: light · dark 중 한쪽만 영상이다 (둘 다 그림이거나 둘 다 영상이어야 한다)")
                if s["light"] and s["dark"] and bool(FRAME_RE.search(s["light"])) != bool(FRAME_RE.search(s["dark"])):
                    errs.append(f"{bw}: light · dark 중 한쪽만 HTML 이다 (HTML 그림은 한 파일에서 data-theme 으로 다크를 그린다)")
                if s["size"] and not SIZE_RE.match(s["size"]):
                    errs.append(f"{bw}: size 는 \"1200x460\" 꼴이어야 한다: {s['size']!r}")
                for src in paths:
                    f = d / src
                    if FRAME_RE.search(src) and f.is_file():
                        txt = f.read_text(encoding="utf-8", errors="replace")
                        if re.search(r"<script|\son[a-z]+\s*=", txt, re.I):
                            warns.append(f"{bw}: HTML 그림 {src} 에 <script> 나 on* 속성이 있다. 페이지는 그림 HTML 의 스크립트를 막는다 (CSS · SVG 로만 그린다)")
                        if "prefers-color-scheme" in txt and "data-theme" not in txt:
                            warns.append(f"{bw}: HTML 그림 {src} 이 prefers-color-scheme 으로 다크를 그린다. 페이지의 [라이트 | 다크] 를 따르려면 :root[data-theme=\"dark\"] 로 쓴다")
            split = [s for s in shots if s["src"] and not s["light"] and not s["dark"]
                     and (s["caption"].strip().lower() in THEME_CAPTIONS or THEME_FILE_RE.search(s["src"]))]
            if len(split) >= 2:
                warns.append(f"{bw}: 라이트 · 다크 그림을 따로 넣었다. "
                             '{"light": "…", "dark": "…"} 한 항목으로 묶으면 페이지 테마에 맞는 쪽 하나만 보인다')

    for name, v in html_fields:
        if isinstance(v, str) and re.search(r"<script|\son[a-z]+\s*=", v, re.I):
            warns.append(f"{name}: <script> 나 on* 속성이 있다 (페이지가 그대로 실행한다)")
    dashed = [name for name, v in html_fields + text_fields if isinstance(v, str) and "—" in v]
    if dashed:
        warns.append("em dash(—) 가 있다. 한국어 문장은 쉼표 · 괄호 · 문장 끊기로 쓴다: " + ", ".join(dashed[:6])
                     + (" …" if len(dashed) > 6 else ""))
    return errs, warns


def clean_state(st) -> dict:
    st = st if isinstance(st, dict) else {}

    def str_map(m):
        return {k: v for k, v in (m.items() if isinstance(m, dict) else []) if isinstance(k, str) and isinstance(v, str)}

    return {
        "version": 1,
        "updatedAt": st.get("updatedAt") if isinstance(st.get("updatedAt"), str) else "",
        "picks": str_map(st.get("picks")),
        "memos": {k: v for k, v in str_map(st.get("memos")).items() if v.strip()},
        "note": st.get("note") if isinstance(st.get("note"), str) else "",
        "seeded": str_map(st.get("seeded")),   # 페이지가 미리 골라 둔 decided 값 (같은 값을 다시 덮지 않으려고)
    }


def seed_decided(spec: dict, st: dict) -> dict:
    """페이지와 같은 규칙으로 decided 를 미리 고른다 (페이지가 아직 저장하지 않았을 때 status 가 같은 결과를 보이게)."""
    for ag in spec["agendas"]:
        dv = decided_of(ag)
        if dv and st["seeded"].get(ag["id"]) != dv:
            st["picks"][ag["id"]] = dv
            st["seeded"][ag["id"]] = dv
    return st


# ---------------------------------------------------------------- 페이지

def js_json(obj) -> str:
    # <script type="application/json"> 안에 넣는다. </script> 로 끊기지 않게 < 를 모두 이스케이프.
    return json.dumps(obj, ensure_ascii=False).replace("<", "\\u003c")


def error_page(d: Path, errs) -> str:
    items = "".join(f"<li>{html.escape(e)}</li>" for e in errs)
    return f"""<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3">
<title>agenda.json 오류</title><style>body{{font-family:"Pretendard","Apple SD Gothic Neo",sans-serif;margin:40px;color:#1d1d1b}}
li{{margin:6px 0}}code{{font-family:ui-monospace,Menlo,monospace}}</style></head><body>
<h1>agenda.json 을 읽지 못했다</h1><p><code>{html.escape(str(d / SPEC_F))}</code></p><ul>{items}</ul>
<p>고치면 3초 안에 다시 읽는다.</p></body></html>"""


def render(d: Path, mode: str, token: str = "", port: int = 0) -> str:
    spec, errs, _ = load_spec(d)
    if errs:
        return error_page(d, errs)
    if not port:
        port = (read_json(d / PRIV_D / "server.json", {}) or {}).get("port") or preferred_port(d)
    cfg = {"mode": mode, "token": token, "dirKey": dir_key(d), "dir": str(d), "port": port,
           "specVersion": spec_version(d), "figCss": FIG_CSS.read_text(encoding="utf-8") if FIG_CSS.is_file() else ""}
    values = {
        "TITLE": html.escape(str(spec.get("title", ""))),
        "SPEC": js_json(spec),
        "STATE": js_json(clean_state(read_json(d / STATE_F, {}))),
        "CONFIG": js_json(cfg),
    }
    return re.sub(r"@@([A-Z]+)@@", lambda m: values.get(m.group(1), m.group(0)), TEMPLATE.read_text(encoding="utf-8"))


def build_static(d: Path) -> Path:
    out = d / "index.html"
    atomic_write(out, render(d, "static"))
    return out


# ---------------------------------------------------------------- 보내기

def resolve(spec: dict, st: dict) -> list:
    items = []
    for ag in spec["agendas"]:
        oid = st["picks"].get(ag["id"])
        op = next((o for o in ag["options"] if o.get("id") == oid), None)
        items.append({
            "id": ag["id"],
            "title": ag["title"],
            "pick": {"id": op["id"], "title": op["title"], "recommended": bool(op.get("recommended"))} if op else None,
            "decided": decided_of(ag) or None,
            "memo": st["memos"].get(ag["id"], "").strip(),
        })
    return items


def indent_block(label: str, text: str, pad: str = "   ") -> list:
    lines = text.strip().splitlines() or [""]
    out = [f"{pad}{label}{lines[0]}"]
    out += [f"{pad}{' ' * len(label)}{ln}" for ln in lines[1:]]
    return out


def pick_line(it: dict) -> str:
    p, dv = it["pick"], it.get("decided")
    notes = ["권장안"] if p and p["recommended"] else []
    if dv:
        notes.append("대화에서 정한 안 그대로" if p and p["id"] == dv
                     else f"대화에서 정한 {dv} 에서 바꿈" if p else f"대화에서 정한 {dv} 를 풀었다")
    tail = f" ({', '.join(notes)})" if notes else ""
    return f"   선택: {p['id']}. {p['title']}{tail}" if p else f"   선택: 미정{tail}"


def format_message(sub: dict, d: Path, superseded=()) -> str:
    items = sub["items"]
    lines = [f"[agenda-picker] 사용자가 안건 선택을 보냈다 (#{sub['seq']}, {show_time(sub['sentAt'])})",
             f"페이지: {sub['title']}",
             f"폴더: {d}"]
    if superseded:
        lines.append(f"(기다리지 않는 동안 먼저 온 {', '.join('#%d' % s for s in superseded)} 는 이 #{sub['seq']} 가 대신한다)")
    lines.append("")
    for i, it in enumerate(items, 1):
        lines.append(f"{i}. {it['title']}  [{it['id']}]")
        lines.append(pick_line(it))
        if it["memo"]:
            lines += indent_block("메모: ", it["memo"])
    if sub.get("note", "").strip():
        lines.append("")
        lines += indent_block("전체 메모: ", sub["note"], pad="")
    decided = sum(1 for it in items if it["pick"])
    qd = shlex.quote(str(d))
    lines += ["", f"결정 {decided}/{len(items)}",
              f"원본: {d / SUBS_D / ('%04d.json' % sub['seq'])}"]
    direct = sub.get("via") in ("thuminal", "inbox")
    if sub.get("tabClosed"):
        again = ("다시 보내면 이 세션에 다시 들어온다." if direct
                 else f"wait 를 백그라운드로 띄운다 (python3 {SELF} wait {qd}).")
        lines.append(f"페이지 탭은 닫았다. 다시 고치게 하려면 다시 연다 (python3 {SELF} open {qd}). {again}")
    elif direct:
        lines.append("페이지는 열려 있다. 다시 보내면 이 세션에 다시 들어온다.")
    else:
        lines.append(f"다음 보내기를 받으려면 다시 백그라운드로 띄운다: python3 {SELF} wait {qd}")
    return "\n".join(lines)


def one_line(sub: dict, d: Path) -> str:
    """thuminal 세션 입력창에 넣을 한 줄. 줄바꿈이 들어가면 중간에 제출될 수 있어 한 줄로만 만든다.

    사용자가 쓴 글(메모 · 제목)은 넣지 않는다. 안건 id · 안 id 는 ID_RE 로 걸러져 있고, 나머지는 파일에서 읽게 한다.
    """
    items = sub["items"]
    picks = ", ".join(f"{it['id']}={it['pick']['id'] if it['pick'] else '미정'}" for it in items)
    memos = sum(1 for it in items if it["memo"]) + (1 if sub.get("note", "").strip() else 0)
    path = d / SUBS_D / f"{sub['seq']:04d}.json"
    head = f"[agenda-picker] 사용자가 안건 선택을 보냈다 #{sub['seq']} · 결정 {sum(1 for it in items if it['pick'])}/{len(items)}"
    tail = (f" · 메모 {memos}건" if memos else "") + f" · 내용은 {path} 의 message 를 읽는다"
    line = f"{head} ({picks}){tail}"
    if len(line) > LINE_MAX:
        line = head + tail
    return re.sub(r"\s+", " ", line).strip()


# ---------------------------------------------------------------- 서버

class App:
    def __init__(self, d: Path, port: int):
        self.d = d
        self.port = port
        self.lock = threading.Lock()
        self.token = token_of(d)
        self.hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        self.origins = {f"http://{h}" for h in self.hosts}
        self.last_request = time.time()

    def state(self) -> dict:
        return clean_state(read_json(self.d / STATE_F, {}))

    def last_sent(self):
        seq = latest_seq(self.d)
        if not seq:
            return None
        sub = read_json(self.d / SUBS_D / f"{seq:04d}.json", {}) or {}
        return {"seq": seq, "sentAt": sub.get("sentAt", ""), "stateUpdatedAt": sub.get("stateUpdatedAt", "")}

    def receiver(self) -> dict:
        """보내기를 누가 받는가. Claude 세션 인박스 소켓 → wait → thuminal 세션 순. 셋 다 없으면 아무도 못 받는다."""
        if inbox_target(self.d):
            return {"via": "inbox", "ready": True}
        if pid_alive(read_pid(self.d / PRIV_D / "waiter.pid")):
            return {"via": "wait", "ready": True}
        if target_session(self.d):
            return {"via": "thuminal", "ready": True}
        return {"via": "wait", "ready": False}

    def meta(self) -> dict:
        r = self.receiver()
        return {
            "specVersion": spec_version(self.d),
            "stateUpdatedAt": self.state()["updatedAt"],
            "lastSent": self.last_sent(),
            "consumed": read_consumed(self.d),
            "waiter": r["ready"],
            "via": r["via"],
            "delivery": read_json(self.d / PRIV_D / "delivery.json", None),
        }

    def _save(self, st: dict) -> dict:
        cur = self.state()
        # 늦게 도착한 옛 저장 요청이 새 상태를 덮지 않게 한다.
        if cur["updatedAt"] and st["updatedAt"] and st["updatedAt"] < cur["updatedAt"]:
            return cur
        write_json(self.d / STATE_F, st)
        try:
            build_static(self.d)
        except Exception as e:  # 정적 사본은 부가 기능이라 저장을 막지 않는다
            print(f"index.html 갱신 실패: {e}", file=sys.stderr, flush=True)
        return st

    def save(self, st) -> dict:
        with self.lock:
            return self._save(clean_state(st))

    def submit(self, st) -> dict:
        spec, errs, _ = load_spec(self.d)
        if errs:
            raise ValueError("agenda.json 오류: " + "; ".join(errs))
        via = self.receiver()["via"]
        with self.lock:
            st = self._save(clean_state(st))
            seq = latest_seq(self.d) + 1
            sub = {
                "seq": seq,
                "sentAt": now_iso(),
                "title": spec["title"],
                "dir": str(self.d),
                "stateUpdatedAt": st["updatedAt"],
                "items": resolve(spec, st),
                "note": st["note"].strip(),
                "via": via,
                "tabClosed": bool(opened_tab(self.d)),
            }
            sub["message"] = format_message(sub, self.d)
            if via in ("inbox", "thuminal"):
                # 서버가 넣기 전에 wait 가 먼저 집어 가 두 번 들어가지 않게, 쓰기 전에 전달한 것으로 적어 둔다.
                atomic_write(priv(self.d) / "consumed", str(seq))
            write_json(self.d / SUBS_D / f"{seq:04d}.json", sub)
        delivery = None
        if via == "inbox":
            delivery = deliver_inbox(self.d, sub)
            if not delivery["ok"] and target_session(self.d) and not pid_alive(read_pid(self.d / PRIV_D / "waiter.pid")):
                via = "thuminal"      # 소켓이 죽었으면 (세션 재시작 등) thuminal 세션 입력창으로 넘어간다
        if via == "thuminal":
            delivery = deliver_thuminal(self.d, sub)
        if delivery is not None and not delivery["ok"]:
            with self.lock:
                # 못 넣었으면 다음에 띄우는 wait 가 받을 수 있게 되돌린다.
                if read_consumed(self.d) == seq:
                    atomic_write(priv(self.d) / "consumed", str(seq - 1))
        close = sub["tabClosed"] and (delivery is None or delivery["ok"])
        if close:
            # 응답이 페이지에 닿아 "보냈다" 를 보인 뒤에 닫는다. 못 넣었으면 사용자가 안내를 보게 탭을 남긴다.
            threading.Timer(TAB_CLOSE_DELAY, close_tab, args=(self.d,)).start()
        r = self.receiver()
        return {"lastSent": {"seq": seq, "sentAt": sub["sentAt"], "stateUpdatedAt": sub["stateUpdatedAt"]},
                "consumed": read_consumed(self.d),
                "waiter": r["ready"],
                "via": via,
                "delivery": delivery,
                "closeTab": close}


class Handler(SimpleHTTPRequestHandler):
    server_version = "agenda-picker/1"

    @property
    def app(self) -> App:
        return self.server.app  # type: ignore[attr-defined]

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        if getattr(self, "_frame_file", False):
            # 폴더 안 HTML (개념 그림 등) 은 스크립트를 막는다. 그림 HTML 이 같은 origin 에서 돌면 페이지를 읽어 보내기 토큰을
            # 얻을 수 있기 때문이다. allow-same-origin 은 남겨 페이지가 내용 높이를 재고 테마를 넘기게 한다.
            self.send_header("Content-Security-Policy", "sandbox allow-same-origin")
        super().end_headers()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _guard(self) -> bool:
        self.app.last_request = time.time()
        # Host 검사: DNS rebinding 으로 다른 사이트가 이 서버를 같은 출처처럼 읽는 것을 막는다.
        if self.headers.get("Host", "") not in self.app.hosts:
            self._json(403, {"error": "host", "message": "허용하지 않는 Host"})
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in self.app.origins:
            self._json(403, {"error": "origin", "message": "허용하지 않는 Origin"})
            return False
        return True

    def _api_guard(self) -> bool:
        # 토큰은 서버가 그린 페이지에만 들어 있다. 다른 탭의 웹페이지가 보내기를 흉내 내지 못하게 한다.
        if self.headers.get("X-Picker-Token") != self.app.token:
            self._json(403, {"error": "token", "message": "페이지가 오래됐다. 새로고침한다."})
            return False
        return True

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            raise ValueError("본문 크기가 맞지 않는다")
        return json.loads(self.rfile.read(n).decode("utf-8"))

    def do_GET(self):
        if not self._guard():
            return
        path = unquote(urlsplit(self.path).path)
        if path in ("/", "/index.html"):
            body = render(self.app.d, "server", self.app.token, self.app.port).encode()
            return self._send(200, body, "text/html; charset=utf-8")
        if path.startswith("/api/"):
            if not self._api_guard():
                return
            if path == "/api/meta":
                return self._json(200, self.app.meta())
            if path == "/api/state":
                return self._json(200, self.app.state())
            return self._json(404, {"error": "not found"})
        if any(seg.startswith(".") for seg in path.split("/") if seg):
            return self._json(404, {"error": "not found"})
        self._frame_file = bool(FRAME_RE.search(path))
        if self.headers.get("Range") and self._send_range():
            return None
        return super().do_GET()

    def _send_range(self) -> bool:
        """Range 요청이면 206 으로 그 구간만 보낸다. Safari 는 이것 없이는 영상을 틀지 않고, 영상 앞뒤 이동도 이것에 기댄다.
        한 구간 요청만 받는다. 아니면 False 를 돌려 파일 전체를 보내게 한다."""
        m = RANGE_RE.fullmatch(self.headers.get("Range", "").strip())
        f = Path(self.translate_path(self.path))
        if not m or m.groups() == ("", "") or not f.is_file():
            return False
        size = f.stat().st_size
        a, b = m.groups()
        start, end = (int(a), min(int(b), size - 1) if b else size - 1) if a else (max(size - int(b), 0), size - 1)
        if start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(str(f)))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        with f.open("rb") as fh:
            fh.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = fh.read(min(left, 1 << 16))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)
        return True

    def do_HEAD(self):
        self._json(405, {"error": "method"})

    def _write(self, fn):
        if not (self._guard() and self._api_guard()):
            return
        try:
            self._json(200, fn(self._body()))
        except (ValueError, json.JSONDecodeError) as e:
            self._json(400, {"error": "bad request", "message": str(e)})

    def do_PUT(self):
        if urlsplit(self.path).path == "/api/state":
            return self._write(lambda b: {"ok": True, "state": self.app.save(b)})
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if urlsplit(self.path).path == "/api/submit":
            return self._write(self.app.submit)
        self._json(404, {"error": "not found"})


def ping(d: Path, url: str) -> bool:
    req = urllib.request.Request(url.rstrip("/") + "/api/meta", headers={"X-Picker-Token": token_of(d)})
    try:
        with urllib.request.urlopen(req, timeout=1) as r:
            return r.status == 200
    except Exception:
        return False


def running_server(d: Path):
    info = read_json(d / PRIV_D / "server.json", None)
    if isinstance(info, dict) and pid_alive(info.get("pid")) and ping(d, info.get("url", "")):
        return info
    return None


def thuminal_cli() -> str:
    """이 셸이 thuminal 세션 안이면 thuminal 명령 전체 경로, 아니면 "".

    thuminal 은 세션 셸에 THUMINAL_CLI · THUMINAL_SESSION_ID · THUMINAL_HOME 을 넣는다. 검사(selftest)는
    AGENDA_PICKER_THUMINAL 로 가짜 thuminal 을 바꿔 끼운다.
    """
    cli = os.environ.get("AGENDA_PICKER_THUMINAL") or os.environ.get("THUMINAL_CLI") or ""
    if not os.environ.get("THUMINAL_SESSION_ID", "").strip().isdigit():
        return ""
    return cli if cli and os.path.isfile(cli) and os.access(cli, os.X_OK) else ""


def in_thuminal() -> bool:
    return bool(thuminal_cli())


def tm_run(t: dict, *args, timeout: float = 20) -> str:
    """t (cli · home · session) 가 가리키는 thuminal 명령을 돌리고 표준 출력을 돌려준다. 실패하면 RuntimeError.

    서버는 처음 serve 를 부른 셸의 환경을 물려받는다. 다른 세션 · 다른 데몬으로 바뀌었을 수 있어 적어 둔 값으로 환경을 다시 맞춘다.
    """
    env = dict(os.environ)
    for key, val in (("THUMINAL_HOME", t.get("home")), ("THUMINAL_SESSION_ID", t.get("session"))):
        if val:
            env[key] = val
        else:
            env.pop(key, None)
    r = subprocess.run([t["cli"], *args], capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, env=env)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip()[:300] or f"exit {r.returncode}")
    return r.stdout


def tm_json(t: dict, *args, timeout: float = 20):
    out = tm_run(t, *args, "--json", timeout=timeout)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise RuntimeError(f"thuminal 이 JSON 을 돌려주지 않았다: {out.strip()[:200]}")


def here_target() -> dict:
    """이 명령을 부른 Claude 가 도는 thuminal 세션. thuminal 밖이면 {}."""
    cli = thuminal_cli()
    if not cli:
        return {}
    t = {"cli": cli, "home": os.environ.get("THUMINAL_HOME", ""), "session": os.environ["THUMINAL_SESSION_ID"].strip()}
    try:
        # 데몬이 다시 뜨면 세션 번호를 1 부터 새로 매긴다. 같은 번호의 다른 세션에 넣지 않게 만든 때를 같이 적는다
        me = next((s for s in tm_json(t, "term", "ls", timeout=5) if str(s.get("id")) == t["session"]), None)
        if me:
            t["createdAt"] = me.get("created_at")
    except (RuntimeError, OSError, subprocess.TimeoutExpired, TypeError):
        pass
    return t


def remember_target(d: Path) -> None:
    """보내기를 넣을 곳을 적어 둔다. serve · open 을 부른 Claude 세션이다.

    서버는 처음 띄운 세션의 환경을 물려받으므로, 다른 세션이 같은 폴더로 serve · open 을 다시 부르면 그쪽으로 바꾼다.
    """
    f = priv(d) / "target.json"
    t = here_target()
    if t:
        write_json(f, dict(t, savedAt=now_iso()))
    else:
        f.unlink(missing_ok=True)
    # Claude Code 는 세션마다 인박스 소켓을 열고, 그 경로와 토큰을 Bash · 훅 환경에 넘긴다. 토큰이 있어 0600 으로 적는다
    ib = priv(d) / "inbox.json"
    sock, tok = os.environ.get("CLAUDE_CODE_MESSAGING_SOCKET", ""), os.environ.get("CLAUDE_CODE_MESSAGING_TOKEN", "")
    if sock and tok:
        write_json(ib, {"socket": sock, "token": tok, "sessionId": os.environ.get("CLAUDE_CODE_SESSION_ID", ""),
                        "savedAt": now_iso()})
        try:
            os.chmod(ib, 0o600)
        except OSError:
            pass
    else:
        ib.unlink(missing_ok=True)


def inbox_target(d: Path) -> dict:
    """적어 둔 인박스 소켓이 아직 있으면 그 정보 (세션이 끝나면 소켓 파일이 사라진다)."""
    info = read_json(d / PRIV_D / "inbox.json", None)
    if not isinstance(info, dict) or not info.get("socket") or not info.get("token"):
        return {}
    sock = info["socket"]
    if not sock.startswith("\\\\.\\pipe\\") and not os.path.exists(sock):
        return {}
    return info


# 쓰자마자 끝나는 도우미. 상주 프로세스가 소켓에 직접 쓰면 Claude Code 가 살아 있는 다른 프로세스로 보고 승인 대기에
# 걸 수 있어서, 연결 · 전송 후 바로 끝나 토큰으로 확인받게 한다 (다른 플러그인과 같은 방식).
INBOX_HELPER = r"""
import json, os, socket, sys
cfg = json.loads(sys.stdin.read())
lines = (json.dumps({"type": "auth", "token": cfg["token"]}) + "\n"
         + json.dumps({"type": "user", "message": {"role": "user", "content": cfg["text"]}}, ensure_ascii=False) + "\n").encode()
path = cfg["socket"]
if path.startswith("\\\\.\\pipe\\"):          # Windows named pipe
    with open(path, "wb", buffering=0) as f:
        f.write(lines)
else:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(path)
    s.sendall(lines)
    s.close()
"""


def deliver_inbox(d: Path, sub: dict) -> dict:
    """Claude 세션 인박스 소켓으로 보낸 내용 전체를 바로 넣는다 (0.1초 안팎, 2026-10-07 실측). 타이핑이 아니라 셸에 들어갈
    걱정이 없고, 세션이 쉬고 있으면 깨어나고 일하는 중이면 끼어 들어간다. Claude 쪽에는 다른 세션이 보낸 메시지로 보인다."""
    info = inbox_target(d)
    res = {"seq": sub["seq"], "via": "inbox", "ok": False, "message": ""}
    t0 = time.time()
    if not info:
        res["message"] = "Claude 세션 인박스 소켓이 없다 (세션이 끝났거나 다시 시작됐다)."
    else:
        try:
            r = subprocess.run([sys.executable, "-c", INBOX_HELPER], input=json.dumps(
                {"socket": info["socket"], "token": info["token"], "text": sub["message"]}, ensure_ascii=False),
                capture_output=True, text=True, encoding="utf-8", timeout=10)
            if r.returncode == 0:
                res.update(ok=True, message="Claude 세션에 바로 넣었다.")
            else:
                res["message"] = "Claude 세션에 넣지 못했다: " + (r.stderr.strip().splitlines() or ["?"])[-1][:200]
        except (OSError, subprocess.TimeoutExpired) as e:
            res["message"] = f"Claude 세션에 넣지 못했다: {e}"
    res.update(at=now_iso(), tookSec=round(time.time() - t0, 2))
    print(f"전달 #{sub['seq']} ({res['tookSec']}초, inbox): {res['message']}", flush=True)
    write_json(priv(d) / "delivery.json", res)
    return res


def target_session(d: Path) -> dict:
    info = read_json(d / PRIV_D / "target.json", None)
    return info if isinstance(info, dict) and info.get("cli") and info.get("session") else {}


def find_session(sessions, t: dict):
    """적어 둔 세션을 term ls 결과에서 찾는다. 데몬이 다시 떠 번호가 바뀌었으면 옛 번호를 restored_from 에 든 세션이다."""
    sid, born = str(t.get("session")), t.get("createdAt")
    me = next((s for s in sessions if isinstance(s, dict) and str(s.get("id")) == sid), None)
    if me and (not born or me.get("created_at") == born):
        return me
    return next((s for s in sessions if isinstance(s, dict) and str(s.get("restored_from")) == sid), None)


def deliver_thuminal(d: Path, sub: dict) -> dict:
    """serve · open 을 부른 thuminal 세션의 Claude 입력창에 한 줄을 넣고 Enter. 그 세션에 이제 에이전트가 없으면
    (Claude 가 끝나 셸로 돌아갔으면) 넣지 않는다.

    에이전트는 claude 훅이 데몬에 알려 주고 (`thuminal agent report`), SessionEnd 에 지운다. term ls 의 agent 가 비었을 때만
    막고 종류는 가리지 않는다. 막는 까닭은 셸에 넣은 글이 명령으로 실행되는 것 하나다.
    """
    t = target_session(d)
    res = {"seq": sub["seq"], "via": "thuminal", "session": t.get("session", ""), "ok": False, "message": ""}
    # term send --enter 는 글이 화면에 찍힐 때까지 기다렸다 Enter 를 친다. 그동안 페이지가 "전달됐다" 로 앞서 보이지 않게 넣는 중임을 적는다.
    write_json(priv(d) / "delivery.json", dict(res, pending=True, message="Claude 입력창에 넣는 중이다."))
    t0 = time.time()
    keep = f"보낸 내용은 submissions/{sub['seq']:04d}.json 에 있다."
    try:
        me = find_session(tm_json(t, "term", "ls"), t)
        if not me:
            res["message"] = f"thuminal 세션 s{t.get('session')} 이 없다 (끝났거나 지워졌다). 넣지 않았다. {keep}"
        elif (me.get("state") or {}).get("state") != "running" or not me.get("agent"):
            res["message"] = f"그 세션에 지금 에이전트가 없어(셸로 돌아갔다) 넣지 않았다. {keep}"
        else:
            sid = str(me["id"])
            res["session"] = sid
            # 셸 입력을 거치지 않고 인자로 바로 넘긴다. 줄바꿈이 없는 한 줄이라 중간에 제출되지 않는다
            tm_run(t, "term", "send", "--enter", sid, one_line(sub, d), timeout=45)
            res.update(ok=True, message="Claude 입력창에 넣었다.")
    except (RuntimeError, OSError, subprocess.TimeoutExpired, TypeError, KeyError) as e:
        res["message"] = f"thuminal 세션에 넣지 못했다: {e}"
    res.update(at=now_iso(), tookSec=round(time.time() - t0, 2))
    print(f"전달 #{sub['seq']} ({res['tookSec']}초, thuminal): {res['message']}", flush=True)
    write_json(priv(d) / "delivery.json", res)
    return res


def tab_info(d: Path) -> dict:
    info = read_json(d / PRIV_D / "tab.json", None)
    return info if isinstance(info, dict) and info.get("pane") and info.get("cli") else {}


def opened_tab(d: Path) -> str:
    return tab_info(d).get("pane", "")


def pane_name(v) -> str:
    """칸 번호를 CLI 대상 꼴 (p9) 로. JSON 에는 숫자로 온다."""
    if isinstance(v, int) and not isinstance(v, bool):
        return f"p{v}"
    return v if isinstance(v, str) and re.fullmatch(r"p\d+", v) else ""


def walk_panes(node):
    if not isinstance(node, dict):
        return
    if node.get("type") == "pane":
        yield node.get("pane") or {}
    for c in node.get("children") or []:
        yield from walk_panes(c)


def find_pane(info: dict) -> dict:
    """tab.json 의 칸이 아직 있고 이 페이지를 띄운 브라우저 칸이면 {"pane", "workspace"}. 아니면 {}.

    칸 번호는 데몬 전체에서 늘어나기만 하지만, 그 칸이 다른 주소로 옮겨 갔으면 사용자 것이라 건드리지 않는다.
    """
    want = info.get("pane", "")
    for ws in tm_json(info, "pane", "ls", "--all") or []:
        for tab in (ws.get("tabs") or []) if isinstance(ws, dict) else []:
            for p in walk_panes(tab.get("root")):
                doc = p.get("doc") if isinstance(p.get("doc"), dict) else {}
                if pane_name(p.get("id")) == want and doc.get("kind") == "browser" \
                        and str(doc.get("url", "")).startswith(info.get("url") or "\0"):
                    return {"pane": want, "workspace": ws.get("workspace", "")}
    return {}


def close_tab(d: Path) -> bool:
    info = tab_info(d)
    pane = info.get("pane", "")
    if not pane:
        return False
    try:
        if not find_pane(info):
            print(f"thuminal 브라우저 칸 {pane} 은 이미 닫혔다", flush=True)
            return False
        tm_run(info, "pane", "close", pane)
        print(f"thuminal 브라우저 칸을 닫았다 ({pane})", flush=True)
        return True
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
        print(f"thuminal 브라우저 칸을 닫지 못했다 ({pane}): {e}", file=sys.stderr, flush=True)
        return False
    finally:
        # 닫았든, 사용자가 먼저 닫아 없든 다시 시도하지 않는다.
        (d / PRIV_D / "tab.json").unlink(missing_ok=True)


def open_page(d: Path, url: str) -> int:
    t = here_target()
    if not t:
        # 포커스를 가져가지 않게 -g (백그라운드로 연다)
        if sys.platform == "darwin":
            subprocess.run(["open", "-g", url], check=False)
            print(f"기본 브라우저로 열었다: {url}", flush=True)
        else:
            print(f"브라우저에서 연다: {url}", flush=True)
        return 0
    info = tab_info(d)
    try:
        hit = find_pane(info) if info else {}
        if hit and info.get("url") == url:
            # 화면을 그 칸으로 옮긴다. 사용자가 요청한 동작이다 (thuminal 안의 전환이라 다른 앱의 포커스는 건드리지 않는다)
            tm_run(info, "pane", "focus", hit["pane"])
            print(f"thuminal 브라우저 칸이 이미 열려 있어 그 칸으로 옮긴다 ({hit['pane']}). 새로고침만 하면 된다: {url}", flush=True)
            return 0
        if hit:
            # 서버가 다른 포트로 다시 떠 옛 칸은 끊긴 주소를 보고 있다. 닫고 새로 연다
            close_tab(d)
        # --in 을 주지 않으면 이 셸(THUMINAL_SESSION_ID)이 든 워크스페이스에 새 탭으로 열고 포커스한다
        out = tm_json(t, "browser", "open", url)
        made = out.get("created") if isinstance(out, dict) else None
        pane = pane_name(made[0]) if isinstance(made, list) and made else ""
        if not pane:
            raise RuntimeError(f"새 칸 번호를 받지 못했다: {json.dumps(out, ensure_ascii=False)[:200]}")
        ws = next((l.get("workspace", "") for l in out.get("layouts") or []
                   if isinstance(l, dict) and any(pane_name(p.get("id")) == pane
                                                  for tb in l.get("tabs") or [] for p in walk_panes(tb.get("root")))), "")
        write_json(priv(d) / "tab.json", {"pane": pane, "url": url, "workspace": ws, "cli": t["cli"], "home": t["home"],
                                          "session": t["session"], "openedAt": now_iso()})
        print(f"thuminal 브라우저 탭으로 열었다: {url} (칸 {pane}, 워크스페이스 {ws or '?'})", flush=True)
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as e:
        print(f"thuminal 브라우저 탭을 열지 못했다: {e}", file=sys.stderr)
        return 1
    return 0


def route_text(d: Path) -> str:
    t = target_session(d)
    if inbox_target(d):
        return "이 Claude 세션 인박스 (바로 넣는다" + (f", 안 되면 thuminal 세션 s{t['session']} 입력창" if t else "") + ")"
    if t:
        return f"이 thuminal 세션 입력창 (s{t['session']})"
    return "wait (백그라운드로 띄운다)"


def cmd_open(d: Path) -> int:
    info = running_server(d)
    if not info:
        print("서버가 떠 있지 않다. serve 를 먼저 띄운다.", file=sys.stderr)
        return 1
    remember_target(d)
    return open_page(d, info["url"])


def cmd_serve(d: Path, port: int, open_: bool, idle: float, foreground: bool) -> int:
    if foreground:
        return run_server(d, port, idle)
    _, errs, warns = load_spec(d)
    for w in warns:
        print(f"WARN {w}", flush=True)
    for e in errs:
        print(f"ERROR {e}  (고칠 때까지 페이지는 오류 화면을 보인다)", flush=True)

    remember_target(d)
    info = running_server(d)
    if info:
        print(f"URL: {info['url']}", flush=True)
        print(f"이미 떠 있다 (pid {info['pid']}). 열려 있던 탭은 새로고침만 하면 된다.", flush=True)
        print(f"보내기 전달: {route_text(d)}",
              flush=True)
        return open_page(d, info["url"]) if open_ else 0

    # Claude 백그라운드 작업은 한도(기본 30분, 최대 2시간)가 지나면 끝나 페이지가 끊겼다. 그래서 서버는 새 세션(setsid)의
    # 독립 프로세스로 떼어 내고, 요청 없이 idle 초가 지나면 스스로 끝나게 한다. 이 명령은 서버가 뜨는 것만 보고 끝난다.
    log = priv(d) / "server.log"
    cmd = [sys.executable, str(SELF), "serve", str(d), "--foreground", "--idle", str(idle)] + (["--port", str(port)] if port else [])
    with open(log, "ab") as f:
        proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT,
                                start_new_session=True, close_fds=True)
    deadline = time.time() + 10
    while time.time() < deadline:
        info = running_server(d)
        if info and info.get("pid") == proc.pid:
            break
        if proc.poll() is not None:
            tail = log.read_text(encoding="utf-8", errors="replace").splitlines()[-5:]
            print("서버가 뜨지 못했다:\n" + "\n".join(tail), file=sys.stderr)
            return 1
        time.sleep(0.1)
    else:
        print(f"서버가 10초 안에 응답하지 않았다. 로그: {log}", file=sys.stderr)
        return 1
    print(f"URL: {info['url']}", flush=True)
    print(f"폴더: {d}", flush=True)
    print(f"서버: pid {proc.pid}, 독립 프로세스 (요청 없이 {idle / 3600:g}시간이면 끝난다), 로그 {log}", flush=True)
    print(f"보내기 전달: {route_text(d)}",
          flush=True)
    return open_page(d, info["url"]) if open_ else 0


def run_server(d: Path, port: int, idle: float) -> int:
    handler = functools.partial(Handler, directory=str(d))
    ports = [port] if port else [preferred_port(d) + i for i in range(20)]
    srv = None
    for p in ports:
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", p), handler)
            break
        except OSError:
            continue
    if srv is None:
        print(f"포트를 잡지 못했다: {ports[0]}~{ports[-1]}", file=sys.stderr)
        return 1
    p = srv.server_address[1]
    srv.app = App(d, p)  # type: ignore[attr-defined]
    url = f"http://127.0.0.1:{p}/"
    info_f = priv(d) / "server.json"
    write_json(info_f, {"pid": os.getpid(), "port": p, "url": url, "startedAt": now_iso(), "idleSec": idle})
    try:
        build_static(d)
    except Exception as e:  # 정적 사본은 부가 기능이라 서버를 막지 않는다
        print(f"index.html 생성 실패: {e}", file=sys.stderr, flush=True)

    def bye(*_):
        try:
            if (read_json(info_f, {}) or {}).get("pid") == os.getpid():
                info_f.unlink()
        finally:
            os._exit(0)

    def idle_watch():
        while True:
            time.sleep(max(0.5, min(60.0, idle / 4)))
            if time.time() - srv.app.last_request > idle:  # type: ignore[attr-defined]
                print(f"{now_iso()} 요청 없이 {idle:g}초가 지나 끝낸다", flush=True)
                bye()

    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGHUP, signal.SIG_IGN)   # 띄운 셸이 끝나도 남는다
    if idle > 0:
        threading.Thread(target=idle_watch, daemon=True).start()
    print(f"{now_iso()} URL: {url} (pid {os.getpid()})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        bye()
    return 0


def cmd_wait(d: Path, timeout: float) -> int:
    pidf = priv(d) / "waiter.pid"
    old = read_pid(pidf)
    if old and old != os.getpid() and pid_alive(old):
        # 대기는 하나만 둔다. 새로 띄운 쪽이 이어받는다.
        os.kill(old, signal.SIGTERM)
        for _ in range(20):
            if not pid_alive(old):
                break
            time.sleep(0.1)
    pidf.write_text(str(os.getpid()))

    def cleanup():
        if read_pid(pidf) == os.getpid():
            pidf.unlink(missing_ok=True)

    def on_term(*_):
        cleanup()
        print("[agenda-picker] 이 대기는 끝났다 (새 wait 가 이어받았거나 stop 으로 멈췄다). 따로 할 일은 없다.", flush=True)
        os._exit(0)

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGHUP, on_term)
    ppid = os.getppid()
    deadline = time.time() + timeout if timeout > 0 else None
    try:
        while True:
            latest, consumed = latest_seq(d), read_consumed(d)
            if latest > consumed:
                subs = [s for s in (read_json(d / SUBS_D / f"{n:04d}.json") for n in range(consumed + 1, latest + 1)) if s]
                atomic_write(d / PRIV_D / "consumed", str(latest))
                if subs:
                    print(format_message(subs[-1], d, [s["seq"] for s in subs[:-1]]), flush=True)
                    return 0
            if deadline and time.time() > deadline:
                print(f"[agenda-picker] {int(timeout)}초 동안 보낸 것이 없어 대기를 끝냈다. 계속 받으려면 wait 를 다시 띄운다.", flush=True)
                return 3
            if not d.exists():
                print(f"[agenda-picker] 폴더가 없어져 대기를 끝냈다: {d}", flush=True)
                return 4
            if ppid != 1 and os.getppid() != ppid:
                return 0
            time.sleep(POLL_SEC)
    finally:
        cleanup()


def cmd_status(d: Path) -> int:
    spec, errs, warns = load_spec(d)
    st = clean_state(read_json(d / STATE_F, {}))
    if spec and not errs:
        st = seed_decided(spec, st)
    info = running_server(d)
    waiter = read_pid(d / PRIV_D / "waiter.pid")
    print(f"폴더: {d}")
    print(f"서버: {'떠 있음 ' + info['url'] + ' (pid %d)' % info['pid'] if info else '꺼짐'}")
    print(f"대기(wait): {'대기 중 (pid %d)' % waiter if pid_alive(waiter) else '없음'}")
    print(f"thuminal 브라우저 칸: {opened_tab(d) or '없음'}")
    print(f"보내기 전달: {route_text(d)}")
    dl = read_json(d / PRIV_D / "delivery.json", None)
    if isinstance(dl, dict):
        print(f"마지막 전달: #{dl.get('seq')} {dl.get('message', '')}")
    if spec and not errs:
        items = resolve(spec, st)
        print(f"선택: 결정 {sum(1 for i in items if i['pick'])}/{len(items)}, 마지막 저장 {st['updatedAt'] or '-'}")
        for i, it in enumerate(items, 1):
            print(f"  {i}. [{it['id']}]{pick_line(it)[len('   선택:'):]}")
    for e in errs:
        print(f"ERROR {e}")
    for w in warns:
        print(f"WARN {w}")
    seq = latest_seq(d)
    print(f"보냄: {'#%d' % seq if seq else '없음'}, Claude 에 전달된 마지막 번호 #{read_consumed(d)}")
    return 0


def cmd_stop(d: Path) -> int:
    stopped = []
    info = read_json(d / PRIV_D / "server.json", None)
    if isinstance(info, dict) and pid_alive(info.get("pid")):
        os.kill(info["pid"], signal.SIGTERM)
        stopped.append(f"서버 pid {info['pid']}")
    w = read_pid(d / PRIV_D / "waiter.pid")
    if pid_alive(w):
        os.kill(w, signal.SIGTERM)
        stopped.append(f"wait pid {w}")
    if opened_tab(d) and close_tab(d):
        stopped.append("thuminal 브라우저 칸")
    print("멈춤: " + ", ".join(stopped) if stopped else "떠 있는 것이 없다")
    return 0


def main() -> int:
    for _f in (sys.stdout, sys.stderr):   # Windows 콘솔(cp949)에서 ✓ · 한글을 찍다 죽지 않게
        try:
            _f.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="안건 선택 페이지")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("check", "build", "open", "status", "stop"):
        sub.add_parser(name).add_argument("dir")
    s = sub.add_parser("serve")
    s.add_argument("dir")
    s.add_argument("--port", type=int, default=0)
    s.add_argument("--open", action="store_true", help="띄운 뒤 open 과 같이 연다")
    s.add_argument("--idle", type=float, default=IDLE_SEC, help="초. 요청 없이 이만큼 지나면 서버가 끝난다 (0 = 끝나지 않는다)")
    s.add_argument("--foreground", action="store_true", help="떼어 내지 않고 이 프로세스에서 서버를 돌린다")
    w = sub.add_parser("wait")
    w.add_argument("dir")
    w.add_argument("--timeout", type=float, default=0, help="초. 0 = 제한 없음 (세션이 끝나면 같이 끝난다)")
    a = ap.parse_args()

    d = Path(a.dir).expanduser().resolve()
    if not d.is_dir():
        print(f"폴더가 없다: {d}", file=sys.stderr)
        return 1
    if a.cmd == "check":
        _, errs, warns = load_spec(d)
        for w_ in warns:
            print(f"WARN {w_}")
        for e in errs:
            print(f"ERROR {e}")
        print("OK" if not errs else f"오류 {len(errs)}개")
        return 1 if errs else 0
    if a.cmd == "build":
        _, errs, _ = load_spec(d)
        out = build_static(d)
        print(f"{out}{' (오류 화면)' if errs else ''}")
        return 1 if errs else 0
    if a.cmd == "serve":
        return cmd_serve(d, a.port, a.open, a.idle, a.foreground)
    if a.cmd == "wait":
        return cmd_wait(d, a.timeout)
    if a.cmd == "open":
        return cmd_open(d)
    if a.cmd == "status":
        return cmd_status(d)
    if a.cmd == "stop":
        return cmd_stop(d)
    return 1


if __name__ == "__main__":
    sys.exit(main())
