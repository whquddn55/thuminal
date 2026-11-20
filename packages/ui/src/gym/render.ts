// Canvas 2D 로 월드를 그린다. 배경은 한 번만 그려 두고, 매 프레임 아바타 · 말풍선만 그린다.

import { drawBenchPress, drawFront, drawSprawlTop, poseArmsUp, poseCrouch, poseFlex, poseHop, poseLand, poseStand, RIG_K, RIG_TOP, handPos, shadow } from "./rig";
import { BENCH_L, DOOR, DOORWAYS, H, LEAD_BENCH_L, PARTITION_X, T, W, WORLD_H, WORLD_W, beds, decor, type Bed, type MateSeat, type Pod } from "./map";
import { SELFIE_SHOT, type Avatar } from "./sim";

export interface View {
  scale: number; // 논리 px → CSS px
  ox: number; // CSS px
  oy: number;
  dpr: number;
}

export interface Look {
  shirt: string;
  hair: string;
  skin: string;
  accent?: { kind: "cap" | "band"; color: string };
  scale: number;
}

export interface Status {
  text: string;
  tone: "work" | "think" | "walk" | "rest";
}

const FONT = 'Pretendard, "Apple SD Gothic Neo", -apple-system, sans-serif';

type Ctx = CanvasRenderingContext2D;

function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
}

function glow(ctx: Ctx, x: number, y: number, r: number, color: string) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

// 같은 입력이면 같은 값 (바닥 무늬용)
function noise(i: number): number {
  const s = Math.sin(i * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

// ── 배경 ─────────────────────────────────────────────

export function drawBackground(ctx: Ctx) {
  rect(ctx, 0, 0, WORLD_W, WORLD_H, "#0b0e14");

  // 숙소 바닥: 나무 판자
  const bx0 = T;
  const bx1 = PARTITION_X * T;
  for (let y = 2 * T, row = 0; y < (H - 1) * T; y += 12, row++) {
    rect(ctx, bx0, y, bx1 - bx0, 12, row % 2 ? "#3a2a21" : "#35261e");
    let x = bx0 + noise(row) * 60;
    while (x < bx1) {
      rect(ctx, x, y, 1, 12, "#2a1e17");
      x += 50 + noise(row * 7 + x) * 40;
    }
  }
  // 헬스장 바닥: 고무 매트 (두 칸씩 이음매, 고무 알갱이 점)
  for (let ty = 2; ty < H - 1; ty++) {
    for (let tx = PARTITION_X + 1; tx < W - 1; tx++) {
      rect(ctx, tx * T, ty * T, T, T, (Math.floor(tx / 2) + Math.floor(ty / 2)) % 2 ? "#1c1f26" : "#1a1d23");
      if (tx % 2 === 0) rect(ctx, tx * T, ty * T, 1, T, "#262a33");
      if (ty % 2 === 0) rect(ctx, tx * T, ty * T, T, 1, "#262a33");
      for (let i = 0; i < 3; i++) rect(ctx, tx * T + noise(tx * 31 + ty * 7 + i) * T, ty * T + noise(tx * 13 + ty * 17 + i) * T, 1, 1, "#2c313b");
    }
  }
  // 문턱
  for (const y of DOORWAYS) rect(ctx, PARTITION_X * T, y * T, T, T, "#2c2620");

  // 위쪽 벽 (윗면 + 앞면) 과 창문
  rect(ctx, 0, 0, WORLD_W, T, "#121620");
  rect(ctx, 0, T, WORLD_W, T, "#283041");
  rect(ctx, 0, 2 * T - 3, WORLD_W, 3, "#1b2130");
  // 헬스장 벽: 대형 거울이 벽을 따라 이어진다 (오운완 셀카 찍는 곳)
  for (let x = PARTITION_X + 1; x < W - 1; x += 4) {
    const mx = x * T + 2;
    const mw = Math.min(4, W - 1 - x) * T - 4;
    const my = T + 2;
    const g = ctx.createLinearGradient(mx, my, mx + mw, my + T);
    g.addColorStop(0, "#6f7c90");
    g.addColorStop(0.5, "#aab6c8");
    g.addColorStop(1, "#5d697c");
    rr(ctx, mx - 1, my - 1, mw + 2, T - 2, 2, "#8a94a6");
    ctx.fillStyle = g;
    ctx.fillRect(mx, my, mw, T - 4);
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.moveTo(mx + mw * 0.2, my);
    ctx.lineTo(mx + mw * 0.32, my);
    ctx.lineTo(mx + mw * 0.22, my + T - 4);
    ctx.lineTo(mx + mw * 0.1, my + T - 4);
    ctx.fill();
  }
  for (let x = 2; x < PARTITION_X - 1; x += 6) {
    const wx = x * T;
    const wy = T + 3;
    const g = ctx.createLinearGradient(0, wy, 0, wy + T - 8);
    g.addColorStop(0, "#0f1a33");
    g.addColorStop(1, "#203457");
    rr(ctx, wx, wy, T * 2, T - 8, 2, "#3a4458");
    ctx.fillStyle = g;
    ctx.fillRect(wx + 2, wy + 2, T * 2 - 4, T - 12);
    rect(ctx, wx + T - 1, wy + 2, 2, T - 12, "#3a4458");
    for (let i = 0; i < 3; i++) rect(ctx, wx + 4 + noise(x + i) * 38, wy + 3 + noise(x * 3 + i) * 8, 1, 1, "#cfe0ff");
  }
  // 숙소 창 하나엔 달
  glow(ctx, 9 * T, T + 8, 14, "rgba(255,240,200,0.35)");
  rr(ctx, 9 * T - 4, T + 4, 8, 8, 4, "#fff4d6");

  // 옆 벽 · 아래 벽 · 칸막이
  rect(ctx, 0, 0, T, WORLD_H, "#121620");
  rect(ctx, (W - 1) * T, 0, T, WORLD_H, "#121620");
  rect(ctx, 0, (H - 1) * T, WORLD_W, T, "#121620");
  rect(ctx, PARTITION_X * T + 4, 2 * T, T - 8, (H - 3) * T, "#283041");
  for (const y of DOORWAYS) rect(ctx, PARTITION_X * T + 2, y * T, T - 4, T, "#2c2620");
  // 출입문
  rect(ctx, DOOR.ax * T, DOOR.ay * T, 2 * T, T, "#1d2430");
  rr(ctx, DOOR.ax * T + 4, DOOR.ay * T - 6, 2 * T - 8, 10, 2, "#5a4632");
  rect(ctx, DOOR.ax * T - 3, DOOR.ay * T, 3, T, "#3a4458");
  rect(ctx, (DOOR.ax + 2) * T, DOOR.ay * T, 3, T, "#3a4458");

  for (const b of beds) drawBed(ctx, b);
  for (const d of decor) drawPlant(ctx, d.x * T, d.y * T);

  // 방 이름
  ctx.font = `700 15px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  ctx.fillText("숙소", 1.3 * T, (H - 2) * T + 12);
  ctx.fillText("헬스장", (PARTITION_X + 2.4) * T, 3 * T - 4);

  // 숙소는 밤처럼 어둡게, 스탠드 불빛만
  ctx.fillStyle = "rgba(6, 8, 26, 0.30)";
  ctx.fillRect(T, 2 * T, (PARTITION_X - 1) * T, (H - 3) * T);
  ctx.globalCompositeOperation = "lighter";
  for (const y of [5, 13, 21]) glow(ctx, 5 * T, y * T + 12, 70, "rgba(255,170,90,0.10)");
  ctx.globalCompositeOperation = "source-over";
}

function drawBed(ctx: Ctx, b: Bed) {
  const x = b.x * T;
  const y = b.y * T;
  const w = b.w * T;
  const h = b.h * T;
  rr(ctx, x + 2, y + 2, w - 4, h - 3, 4, "#6b4a35");
  rr(ctx, x + 2, y + 1, w - 4, 7, 3, "#4e3526");
  rr(ctx, x + 5, y + 8, w - 10, h - 13, 3, "#cfd6e0");
  rr(ctx, x + 10, y + 10, w - 20, 9, 3, "#f5f7fb");
  rr(ctx, x + 5, y + 26, w - 10, h - 32, 3, "#4a5468");
  rect(ctx, x + 5, y + 26, w - 10, 4, "#5b667d");
}

function drawPlant(ctx: Ctx, x: number, y: number) {
  rr(ctx, x + 6, y + 12, 12, 10, 2, "#7a4b32");
  for (const [dx, dy, r, c] of [
    [12, 9, 7, "#2a9466"],
    [8, 6, 5, "#36c285"],
    [16, 5, 5, "#3ddc97"],
    [12, 2, 4, "#5ce8ad"],
  ] as const) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 팀장 벤치 머리 쪽 끝 가운데 (팀원 벤치를 팀장 크기로 키운 것)
export function leadBenchHead(p: Pod): { x: number; y: number } {
  return { x: p.cx * T + T / 2, y: p.y0 * T - 2 };
}

// 팀장 벤치: 포드에 세로로 놓인 큰 벤치와 머리 쪽 양옆 거치대. bar 면 바벨이 거치대에 걸려 있다 (팀장이 들고 있지 않을 때)
export function drawLeadBench(ctx: Ctx, p: Pod, bar: boolean) {
  const { x, y } = leadBenchHead(p);
  for (const s of [-1, 1]) {
    rect(ctx, x + s * 22 - 2, y - 16, 4, 30, "#4a5262");
    rect(ctx, x + s * 22 - 2, y - 16, 4, 2, "#6b7486");
  }
  rect(ctx, x - 12, y + LEAD_BENCH_L - 8, 4, 10, "#3a3f4b");
  rect(ctx, x + 8, y + LEAD_BENCH_L - 8, 4, 10, "#3a3f4b");
  rr(ctx, x - 12, y, 24, LEAD_BENCH_L, 5, "#7a2a2a");
  rect(ctx, x - 12, y + 1, 24, 3, "#9a3a3a");
  if (bar) drawBarbell(ctx, x, y - 12, 30, 1);
}

// 팀장: 큰 벤치에 누워 팀원과 똑같이 체스트 프레스. 바쁠수록 (speed: 1 초에 몇 번) 빨리 든다
export function drawLeadPresser(ctx: Ctx, p: Pod, look: Look, phase: number, working: boolean, speed: number) {
  const h = leadBenchHead(p);
  const press = working ? (1 - Math.cos(phase * speed * Math.PI * 2)) / 2 : 0.9;
  drawBenchPress(ctx, h.x, h.y, look, press, working ? 0.3 + (1 - press) * 0.6 : 0.2);
}

// 바벨: 가운데 (cx, y), 반쪽 길이 half. k 는 크기 (1 이면 팀장 바벨)
export function drawBarbell(ctx: Ctx, cx: number, y: number, half: number, k: number) {
  rect(ctx, cx - half, y - 1, half * 2, 2.5, "#cfd6e0");
  for (const sx of [-1, 1]) {
    const px = cx + sx * (half - 6 * k);
    rr(ctx, px - 3 * k, y - 8 * k, 6 * k, 16 * k, 1.5, "#222831");
    rr(ctx, px - 3 * k + (sx < 0 ? -4 * k : 5 * k), y - 6 * k, 3 * k, 12 * k, 1, "#c53030");
  }
}

// 팀원 벤치 머리 쪽 끝 가운데 (팀원이 누워 벤치프레스하는 자리). 탑에 쌓인 층이면 drop 만큼 아래로 비켜 놓는다
export function benchHead(seat: MateSeat): { x: number; y: number } {
  return { x: seat.x * T + T / 2, y: seat.y * T + seat.drop + 2 };
}

// 팀원 벤치 (팀원이 운동하는 동안 놓인다): 자리 칸에서 아래로 세로로 놓인 패드, 머리 쪽 양옆에 바벨 거치대
export function drawBench(ctx: Ctx, seat: MateSeat) {
  const { x, y } = benchHead(seat);
  for (const s of [-1, 1]) {
    rect(ctx, x + s * 15 - 1.5, y - 12, 3, 22, "#4a5262");
    rect(ctx, x + s * 15 - 1.5, y - 12, 3, 2, "#6b7486");
  }
  rect(ctx, x - 9, y + BENCH_L - 6, 3, 8, "#3a3f4b");
  rect(ctx, x + 6, y + BENCH_L - 6, 3, 8, "#3a3f4b");
  rr(ctx, x - 9, y, 18, BENCH_L, 4, "#7a2a2a");
  rect(ctx, x - 9, y + 1, 18, 2, "#9a3a3a");
}

// 쉬는 팀원이 대자로 뻗는 자리: 벤치 바깥쪽 옆 바닥 (세로 벤치 앞쪽은 다음 줄 벤치라 옆으로 비킨다)
export function benchFront(seat: MateSeat): { x: number; y: number } {
  const h = benchHead(seat);
  return { x: h.x + (seat.side === "left" ? -32 : 32), y: h.y + BENCH_L / 2 };
}

// 들고 가는 · 던지는 장비. big 이면 팀장 바벨, 아니면 팀원 벤치
export function drawCarriedDesk(ctx: Ctx, x: number, topY: number, big = false) {
  if (big) {
    drawBarbell(ctx, x, topY - 4, 28, 1);
    return;
  }
  rect(ctx, x - 10, topY - 2, 2, 6, "#3a3f4b");
  rect(ctx, x + 8, topY - 2, 2, 6, "#3a3f4b");
  rr(ctx, x - 14, topY - 8, 28, 7, 3, "#7a2a2a");
  rect(ctx, x - 14, topY - 8, 28, 2, "#9a3a3a");
}

// ── 사람 ─────────────────────────────────────────────


// (x, y) 는 발밑. 걷기 · 서 있기
// 사람 그림은 근육 관절 리그 (rig.ts) 로 그린다. 아래 함수들은 자세만 골라 넘긴다

// 서 있기 · 걷기 · 장비 머리 위로 들기 (armsUp). 위를 보고 걸으면 뒷모습. shadow 를 끄면 발밑 그림자를 그리지 않는다
export function drawPerson(ctx: Ctx, x: number, y: number, look: Look, dir: Avatar["dir"], walking: boolean, phase: number, armsUp = false, withShadow = true) {
  if (withShadow) shadow(ctx, x, y, look);
  const p = armsUp ? poseArmsUp() : poseStand(phase, walking);
  drawFront(ctx, x, y, look, { ...p, back: dir === "up" });
}

// 나는 사람: 땅에는 높이만큼 작아지는 그림자, 지나온 자리에 속도선과 잔상, 몸은 z 만큼 위에서 두 팔을 머리 위로 뻗고
// 나는 쪽으로 기울어 (tilt) 길게 늘어난다
export function drawFlyer(ctx: Ctx, x: number, y: number, z: number, look: Look, dir: Avatar["dir"], phase: number, tilt: number, trail: { x: number; y: number }[]) {
  void dir;
  void phase;
  shadow(ctx, x, y, look, Math.max(0.3, 1 - z / 180));
  const mid = (RIG_TOP / 2) * RIG_K * look.scale; // 몸 가운데 (발에서 위로)
  const body = (bx: number, by: number) => {
    ctx.save();
    ctx.translate(bx, by - mid);
    ctx.rotate(tilt);
    ctx.scale(0.88, 1.18);
    ctx.translate(0, mid);
    drawFront(ctx, 0, 0, look, { ...poseArmsUp(), pump: 0.7 });
    ctx.restore();
  };
  // 속도선: 지나온 길을 따라 몸 양옆으로 흐리게
  if (trail.length > 2) {
    const nx = Math.cos(tilt) * 8;
    const ny = Math.sin(tilt) * 8;
    ctx.lineCap = "round";
    for (const [o, w] of [[-1, 1.2], [0, 2], [1, 1.2]] as const) {
      ctx.strokeStyle = "rgba(235,240,255,0.32)";
      ctx.lineWidth = w;
      ctx.beginPath();
      trail.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, p.x + nx * o, p.y - mid + ny * o));
      ctx.stroke();
    }
  }
  // 잔상 두 개
  for (const [i, a] of [[trail.length - 5, 0.16], [trail.length - 3, 0.3]] as const) {
    const p = trail[i];
    if (!p) continue;
    ctx.globalAlpha = a;
    body(p.x, p.y);
  }
  ctx.globalAlpha = 1;
  body(x, y - z);
}

// 뛰기 직전: 무릎을 굽혀 점점 낮게 움츠리며 힘을 모아 부르르 떤다 (t: 0 → 1)
export function drawCrouch(ctx: Ctx, x: number, y: number, look: Look, dir: Avatar["dir"], phase: number, t: number) {
  void dir;
  const shiver = Math.sin(phase * 70) * 1.2 * t;
  shadow(ctx, x, y, look);
  drawFront(ctx, x + shiver, y, look, poseCrouch(t));
}

// 히어로 착지 (t: 0 → 1). 내리꽂힌 순간 납작하게 눌렸다가, 한동안 자세를 버티고, 끝 무렵에 일어선다
export function drawLander(ctx: Ctx, x: number, y: number, look: Look, t: number) {
  const hit = Math.max(0, 1 - t / 0.12);
  shadow(ctx, x, y, look, 1.25);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1 + 0.22 * hit, 1 - 0.28 * hit);
  drawFront(ctx, 0, 0, look, poseLand(t));
  ctx.restore();
}

// 침대에 누워 자는 모습. 이불은 셔츠 색
export function drawSleeper(ctx: Ctx, bed: Bed, look: Look, phase: number) {
  const x = bed.x * T;
  const y = bed.y * T;
  const w = bed.w * T;
  const h = bed.h * T;
  const cx = x + w / 2;
  const breath = Math.sin(phase * 1.6) * 0.8;
  rr(ctx, cx - 7, y + 7, 14, 13, 5, look.skin);
  rr(ctx, cx - 7.5, y + 6, 15, 6, 3, look.hair);
  rect(ctx, cx - 4.5, y + 15, 3, 1.2, "#3a2a20");
  rect(ctx, cx + 1.5, y + 15, 3, 1.2, "#3a2a20");
  if (look.accent?.kind === "band") rect(ctx, cx - 7.5, y + 11, 15, 2, look.accent.color);
  rr(ctx, x + 5, y + 21 - breath, w - 10, h - 27 + breath, 4, look.shirt);
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(x + 5, y + 21 - breath, w - 10, 4);
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.fillRect(x + w / 2 - 0.5, y + 27, 1, h - 34);
}

// 던진 책상: 땅에 그림자, 그 위 z 높이에서 한 바퀴 휙 돌고 (k: 0 → 1) 내려앉을 때는 반듯해진다
export function drawFlyingDesk(ctx: Ctx, x: number, y: number, z: number, big: boolean, spin: number, k: number) {
  const sh = Math.max(0.35, 1 - z / 200);
  ctx.fillStyle = `rgba(0,0,0,${0.28 * sh})`;
  ctx.beginPath();
  ctx.ellipse(x, y + 4, (big ? 26 : 14) * sh, 4 * sh, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(x, y - z);
  ctx.rotate((spin < 0 ? -1 : 1) * Math.PI * 2 * (1 - (1 - k) ** 2));
  drawCarriedDesk(ctx, 0, 6, big);
  ctx.restore();
}

// 쿵: 바닥에 납작한 고리가 빠르게 퍼지고, 고리 둘레로 짧은 충격선이 튀어 나간다 (k: 0 → 1)
export function drawShockwave(ctx: Ctx, x: number, y: number, r: number, k: number) {
  const e = 1 - (1 - k) ** 3;
  const a = 1 - k;
  ctx.strokeStyle = `rgba(245,238,222,${0.75 * a})`;
  ctx.lineWidth = 3 * a + 0.5;
  ctx.beginPath();
  ctx.ellipse(x, y, r * e, r * e * 0.32, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineCap = "round";
  ctx.lineWidth = 2 * a + 0.5;
  for (let i = 0; i < 10; i++) {
    const ang = (Math.PI * 2 * i) / 10 + 0.3;
    const c = Math.cos(ang);
    const sn = Math.sin(ang) * 0.4;
    const r0 = r * (0.55 + 0.5 * e);
    const r1 = r0 + r * 0.35 * a;
    ctx.beginPath();
    ctx.moveTo(x + c * r0, y + sn * r0);
    ctx.lineTo(x + c * r1, y + sn * r1);
    ctx.stroke();
  }
}

// 팀원: 세로 벤치에 누워 벤치프레스 (seat: 벤치 자리). 바쁠수록 (speed: 1 초에 몇 번) 빨리 든다
export function drawBencher(ctx: Ctx, seat: MateSeat, look: Look, phase: number, working: boolean, speed: number) {
  const h = benchHead(seat);
  const press = working ? (1 - Math.cos(phase * speed * Math.PI * 2)) / 2 : 0.9;
  drawBenchPress(ctx, h.x, h.y, look, press, working ? 0.3 + (1 - press) * 0.6 : 0.2);
}

// 쉬는 중: 바닥에 대자로 뻗는다 (위에서 본 모습)
export function drawSprawl(ctx: Ctx, x: number, y: number, look: Look, phase: number) {
  drawSprawlTop(ctx, x, y, look, (Math.sin(phase * 2) + 1) / 2);
}

// 도구 오류: 바벨을 발등에 떨어뜨려 한 발을 붙잡고 깡충깡충 뛴다 (t: 0 → 1). 머리 위로 별이 돈다
export function drawOops(ctx: Ctx, x: number, y: number, look: Look, t: number) {
  drawBarbell(ctx, x + 12, y + 6, 13, 0.6);
  shadow(ctx, x - 4, y + 7, look);
  const p = poseHop(t * 1.6);
  drawFront(ctx, x - 4, y + 7, look, p);
  const u = RIG_K * look.scale;
  const hy = y + 7 + (-RIG_TOP - 2 + (p.drop ?? 0)) * u;
  ctx.fillStyle = "#ffe066";
  for (let i = 0; i < 3; i++) {
    const a = t * 12 + (i * Math.PI * 2) / 3;
    ctx.fillRect(x - 4 + Math.cos(a) * 10, hy + Math.sin(a) * 3, 2.4, 2.4);
  }
}

// 오운완 셀카: 거울 쪽 (위) 을 보고 서서 더블 바이셉스, 오른손에 폰. 찍을 때마다 플래시 (t: 초)
export function drawSelfie(ctx: Ctx, x: number, y: number, look: Look, t: number) {
  const fy = y + 7;
  // 한 장 (SELFIE_SHOT 초) 마다 포즈를 바꾼다: 백 더블 바이셉스 → 한 팔 플렉스 → 랫 스프레드
  const n = Math.min(2, Math.floor(t / SELFIE_SHOT));
  const lt = t - n * SELFIE_SHOT;
  const p = poseFlex(n, lt);
  shadow(ctx, x, fy, look);
  drawFront(ctx, x, fy, look, p);
  // 포즈를 잡고 잠깐 뒤 오른손 폰에서 찰칵 (플래시)
  const u = RIG_K * look.scale;
  const h = handPos(p.arms[1]);
  const f = (lt - 0.4) / 0.25;
  if (f >= 0 && f < 1) glow(ctx, x + h.x * u, fy + (h.y - 2) * u, 30, `rgba(255,255,255,${0.9 * (1 - f)})`);
}

// 서브에이전트 드론: 쿼드콥터. X 자 몸체에 팔 4개, 팔 끝마다 돌아가는 프로펠러, 몸체 앞에 카메라와 에이전트 색 LED.
// 살짝 오르내리고, 아래 바닥에 흐린 그림자가 진다. small 이면 서브의 서브
export function drawDrone(ctx: Ctx, x: number, y: number, color: string, phase: number, small: boolean) {
  const s = small ? 0.5 : 0.8;
  const hover = Math.sin(phase * 3) * 0.5 * s; // 아주 살짝만 떠 있는 티를 낸다
  // 바닥 그림자 (떠 있는 높이만큼 아래)
  ctx.fillStyle = "rgba(0,0,0,0.13)";
  ctx.beginPath();
  ctx.ellipse(x, y + 16 * s, 9 * s, 2.6 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.translate(x, y + hover);
  ctx.scale(s, s);
  const arms: [number, number][] = [
    [-8, -4],
    [8, -4],
    [-8, 4],
    [8, 4],
  ];
  // 팔
  ctx.strokeStyle = "#3a4252";
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  for (const [ax, ay] of arms) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(ax, ay);
    ctx.stroke();
  }
  // 프로펠러: 흐린 원판 + 도는 날개 두 장
  arms.forEach(([ax, ay], i) => {
    ctx.fillStyle = "rgba(220,232,255,0.16)";
    ctx.beginPath();
    ctx.ellipse(ax, ay - 1, 5.2, 2.2, 0, 0, Math.PI * 2);
    ctx.fill();
    const a = phase * 42 * (i % 2 ? -1 : 1) + i;
    ctx.strokeStyle = "rgba(235,242,255,0.75)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ax - Math.cos(a) * 4.8, ay - 1 - Math.sin(a) * 2);
    ctx.lineTo(ax + Math.cos(a) * 4.8, ay - 1 + Math.sin(a) * 2);
    ctx.stroke();
    rr(ctx, ax - 1.3, ay - 2.2, 2.6, 2.6, 1, "#20252f");
  });
  // 몸체
  rr(ctx, -5, -3.2, 10, 6.4, 2.4, "#2b313d");
  rr(ctx, -3.6, -2.4, 7.2, 3, 1.4, "#3d4657");
  // 카메라 (앞쪽 아래)
  ctx.fillStyle = "#11141a";
  ctx.beginPath();
  ctx.arc(0, 3.2, 1.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(140,200,255,0.8)";
  ctx.beginPath();
  ctx.arc(0.4, 2.9, 0.6, 0, Math.PI * 2);
  ctx.fill();
  // LED: 에이전트 색, 깜빡인다
  const on = Math.sin(phase * 5) > -0.3;
  ctx.fillStyle = on ? color : "#3a4252";
  ctx.beginPath();
  ctx.arc(0, -1, 1.5, 0, Math.PI * 2);
  ctx.fill();
  if (on) {
    ctx.restore();
    glow(ctx, x, y + hover - 1 * s, 7 * s, "rgba(255,255,255,0.12)");
    return;
  }
  ctx.restore();
}

// ── 머리 위 말풍선 · 이름표 ───────────────────────────

export function drawBubble(ctx: Ctx, x: number, y: number, st: Status, color: string, phase: number) {
  ctx.font = `600 11px ${FONT}`;
  ctx.textBaseline = "middle";
  const dots = st.tone === "think" ? ".".repeat(1 + (Math.floor(phase * 3) % 3)) : "";
  const text = st.text + dots;
  const tw = ctx.measureText(st.text + "...").width;
  const pad = st.tone === "walk" || st.tone === "rest" ? 7 : 17;
  const w = tw + pad + 8;
  const h = 19;
  const bx = x - w / 2;
  const by = y - h - 5;
  const bg = st.tone === "walk" || st.tone === "rest" ? "rgba(30,36,50,0.88)" : "rgba(244,247,252,0.96)";
  rr(ctx, bx, by, w, h, 9, bg);
  ctx.beginPath();
  ctx.moveTo(x - 3.5, by + h - 0.5);
  ctx.lineTo(x + 3.5, by + h - 0.5);
  ctx.lineTo(x, by + h + 4);
  ctx.closePath();
  ctx.fill();
  if (pad > 6) {
    // 빙글 도는 점
    const r = 3;
    const a = phase * 7;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(bx + 10, by + h / 2, r + 0.8, a, a + Math.PI * 1.4);
    ctx.stroke();
  }
  ctx.fillStyle = st.tone === "walk" || st.tone === "rest" ? "#c9d3e2" : "#121722";
  ctx.fillText(text, bx + pad, by + h / 2 + 0.5);
}

export function drawZzz(ctx: Ctx, x: number, y: number, phase: number) {
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i < 3; i++) {
    const t = (phase * 0.45 + i / 3) % 1;
    ctx.globalAlpha = Math.sin(t * Math.PI) * 0.9;
    ctx.font = `700 ${7 + t * 6}px ${FONT}`;
    ctx.fillStyle = "#cfe0ff";
    ctx.fillText("z", x + t * 12, y - t * 20);
  }
  ctx.globalAlpha = 1;
}

// 이름이 길면 자르지 않고 줄을 바꾼다 (띄어쓰기 단위, 한 낱말이 폭보다 길면 글자 단위)
const LABEL_MAX_W = 120;
const LABEL_LINE_H = 12;

function wrapText(ctx: Ctx, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = (piece: string) => {
    const next = line ? `${line} ${piece}` : piece;
    if (ctx.measureText(next).width <= maxW) {
      line = next;
      return;
    }
    if (line) lines.push(line);
    line = "";
    // 낱말 하나가 폭보다 길면 글자 단위로 끊는다
    let cur = "";
    for (const ch of piece) {
      if (cur && ctx.measureText(cur + ch).width > maxW) {
        lines.push(cur);
        cur = "";
      }
      cur += ch;
    }
    line = cur;
  };
  for (const word of text.split(/\s+/).filter(Boolean)) push(word);
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

// anchor 가 "bottom" 이면 y 가 이름표 아래 끝 (머리 위에 얹을 때). size 는 글자 크기(px). 이름표 위 끝 y 를 돌려준다
export function drawLabel(ctx: Ctx, x: number, y0: number, text: string, color: string, dim: boolean, anchor: "top" | "bottom" = "top", size = 10, maxW?: number): number {
  const k = size / 10;
  ctx.font = `600 ${size}px ${FONT}`;
  ctx.textBaseline = "middle";
  const lines = wrapText(ctx, text, maxW ?? LABEL_MAX_W * k);
  const lineH = LABEL_LINE_H * k;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12 * k;
  const h = lines.length * lineH + 3 * k;
  const y = anchor === "bottom" ? y0 - h : y0;
  rr(ctx, x - w / 2, y, w, h, 7 * k, dim ? "rgba(10,13,20,0.55)" : "rgba(10,13,20,0.85)");
  ctx.fillStyle = color;
  ctx.globalAlpha = dim ? 0.75 : 1;
  ctx.textAlign = "center";
  lines.forEach((l, i) => ctx.fillText(l, x, y + 2 * k + lineH * i + lineH / 2));
  ctx.textAlign = "left";
  ctx.globalAlpha = 1;
  return y;
}

export function drawRing(ctx: Ctx, x: number, y: number, color: string, phase: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.6 + Math.sin(phase * 5) * 0.3;
  ctx.beginPath();
  ctx.ellipse(x, y, 11, 4.5, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
