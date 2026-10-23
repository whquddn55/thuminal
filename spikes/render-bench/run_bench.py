"""렌더링 측정 시나리오를 차례로 돌리고 결과를 모은다.

시나리오마다 측정 앱을 새로 띄우고, 1초마다 앱 프로세스와 그 앱이 띄운
WebKit 프로세스(WebContent, GPU, Networking)의 메모리(RSS)와 CPU 를 잰다.
WebKit 프로세스는 launchd 밑에 뜨므로, 앱을 띄우기 전에 없던 WebKit 프로세스를
이 앱의 것으로 본다.

사용법: python3 run_bench.py <workload 폴더> <결과 폴더> [--only 이름,이름] [--duration 20]
"""

import json
import os
import plistlib
import re
import subprocess
import sys
import time

APP = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "src-tauri/target/release/bundle/macos/render-bench.app"
)
BIN_MATCH = "render-bench.app/Contents/MacOS/render-bench"

SCENARIOS = [
    # 이름, 모드, 보이는 수, 터미널마다 초당 바이트
    ("ghostty-v1", "ghostty", 1, 65536),
    ("gl-v1", "ghostty-gl", 1, 65536),
    ("xterm-v1", "xterm", 1, 65536),
    ("ghostty-v4", "ghostty", 4, 65536),
    ("gl-v4", "ghostty-gl", 4, 65536),
    ("xterm-v4", "xterm", 4, 65536),
    ("ghostty-v20", "ghostty", 20, 65536),
    ("gl-v20", "ghostty-gl", 20, 65536),
    ("xterm-v20", "xterm", 20, 65536),
    ("ghostty-v4-flood", "ghostty", 4, 262144),
    ("gl-v4-flood", "ghostty-gl", 4, 262144),
    ("xterm-v4-flood", "xterm", 4, 262144),
    # 메모리 원인 가르기: 글자를 그리지 않는다
    ("ghostty-v20-notext", "ghostty&notext=1", 20, 65536),
]


def webkit_pids():
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    pids = {}
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(" ")
        if "com.apple.WebKit." in cmd:
            pids[int(pid)] = cmd.split("/")[-1].split(" ")[0]
    return pids


def sample(pids):
    if not pids:
        return {}
    out = subprocess.run(
        ["ps", "-o", "pid=,rss=,%cpu=", "-p", ",".join(map(str, pids))], capture_output=True, text=True
    ).stdout
    res = {}
    for line in out.splitlines():
        pid, rss, cpu = line.split()
        res[int(pid)] = (int(rss) / 1024, float(cpu))
    return res


WINDOW = os.environ.get("BENCH_WINDOW", "")


def gpu_clients():
    """GPU 클라이언트별 누적 GPU 시간(ns): {클라이언트 id: (pid, 이름, ns)}.
    ioreg 의 AGX AppUsage.accumulatedGPUTime (활동 상태 보기의 GPU 시간과 같은 값). 클라이언트가 생기고 없어지므로
    pid 합계가 아니라 클라이언트 단위로 차이를 더한다."""
    txt = subprocess.run(["ioreg", "-r", "-c", "IOAccelerator", "-l", "-w", "0", "-d", "3"], capture_output=True, text=True).stdout
    res = {}
    for blk in txt.split("+-o ")[1:]:
        c = re.search(r'"IOUserClientCreator" = "pid (\d+), ([^"]*)"', blk)
        u = re.search(r'"AppUsage" = (\(.*\))', blk)
        i = re.search(r"id 0x([0-9a-f]+)", blk)
        if c and u and i:
            ns = sum(map(int, re.findall(r'accumulatedGPUTime"=(\d+)', u.group(1))))
            res[i.group(1)] = (int(c.group(1)), c.group(2), ns)
    return res


def gpu_delta(prev, cur, acc):
    """두 시점 사이 클라이언트별 GPU 시간 증가분을 pid 별로 acc 에 더한다."""
    for cid, (pid, name, ns) in cur.items():
        before = prev[cid][2] if cid in prev else 0
        if ns > before:
            k = acc.setdefault(pid, [name, 0])
            k[1] += ns - before


def gpu_util():
    """GPU 사용률(%)을 ioreg 로 읽는다. 시스템 전체 값이라 WindowServer 합성도 들어간다."""
    out = subprocess.run(["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"], capture_output=True, text=True).stdout
    res = {}
    for key, name in (("Device Utilization %", "device"), ("Renderer Utilization %", "renderer"), ("Tiler Utilization %", "tiler")):
        i = out.find(f'"{key}"=')
        if i >= 0:
            v = out[i + len(key) + 3 :].split(",")[0].split("}")[0]
            res[name] = float(v)
    return res


def run(name, mode, visible, rate, workload, outdir, duration):
    before = set(webkit_pids())
    out = os.path.join(outdir, f"{name}.json")
    env = dict(os.environ)
    env.update(
        BENCH_ARGS=f"mode={mode}&terms=20&visible={visible}&rate={rate}&duration={duration}&warmup=3",
        BENCH_WORKLOAD_DIR=workload,
        BENCH_OUT=out,
    )
    # 터미널 데몬 밑에서 실행 파일을 바로 띄우면 창이 화면에 올라오지 않아 open 으로 띄운다
    envargs = []
    for k in ("BENCH_ARGS", "BENCH_WORKLOAD_DIR", "BENCH_OUT"):
        envargs += ["--env", f"{k}={env[k]}"]
    if WINDOW:
        envargs += ["--env", f"BENCH_WINDOW={WINDOW}"]
    opener = subprocess.Popen(["open", "-n", "-W", APP, *envargs])
    t0 = time.time()
    pid = None
    while pid is None and time.time() - t0 < 15:
        time.sleep(0.2)
        found = subprocess.run(["pgrep", "-n", "-f", BIN_MATCH], capture_output=True, text=True).stdout.strip()
        pid = int(found) if found else None

    # 다른 창에 가려지면 측정이 멈추므로 앞으로 불러온다
    time.sleep(1)
    subprocess.run(["osascript", "-e", 'tell application id "dev.thuminal.renderbench" to activate'])

    class Proc:
        pid = None

        def poll(self):
            return opener.poll()

        def kill(self):
            subprocess.run(["pkill", "-f", BIN_MATCH])

    proc = Proc()
    proc.pid = pid
    samples = []
    gpu_prev = None
    gpu_t0 = 0
    gpu_acc = {}
    gpu_pids = set()
    while proc.poll() is None and time.time() - t0 < duration + 60:
        time.sleep(1)
        mine = {p: n for p, n in webkit_pids().items() if p not in before}
        s = sample([proc.pid, *mine])
        # 앞 3초는 준비·예열이라 빼고, 끝난 뒤 남은 처리는 포함한다
        if time.time() - t0 > 5:
            app = s.get(proc.pid, (0, 0))
            kinds = {}
            for p, kind in mine.items():
                rss, cpu = s.get(p, (0, 0))
                k = kinds.setdefault(kind, [0.0, 0.0])
                k[0] += rss
                k[1] += cpu
            samples.append({"app": app, "webkit": kinds, "gpu": gpu_util()})
            now, cl = time.time(), gpu_clients()
            if gpu_prev is None:
                gpu_t0 = now
            else:
                gpu_delta(gpu_prev[1], cl, gpu_acc)
            gpu_prev = (now, cl)
            gpu_pids |= {proc.pid, *mine}
    if proc.poll() is None:
        proc.kill()
    result = json.load(open(out)) if os.path.exists(out) else {"error": "결과 없음"}

    def series(f):
        return [f(x) for x in samples] or [0]

    total_rss = series(lambda x: x["app"][0] + sum(v[0] for v in x["webkit"].values()))
    total_cpu = series(lambda x: x["app"][1] + sum(v[1] for v in x["webkit"].values()))
    content_rss = series(lambda x: sum(v[0] for k, v in x["webkit"].items() if "WebContent" in k))
    content_cpu = series(lambda x: sum(v[1] for k, v in x["webkit"].items() if "WebContent" in k))
    gpu_cpu = series(lambda x: sum(v[1] for k, v in x["webkit"].items() if "GPU" in k))
    result["process"] = {
        "samples": len(samples),
        "totalRssPeakMB": max(total_rss),
        "webContentRssPeakMB": max(content_rss),
        "totalCpuAvgPct": sum(total_cpu) / len(total_cpu),
        "webContentCpuAvgPct": sum(content_cpu) / len(content_cpu),
        "gpuCpuAvgPct": sum(gpu_cpu) / len(gpu_cpu),
        "webContentRssSeriesMB": [round(x) for x in content_rss],
    }
    for k in ("device", "renderer", "tiler"):
        g = series(lambda x: x["gpu"].get(k, 0))
        result["process"][f"gpuUtil_{k}_AvgPct"] = sum(g) / len(g)
    # GPU 시간: 첫 샘플과 마지막 샘플 사이에 쓴 GPU 시간을 벽시계 시간으로 나눈다 (100% = GPU 를 쉬지 않고 씀)
    if gpu_prev and gpu_prev[0] > gpu_t0:
        span = gpu_prev[0] - gpu_t0

        def pct(ns):
            return ns / span / 1e9 * 100

        result["process"]["gpuTimeBenchPct"] = pct(sum(v[1] for q, v in gpu_acc.items() if q in gpu_pids))
        result["process"]["gpuTimeWindowServerPct"] = pct(sum(v[1] for v in gpu_acc.values() if v[0] == "WindowServer"))
        result["process"]["gpuTimeByProc"] = {
            f"{v[0]}({q}){'*' if q in gpu_pids else ''}": round(pct(v[1]), 2) for q, v in gpu_acc.items() if pct(v[1]) > 0.05
        }
    result["process"]["gpuUtilDeviceSeriesPct"] = series(lambda x: x["gpu"].get("device", 0))
    json.dump(result, open(out, "w"), indent=2, ensure_ascii=False)
    return result


def row(name, r):
    p = r.get("process", {})
    return (
        f"| {name} | {r.get('cols')}x{r.get('rows')} | {r.get('inputMBps', 0):.2f} | {r.get('fps', 0):.0f} | "
        f"{r.get('frameP95', 0):.0f} | {r.get('framesOver50ms', 0)} | {r.get('maxBacklogKB', 0):.0f} | "
        f"{r.get('drainMs', 0):.0f} | {p.get('webContentCpuAvgPct', 0):.0f} | {p.get('gpuCpuAvgPct', 0):.0f} | "
        f"{p.get('totalCpuAvgPct', 0):.0f} | {p.get('gpuTimeBenchPct', 0):.1f} | {p.get('gpuTimeWindowServerPct', 0):.1f} | {p.get('webContentRssPeakMB', 0):.0f} | {p.get('totalRssPeakMB', 0):.0f} |"
        + (f" {r['error']}" if "error" in r else "")
    )


def summarize(outdir):
    header = (
        "| 시나리오 | 칸 | 입력 MB/s | fps | 프레임 p95 ms | 50ms 넘은 프레임 | 최대 밀림 KB | 남은 처리 ms | "
        "WebContent CPU% | GPU CPU% | 전체 CPU% | GPU 시간% (앱) | GPU 시간% (WindowServer) | WebContent MB | 전체 MB |\n|" + "---|" * 15
    )
    rows = []
    for name, *_ in SCENARIOS:
        f = os.path.join(outdir, f"{name}.json")
        if os.path.exists(f):
            rows.append(row(name, json.load(open(f))))
    text = header + "\n" + "\n".join(rows) + "\n"
    open(os.path.join(outdir, "summary.md"), "w").write(text)
    return text


def main():
    if sys.argv[1] == "--summarize":
        print(summarize(sys.argv[2]))
        return
    workload, outdir = sys.argv[1], sys.argv[2]
    only = None
    duration = 20
    args = sys.argv[3:]
    if "--only" in args:
        only = set(args[args.index("--only") + 1].split(","))
    if "--duration" in args:
        duration = int(args[args.index("--duration") + 1])
    os.makedirs(outdir, exist_ok=True)
    for name, mode, visible, rate in SCENARIOS:
        if only and name not in only:
            continue
        r = run(name, mode, visible, rate, workload, outdir, duration)
        print(row(name, r), flush=True)
    print(summarize(outdir))


if __name__ == "__main__":
    main()
