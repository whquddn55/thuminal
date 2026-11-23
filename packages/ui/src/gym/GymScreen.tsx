// 화면 보호기: 창 안에서 한동안 입력이 없으면 창 전체를 헬스장 화면으로 덮는다.
// 그림(map · sim · rig · render)은 sleep-monitor(~/workspace/sleep-monitor/src/world) 것을 그대로 가져왔고,
// 사람 상태는 thuminal 데몬이 claude 훅으로 정한 것을 쓴다 (`feed.ts`). 원격 컴퓨터 세션은 그리지 않는다.
//
// 아무 키나 누르거나 빈 곳을 누르면 닫힌다. 사람을 누르면 닫고 그 칸으로 간다. B 는 숙소를 펼치고 접는다.

import { useEffect, useMemo, useRef, useState } from "react";

import { useApp } from "../store";
import { GymFeed } from "./feed";
import { agentColor, clock, duration } from "./format";
import { LEAD_BENCH_L, BENCH_L, OFFICE_W, OFFICE_X0, T, WORLD_H, WORLD_W, configureMap, pods } from "./map";
import {
  benchFront,
  drawBackground,
  drawBench,
  drawBencher,
  drawBubble,
  drawCarriedDesk,
  drawCrouch,
  drawFlyer,
  drawFlyingDesk,
  drawLabel,
  drawLander,
  drawLeadBench,
  drawLeadPresser,
  drawOops,
  drawPerson,
  drawRing,
  drawSelfie,
  drawShockwave,
  drawSleeper,
  drawSprawl,
  drawZzz,
  type Look,
  type Status,
  type View,
} from "./render";
import { RIG_K, RIG_TOP } from "./rig";
import { CROUCH_S, LAND_S, OOPS_MS, World as Sim, type Avatar } from "./sim";
import type { AgentInfo } from "./types";

// 한 칸이 화면에서 차지하는 크기 (CSS px). 화면이 크면 칸 수가 늘어 포드 · 침대 자리가 많아진다
const TILE_PX = 35;

const HAIR = ["#2b1d16", "#4a3020", "#1c1c24", "#7a4a2a", "#c58b4a", "#e0c080", "#8a8f99", "#b03a2e", "#3b4f9a", "#d9d9e0"];
const SKIN = ["#f3d2b3", "#e8b98f", "#c98e63", "#8d5a3b", "#f6dcc4", "#dca77e"];

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

// 세션(팀장)은 어른, 팀원은 어린이(어른 모습 그대로 작게)
function lookOf(a: AgentInfo): Look {
  const h = hash(a.key);
  return {
    shirt: agentColor(a),
    hair: HAIR[h % HAIR.length],
    skin: SKIN[(h >>> 8) % SKIN.length],
    scale: a.kind === "teammate" ? 1.1 : 1.45,
  };
}

// 이름표 글. 길면 drawLabel 이 줄을 바꾼다
function shortLabel(a: AgentInfo): string {
  return a.kind === "session" ? a.title || a.name : a.name;
}

function isWorking(a: AgentInfo): boolean {
  return a.status === "busy" || a.status === "shell" || a.status === "active";
}

function workStatus(a: AgentInfo, now: number): Status {
  // 화면이 헬스장이라 말도 운동으로 한다: 도구 = 세트, 도구 없이 생각 = 숨 고르기
  if (a.attention) return { text: "🙋 응답 대기", tone: "work" };
  if (a.pendingTool && a.pendingSince) return { text: `${a.pendingTool} 세트 중 · ${duration(now - a.pendingSince)}`, tone: "work" };
  return { text: "숨 고르는 중", tone: "think" };
}

// 팀장이 운동 중인 팀원에게 (누운 채) 외치는 말
const SHOUTS = ["하나 더!!!", "할 수 있어!!!", "자세 무너진다!!", "숨 쉬어!!", "마지막 하나!!!", "근손실 온다!!"];

// mates: 이 팀장 포드에서 운동 중인 팀원 수. 있으면 팀장이 4.5 초마다 잠깐 소리친다
function statusOf(av: Avatar, now: number, mates = 0): Status | null {
  if (av.pose === "selfie") return { text: "오운완 📸", tone: "rest" };
  if (now - av.oopsAt < OOPS_MS) return { text: "아악!! 발등!!", tone: "work" };
  if (av.pose === "walk" || av.pose === "lift" || av.pose === "crouch" || av.pose === "fly" || av.pose === "land") {
    const g = av.goal?.kind;
    const text = av.mode === "work" ? "운동하러 가는 중" : g === "mirror" ? "오운완 찍으러 가는 중" : av.mode === "rest" ? "쉬러 가는 중" : "운동 끝, 집에 가는 중";
    return { text, tone: "walk" };
  }
  if (av.pose === "sleep") return null;
  if (av.mode === "rest") return { text: "💧 쉬는 중", tone: "rest" };
  if (!av.info.attention && mates > 0 && now % 4500 < 1400) return { text: SHOUTS[(Math.floor(now / 4500) + hash(av.key)) % SHOUTS.length], tone: "work" };
  return workStatus(av.info, now);
}

// ── 화면 배치: 평소엔 사무실만, 숙소는 펼치면 왼쪽에 오버레이 ──────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Views {
  main: View; // 월드 좌표 → 화면 (사무실이 화면에 꽉 차게)
  office: Box; // 사무실이 보이는 화면 영역
  bed: View; // 숙소 오버레이에서 월드 좌표 → 화면
  panel: Box; // 숙소 오버레이 화면 영역
}

function computeViews(w: number, h: number): Views {
  const dpr = window.devicePixelRatio || 1;
  const scale = Math.min(w / OFFICE_W, h / WORLD_H);
  const left = (w - OFFICE_W * scale) / 2;
  const top = (h - WORLD_H * scale) / 2;
  return {
    main: { scale, ox: left - OFFICE_X0 * scale, oy: top, dpr },
    office: { x: left, y: top, w: OFFICE_W * scale, h: WORLD_H * scale },
    bed: { scale, ox: left, oy: top, dpr },
    panel: { x: left, y: top, w: OFFICE_X0 * scale, h: WORLD_H * scale },
  };
}

function renderBackground(view: View): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const k = view.scale * view.dpr;
  c.width = Math.ceil(WORLD_W * k);
  c.height = Math.ceil(WORLD_H * k);
  const ctx = c.getContext("2d")!;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawBackground(ctx);
  return c;
}

type Ctx = CanvasRenderingContext2D;

// 한 화면 영역(사무실 또는 숙소 오버레이)에 그 영역의 사람 · 가구를 그린다
function drawScene(ctx: Ctx, bg: HTMLCanvasElement, view: View, box: Box, inRegion: (x: number) => boolean, sim: Sim, feed: GymFeed, now: number, hover: string | null) {
  const { dpr, scale, ox, oy } = view;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.beginPath();
  ctx.rect(box.x * dpr, box.y * dpr, box.w * dpr, box.h * dpr);
  ctx.clip();
  ctx.drawImage(bg, Math.round(ox * dpr), Math.round(oy * dpr));
  const k = scale * dpr;
  ctx.setTransform(k, 0, 0, k, ox * dpr, oy * dpr);

  const items: { depth: number; draw: () => void }[] = [];
  const overlays: (() => void)[] = [];

  // 팀장마다 운동 중인 팀원 수 (있으면 팀장이 말풍선으로 소리친다)
  const mateCount = new Map<string, number>();
  for (const a of sim.avatars.values()) {
    if (!a.teammate || a.pose !== "sitside" || a.mode !== "work") continue;
    const r = sim.rootOf(a).key;
    mateCount.set(r, (mateCount.get(r) ?? 0) + 1);
  }
  // 팀장 벤치: 팀장이 던져 놓은 포드에만 있다. 팀장이 누워 들고 있거나 바벨을 떨어뜨린 동안은 거치대가 비어 있다
  for (const p of pods) {
    if (!sim.placedDesks.has(p.id) || !inRegion(p.cx * T)) continue;
    const owner = [...sim.avatars.values()].find((a) => a.pose === "sitfront" && a.goal?.kind === "lead" && a.goal.pod === p);
    items.push({ depth: p.y0 * T + 2, draw: () => drawLeadBench(ctx, p, !owner) });
  }

  for (const av of sim.avatars.values()) {
    if (!inRegion(av.x)) continue;
    const look = lookOf(av.info);
    const color = agentColor(av.info);
    const isSel = av.key === hover;
    const fade = av.born ? Math.min(1, (now - av.born) / 700) : 1;
    const working = av.mode === "work";

    if (av.pose === "sleep" && av.bed) {
      const b = av.bed;
      const bx = b.x * T;
      const by = b.y * T;
      const cx = bx + (b.w * T) / 2;
      av.hit = { x: bx, y: by, w: b.w * T, h: b.h * T };
      items.push({
        depth: (b.y + b.h) * T,
        draw: () => {
          drawSleeper(ctx, b, look, av.phase);
          if (isSel) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(bx + 1, by, b.w * T - 2, b.h * T);
          }
        },
      });
      overlays.push(() => {
        drawZzz(ctx, cx + 8, by + 14, av.phase);
        if (isSel) drawLabel(ctx, cx, by + b.h * T - 2, shortLabel(av.info), color, false);
      });
      continue;
    }

    const fx = av.x;
    const fy = av.y + 7;
    const oops = now - av.oopsAt < OOPS_MS;
    const speed = feed.repSpeed(av.key);
    // 사람 몸 그리기: 운동 자리 말고 서기 · 걷기 · 장비 들기 · 날기 · 착지 · 셀카
    const drawBody = (headTop: number, big: boolean) => {
      if (av.pose === "selfie") drawSelfie(ctx, fx, av.y, look, av.stepT);
      else if (av.pose === "fly")
        drawFlyer(
          ctx,
          fx,
          fy,
          av.z,
          look,
          av.dir,
          av.phase,
          av.tilt,
          av.trail.map((p) => ({ x: p.x, y: p.y + 7 })),
        );
      else if (av.pose === "crouch") drawCrouch(ctx, fx, fy, look, av.dir, av.phase, av.stepT / CROUCH_S);
      else if (av.pose === "land") drawLander(ctx, fx, fy, look, av.stepT / LAND_S);
      else {
        drawPerson(ctx, fx, fy, look, av.dir, av.pose === "walk", av.phase, av.pose === "lift");
        if (av.carrying) drawCarriedDesk(ctx, fx, headTop - (av.pose === "lift" ? 6 : 1), big);
      }
    };
    if (av.teammate) {
      // 팀원(어린이): 말풍선 없이, 이름은 늘 작게
      // 탑에 쌓인 층은 아래로 비켜 놓여 있어 깊이 순서대로 그리면 아래층이 앞을 가린다
      // 벤치는 던져서 자리에 내려앉은 뒤부터 (주인이 날아오기 전에도) 보인다
      const seat = av.deskDown ? av.seat : undefined;
      const ms = sim.seatOf(av);
      const sitting = av.pose === "sitside";
      const depth = av.y + 12;
      if (seat && ms) items.push({ depth: ms.y * T + ms.drop + T / 2 + 11, draw: () => drawBench(ctx, ms) });
      // 벤치에 누우면 머리는 벤치 위쪽 끝 (들어 올린 바벨 높이까지)
      const top = sitting ? av.y - 22 : fy - RIG_TOP * RIG_K * look.scale - av.z;
      const rest = sitting && !working && !oops && ms ? benchFront(ms) : undefined;
      // 누를 수 있는 곳: 벤치에 누운 몸 전체 (발끝까지), 그 밖에는 서 있는 몸
      av.hit = sitting && !rest ? { x: fx - 16, y: top, w: 32, h: BENCH_L + 30 } : { x: fx - 10, y: top, w: 20, h: av.y + 12 - top };
      items.push({
        depth,
        draw: () => {
          ctx.globalAlpha = fade;
          if (isSel) drawRing(ctx, fx, fy, color, av.phase);
          // 운동 자리: 오류면 바벨을 떨어뜨려 깡충, 쉬면 바닥에 대자로 뻗고, 일하면 벤치프레스
          if (sitting && oops) drawOops(ctx, av.x, av.y, look, (now - av.oopsAt) / OOPS_MS);
          else if (rest) drawSprawl(ctx, rest.x, rest.y, look, av.phase);
          else if (sitting && ms) drawBencher(ctx, ms, look, av.phase, working, speed);
          else drawBody(top, false);
          ctx.globalAlpha = 1;
        },
      });
      overlays.push(() => {
        if (rest) drawZzz(ctx, rest.x + 6, rest.y - 14, av.phase);
        // 거울 앞 셀카: 위쪽 벽에 붙어 머리 위가 화면 밖이라 말풍선은 발밑에
        if (av.pose === "selfie") drawBubble(ctx, fx, fy + 30, { text: "오운완 📸", tone: "rest" }, color, av.phase);
        // 탑에 겹친 팀원은 맨 앞 층만 이름이 늘 보이고, 나머지는 가리킬 때만
        if (sitting && ms && !ms.front && !isSel) return;
        // 이름표: 쉬면 뻗은 사람 아래, 운동 중이면 벤치 발끝 아래, 그 밖에는 발밑
        const ly = rest ? rest.y + 14 : sitting && ms ? ms.y * T + ms.drop + 2 + BENCH_L + 4 : fy + 2 - av.z;
        drawLabel(ctx, rest ? rest.x : fx, ly, shortLabel(av.info), color, !isSel, "top", 7);
        // 운동 중이면 머리 위에 횟수 (도구 1 회 = 1 회)
        if (sitting && working && !oops) drawLabel(ctx, fx, top - 2, `${av.info.toolCount}회`, "#ffc34d", false, "bottom", 7);
      });
      continue;
    }

    // 세션(팀장)
    const front = av.pose === "sitfront";
    const benchPod = front && av.goal?.kind === "lead" ? av.goal.pod : undefined;
    // 벤치에 누우면 말풍선은 들어 올린 바벨 위에
    const headY = benchPod ? av.y - 30 : fy - av.z - RIG_TOP * RIG_K * look.scale;
    av.hit = benchPod ? { x: fx - 26, y: headY, w: 52, h: LEAD_BENCH_L + 40 } : { x: fx - 13, y: headY - 2, w: 26, h: fy + 2 - headY };
    items.push({
      // 벤치에 누우면 벤치 위에, 그 자리에 착지하는 동안은 벤치 앞에 그린다
      depth: av.goal?.kind === "lead" && (front || av.pose === "land") ? av.goal.pod.y0 * T + 30 : av.y + 8,
      draw: () => {
        ctx.globalAlpha = fade;
        if (isSel && !front) drawRing(ctx, fx, fy, color, av.phase);
        if (front && oops) drawOops(ctx, av.x, av.y, look, (now - av.oopsAt) / OOPS_MS);
        // 응답 대기면 바벨을 든 채 멈춰 있다
        else if (benchPod) drawLeadPresser(ctx, benchPod, look, av.phase, working && !av.info.attention, speed);
        else drawBody(headY, true);
        ctx.globalAlpha = 1;
      },
    });
    const st = statusOf(av, now, front ? (mateCount.get(av.key) ?? 0) : 0);
    overlays.push(() => {
      if (benchPod) {
        // 벤치에 누우면 이름은 벤치 발끝 아래, 머리 위에는 말풍선만
        drawLabel(ctx, fx, benchPod.y0 * T - 2 + LEAD_BENCH_L + 4, shortLabel(av.info), color, false, "top", 9, 2.6 * T);
        if (isSel) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.2;
          ctx.strokeRect(fx - 14, headY - 1, 28, 6);
        }
        if (st) drawBubble(ctx, fx, headY - 3, st, color, av.phase);
        return;
      }
      // 거울 앞 셀카는 위쪽 벽에 붙어 있어 머리 위가 화면 밖이다. 이름표는 발밑, 말풍선은 그 아래
      if (av.pose === "selfie") {
        drawLabel(ctx, fx, fy + 3, shortLabel(av.info), color, false, "top");
        if (st) drawBubble(ctx, fx, fy + 44, st, color, av.phase);
        return;
      }
      // 걸어 다닐 때는 이름표가 머리 바로 위, 말풍선은 그 위
      const labelTop = drawLabel(ctx, fx, headY - (av.carrying ? 28 : 2), shortLabel(av.info), color, false, "bottom");
      if (st) drawBubble(ctx, fx, labelTop - 1, st, color, av.phase);
    });
  }

  // 던진 책상은 땅 위치 깊이로, 충격파는 그 자리 사람 · 가구 밑에 그린다
  for (const d of sim.desks) {
    if (!inRegion(d.x)) continue;
    items.push({ depth: d.y + 12, draw: () => drawFlyingDesk(ctx, d.x, d.y, d.z, d.big, d.spin, Math.min(1, d.t / d.dur)) });
  }
  for (const r of sim.rings) {
    if (!inRegion(r.x)) continue;
    items.push({ depth: r.y - 20, draw: () => drawShockwave(ctx, r.x, r.y, r.r, r.age / r.life) });
  }

  items.sort((a, b) => a.depth - b.depth);
  for (const it of items) it.draw();
  for (const o of overlays) o();
  ctx.restore();
}

function drawFrame(ctx: Ctx, bg: HTMLCanvasElement, v: Views, bedOpen: boolean, sim: Sim, feed: GymFeed, now: number, hover: string | null) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#07090d";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // 착지 진동: 사무실 화면을 흔든다 (배경 · 사람 · 가구를 같이 옮긴다)
  const j = sim.shake;
  const main = j ? { ...v.main, ox: v.main.ox + (Math.random() * 2 - 1) * j, oy: v.main.oy + (Math.random() * 2 - 1) * j } : v.main;
  drawScene(ctx, bg, main, v.office, (x) => x >= OFFICE_X0 - T / 2, sim, feed, now, hover);
  if (!bedOpen) return;
  // 숙소 오버레이: 사무실 왼쪽 위에 그림자와 함께 띄운다
  const { dpr } = v.bed;
  const p = v.panel;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 30 * dpr;
  ctx.fillStyle = "#0b0e14";
  ctx.fillRect(p.x * dpr, p.y * dpr, p.w * dpr, p.h * dpr);
  ctx.shadowBlur = 0;
  drawScene(ctx, bg, v.bed, p, (x) => x < OFFICE_X0 + T / 2, sim, feed, now, hover);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = dpr;
  ctx.strokeRect(p.x * dpr + 0.5, p.y * dpr + 0.5, p.w * dpr - 1, p.h * dpr - 1);
}

// ── 화면 ─────────────────────────────────────────────

/**
 * 헬스장 화면. root(로컬) 모델 안에서 그린다. onPick 은 사람을 눌렀을 때 그 세션 번호로 부른다.
 * 키는 `useIdleScreen` 이 받아 B 만 넘겨준다 (bedToggle 이 바뀌면 숙소를 펼치고 접는다)
 */
export function GymScreen({
  bedToggle,
  locked,
  onPick,
  onClose,
  children,
}: {
  bedToggle: number;
  /** 잠겨 있다: 닫거나 사람을 누르면 암호를 묻는다 */
  locked: boolean;
  onPick: (session: number) => void;
  onClose: () => void;
  /** 그림 위에 얹을 것 (암호 칸) */
  children?: React.ReactNode;
}) {
  const sessions = useApp((s) => s.sessions);
  const worktrees = useApp((s) => s.worktrees);
  const feedRef = useRef(new GymFeed());
  const simRef = useRef(new Sim());
  const agentsRef = useRef<AgentInfo[]>([]);
  const hoverRef = useRef<string | null>(null);
  const bedOpenRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [bedOpen, setBedOpen] = useState(false);
  const pickRef = useRef({ onPick, onClose });
  pickRef.current = { onPick, onClose };

  const names = useMemo(() => new Map(worktrees.map((w) => [w.path, w.name || w.branch || w.path.split("/").pop() || w.path])), [worktrees]);

  // 세션이 바뀌면 사람을 다시 맞춘다. 상태가 그대로여도 1초마다 다시 맞춰 도구 시간 · 빠르기를 새로 센다
  useEffect(() => {
    const { agents, oops } = feedRef.current.build(Object.values(sessions), names, now);
    agentsRef.current = agents;
    simRef.current.sync(agents, Date.now());
    for (const k of oops) simRef.current.oops(k, Date.now());
  }, [sessions, names, now]);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (bedToggle) setBedOpen((o) => !o);
  }, [bedToggle]);
  useEffect(() => {
    bedOpenRef.current = bedOpen;
  }, [bedOpen]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let views: Views;
    let bg: HTMLCanvasElement;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
      // 화면 크기에 맞춰 지도를 다시 만들었으면, 사람들도 새 지도에 제자리로 다시 놓는다
      if (configureMap(canvas.clientWidth / TILE_PX, canvas.clientHeight / TILE_PX)) {
        simRef.current = new Sim();
        simRef.current.sync(agentsRef.current, Date.now());
      }
      views = computeViews(canvas.clientWidth, canvas.clientHeight);
      bg = renderBackground(views.main);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      simRef.current.update(dt);
      drawFrame(ctx, bg, views, bedOpenRef.current, simRef.current, feedRef.current, Date.now(), hoverRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const pick = (ev: MouseEvent): string | null => {
      const r = canvas.getBoundingClientRect();
      const sx = ev.clientX - r.left;
      const sy = ev.clientY - r.top;
      const p = views.panel;
      const inPanel = bedOpenRef.current && sx >= p.x && sx <= p.x + p.w && sy >= p.y && sy <= p.y + p.h;
      const v = inPanel ? views.bed : views.main;
      const x = (sx - v.ox) / v.scale;
      const y = (sy - v.oy) / v.scale;
      const list = [...simRef.current.avatars.values()].reverse();
      for (const av of list) {
        if (av.mode === "exit" || inPanel !== av.x < OFFICE_X0) continue;
        const h = av.hit;
        if (h && x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return av.key;
      }
      return null;
    };
    const onMove = (ev: MouseEvent) => {
      hoverRef.current = pick(ev);
      canvas.style.cursor = hoverRef.current ? "pointer" : "default";
    };
    const onClick = (ev: MouseEvent) => {
      const k = pick(ev);
      if (k) pickRef.current.onPick(Number(k.slice(2)));
      else pickRef.current.onClose();
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
    };
  }, []);

  const people = agentsRef.current;
  const working = people.filter(isWorking).length;
  const d = new Date(now);

  return (
    <div data-browser-cover className="fixed inset-0 z-[80] bg-[#07090d] font-[Pretendard,'Apple_SD_Gothic_Neo',-apple-system,'Segoe_UI',sans-serif] text-[13px] text-[#e8eef7] select-none">
      <canvas ref={canvasRef} className="absolute inset-0 block size-full" />
      <div className="pointer-events-none absolute top-3 left-3.5 flex items-center gap-2.5 rounded-full border border-[#1c2533] bg-[rgba(10,13,20,0.78)] px-3.5 py-1.5 backdrop-blur-sm">
        <span className="size-[9px] flex-none animate-pulse rounded-full bg-[#7cf2c8]" />
        <span className="font-mono text-[15px] font-bold tabular-nums">{clock(now)}</span>
        <span className="text-xs text-[#6b7a90]">
          {d.getMonth() + 1}/{d.getDate()} {"일월화수목금토"[d.getDay()]}
        </span>
        <span className="h-3.5 w-px bg-[#2a3546]" />
        <span className="text-xs font-bold text-[#7cf2c8]">운동 중 {working}</span>
        <button
          className={`pointer-events-auto rounded-full border px-2.5 py-0.5 text-xs ${bedOpen ? "border-[#6a4f86] bg-[#3b2d48] text-[#e8eef7]" : "border-[#2a3546] text-[#a9b6c8]"}`}
          onClick={() => setBedOpen((o) => !o)}
          title="숙소 펼치기 / 접기 (B)"
        >
          🛏 숙소 {people.length - working}
        </button>
      </div>
      <div className="pointer-events-none absolute right-3.5 bottom-3 rounded-full border border-[#1c2533] bg-[rgba(10,13,20,0.78)] px-3 py-1 text-xs text-[#6b7a90]">
        {locked ? "🔒 잠겨 있어요 · 아무 키나 누르면 암호를 물어요" : "아무 키나 누르면 닫혀요 · 사람을 누르면 그 칸으로 가요"}
      </div>
      {children}
    </div>
  );
}
