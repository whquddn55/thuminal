// 근육 캐릭터 관절 리그. 몸을 머리 · 몸통 · 위팔 · 아래팔 · 허벅지 · 정강이로 나누고 관절 각도로 자세를 만든다.
// 근육 (어깨 · 이두 · 가슴 · 허벅지) 은 부풀린 타원이고 pump (0 → 1) 만큼 더 부푼다. 큰 어깨 · V 자 몸통 · 짧은 다리로 과장한다.
//
// 좌표: 발 가운데가 (0, 0), 위가 음수. 단위 하나 = RIG_K × look.scale px.
// 각도: 팔 · 다리 모두 "아래로 곧게" 가 0, 바깥쪽으로 들수록 커져 π 면 위로 곧게 (왼쪽 팔다리는 좌우를 뒤집어 같은 값을 쓴다).

export type Ctx = CanvasRenderingContext2D;

export interface Body {
  shirt: string;
  hair: string;
  skin: string;
  scale: number;
}

export const RIG_K = 1.4; // 예전 블록 인형보다 크게
export const RIG_TOP = 30; // 서 있을 때 발에서 머리 꼭대기까지 (단위)

export interface Limb {
  u: number; // 위팔 · 허벅지 각도
  f: number; // 아래팔 · 정강이 각도 (몸 기준이 아니라 화면 기준)
}

export interface FrontPose {
  arms: [Limb, Limb]; // 왼쪽, 오른쪽
  legs: [Limb, Limb];
  drop?: number; // 몸을 내린 높이 (착지 · 움츠리기, 단위)
  pump?: number; // 근육 부풀림
  mouth?: number; // 입 벌림 (소리치기 · 아픔)
  back?: boolean; // 뒷모습 (거울을 볼 때)
  phone?: boolean; // 오른손에 폰 (셀카)
  squint?: boolean; // 질끈 감은 눈 (아픔)
  lats?: number; // 등을 넓게 편 정도 (랫 스프레드, 뒷모습)
}

const PANTS = "#252c3a";
const SHOE = "#15181e";

function dir(s: number, a: number): [number, number] {
  return [s * Math.sin(a), Math.cos(a)];
}

function darker(hex: string, k = 0.82): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = (v: number) => Math.round(v * k);
  return `rgb(${c((n >> 16) & 255)},${c((n >> 8) & 255)},${c(n & 255)})`;
}

// 굵기가 a → b 로 줄어드는 둥근 막대
function capsule(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, a: number, b: number, color: string) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 0.001;
  const nx = -dy / len;
  const ny = dx / len;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1 + nx * a, y1 + ny * a);
  ctx.lineTo(x2 + nx * b, y2 + ny * b);
  ctx.lineTo(x2 - nx * b, y2 - ny * b);
  ctx.lineTo(x1 - nx * a, y1 - ny * a);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x1, y1, a, 0, Math.PI * 2);
  ctx.arc(x2, y2, b, 0, Math.PI * 2);
  ctx.fill();
}

function oval(ctx: Ctx, x: number, y: number, rx: number, ry: number, rot: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2);
  ctx.fill();
}

// 팔 하나: 어깨 (sx, sy) 에서 위팔 → 팔꿈치 → 아래팔 → 주먹. 이두는 위팔 가운데에서 아래팔 쪽으로 부푼다
function arm(ctx: Ctx, b: Body, s: number, sx: number, sy: number, l: Limb, pump: number, phone: boolean) {
  const [ux, uy] = dir(s, l.u);
  const ex = sx + ux * 5.6;
  const ey = sy + uy * 5.6;
  const [fx, fy] = dir(s, l.f);
  const hx = ex + fx * 5.2;
  const hy = ey + fy * 5.2;
  capsule(ctx, sx, sy, ex, ey, 1.9, 1.5, b.skin);
  // 팔꿈치가 많이 굽을수록 이두가 크게 솟는다
  const bend = Math.min(1, Math.abs(Math.sin((l.f - l.u) / 2)) * 1.3);
  const big = 1 + pump * 0.5 + bend * 0.35;
  const mx = (sx + ex) / 2 + fx * 0.9 * bend;
  const my = (sy + ey) / 2 + fy * 0.9 * bend;
  oval(ctx, mx, my, 2.3 * big, 1.6 * big, Math.atan2(uy, ux), b.skin);
  oval(ctx, mx + fx * 0.4, my + fy * 0.4, 1.2 * big, 0.7 * big, Math.atan2(uy, ux), "rgba(255,255,255,0.18)");
  capsule(ctx, ex, ey, hx, hy, 1.5, 1.2, b.skin);
  oval(ctx, hx, hy, 1.6, 1.6, 0, b.skin);
  if (phone) {
    ctx.fillStyle = "#111318";
    ctx.fillRect(hx - 1.3, hy - 4.2, 2.6, 4.4);
  }
}

// 다리 하나: 엉덩이에서 허벅지 (반바지) → 무릎 → 정강이 → 신발
function leg(ctx: Ctx, s: number, hx: number, hy: number, l: Limb, skin: string, pump: number) {
  const [tx, ty] = dir(s, l.u);
  const kx = hx + tx * 5.6;
  const ky = hy + ty * 5.6;
  const [sx, sy] = dir(s, l.f);
  const fx = kx + sx * 5.2;
  const fy = ky + sy * 5.2;
  capsule(ctx, kx, ky, fx, fy, 1.4, 1.1, skin);
  oval(ctx, fx + s * 0.6, fy + 0.3, 1.9, 1.1, 0, SHOE);
  capsule(ctx, hx, hy, kx, ky, 2.4 + pump * 0.3, 1.8, PANTS);
}

// 서 있는 · 움직이는 앞모습 (back 이면 뒷모습). 그림자는 따로 그린다
export function drawFront(ctx: Ctx, x: number, y: number, b: Body, p: FrontPose) {
  const pump = p.pump ?? 0;
  const k = RIG_K * b.scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.translate(0, p.drop ?? 0);
  const hipY = -10.6;
  const neckY = -21.5;
  // 다리 (몸통 뒤)
  leg(ctx, -1, -2.4, hipY, p.legs[0], b.skin, pump);
  leg(ctx, 1, 2.4, hipY, p.legs[1], b.skin, pump);
  const shY = neckY + 1.4;
  // 몸통: 넓은 어깨 → 좁은 허리 (V 자). 민소매라 어깨 · 팔은 살갗
  const sh = darker(b.shirt);
  ctx.fillStyle = b.shirt;
  ctx.beginPath();
  ctx.moveTo(-6.6, neckY + 0.6);
  ctx.quadraticCurveTo(0, neckY - 1.2, 6.6, neckY + 0.6);
  ctx.lineTo(3.6, hipY + 0.6);
  ctx.quadraticCurveTo(0, hipY + 1.6, -3.6, hipY + 0.6);
  ctx.closePath();
  ctx.fill();
  if (p.back) {
    // 랫 스프레드면 등 (광배근) 이 옆으로 날개처럼 펴진다
    const lw = p.lats ?? 0;
    if (lw > 0) {
      ctx.fillStyle = b.shirt;
      ctx.beginPath();
      ctx.moveTo(-6.4, neckY + 1);
      ctx.quadraticCurveTo(-6.4 - lw * 3.2, neckY + 5, -3.8, hipY + 1);
      ctx.lineTo(3.8, hipY + 1);
      ctx.quadraticCurveTo(6.4 + lw * 3.2, neckY + 5, 6.4, neckY + 1);
      ctx.closePath();
      ctx.fill();
    }
    // 광배근 그림자와 척추
    ctx.fillStyle = sh;
    ctx.fillRect(-0.35, neckY + 1, 0.7, 9);
    oval(ctx, -3.2 - lw, neckY + 4, 2.4 + lw, 3.4, 0.3, sh);
    oval(ctx, 3.2 + lw, neckY + 4, 2.4 + lw, 3.4, -0.3, sh);
  } else {
    // 가슴 두 덩어리와 복근 줄
    oval(ctx, -2.5, neckY + 3.2, 2.8 + pump * 0.4, 2 + pump * 0.3, 0.15, sh);
    oval(ctx, 2.5, neckY + 3.2, 2.8 + pump * 0.4, 2 + pump * 0.3, -0.15, sh);
    oval(ctx, -2.5, neckY + 2.8, 2.4, 1.5, 0.15, b.shirt);
    oval(ctx, 2.5, neckY + 2.8, 2.4, 1.5, -0.15, b.shirt);
    ctx.fillStyle = sh;
    for (let i = 0; i < 3; i++) ctx.fillRect(-1.5, neckY + 6.4 + i * 1.3, 3, 0.45);
  }
  // 승모근 · 목
  capsule(ctx, -3, neckY, 3, neckY, 1.3, 1.3, b.skin);
  ctx.fillStyle = b.skin;
  ctx.fillRect(-1.3, neckY - 2.2, 2.6, 2.4);
  // 어깨 (삼각근)
  const del = 2.5 + pump * 0.5;
  oval(ctx, -6.4, shY, del, del * 0.95, 0, b.skin);
  oval(ctx, 6.4, shY, del, del * 0.95, 0, b.skin);
  // 팔
  arm(ctx, b, -1, -6.6, shY + 0.6, p.arms[0], pump, false);
  arm(ctx, b, 1, 6.6, shY + 0.6, p.arms[1], pump, !!p.phone);
  // 머리 (몸에 비해 작게)
  const hy = neckY - 4.6;
  oval(ctx, 0, hy, 3.4, 3.6, 0, b.skin);
  if (p.back) {
    oval(ctx, 0, hy - 0.4, 3.6, 3.6, 0, b.hair);
  } else {
    ctx.fillStyle = b.hair;
    ctx.beginPath();
    ctx.ellipse(0, hy - 1.4, 3.7, 2.6, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = "#15171c";
    if (p.squint) {
      ctx.fillRect(-2.2, hy - 0.2, 1.5, 0.45);
      ctx.fillRect(0.7, hy - 0.2, 1.5, 0.45);
    } else {
      ctx.fillRect(-1.7, hy - 0.6, 0.9, 1.1);
      ctx.fillRect(0.8, hy - 0.6, 0.9, 1.1);
    }
    const m = p.mouth ?? 0;
    if (m > 0) oval(ctx, 0, hy + 1.9, 1.1 + m * 0.3, 0.5 + m * 0.9, 0, "#5a1a1a");
    else ctx.fillRect(-0.9, hy + 1.8, 1.8, 0.4);
  }
  ctx.restore();
}

export function shadow(ctx: Ctx, x: number, y: number, b: Body, k = 1) {
  ctx.fillStyle = `rgba(0,0,0,${0.32 * k})`;
  ctx.beginPath();
  ctx.ellipse(x, y, 8 * RIG_K * b.scale * k, 2.6 * RIG_K * b.scale * k, 0, 0, Math.PI * 2);
  ctx.fill();
}

// ── 자세 ─────────────────────────────────────────────

const L = (u: number, f: number): Limb => ({ u, f });

// 서 있기 · 걷기: 근육이 커서 팔을 몸에 붙이지 못하고 살짝 벌린다
export function poseStand(phase: number, walking: boolean): FrontPose {
  const w = walking ? Math.sin(phase * 11) : 0;
  return {
    arms: [L(0.42 - w * 0.3, 0.25 - w * 0.3), L(0.42 + w * 0.3, 0.25 + w * 0.3)],
    legs: [L(0.06 + Math.max(0, w) * 0.35, 0.04), L(0.06 + Math.max(0, -w) * 0.35, 0.04)],
    drop: walking ? -Math.abs(Math.cos(phase * 11)) * 0.8 : Math.sin(phase * 2) * 0.15,
  };
}

// 장비를 머리 위로 들기 · 날기: 두 팔을 위로
export function poseArmsUp(): FrontPose {
  return { arms: [L(2.75, 3.0), L(2.75, 3.0)], legs: [L(0.08, 0.05), L(0.08, 0.05)], pump: 0.4 };
}

// 거울 앞 오운완 포즈 (뒷모습, 오른손에 폰). n: 0 백 더블 바이셉스 · 1 한 팔 플렉스 (폰은 얼굴 앞) · 2 랫 스프레드 (두 손 허리)
// t: 그 포즈를 잡은 뒤 지난 초. 처음에 힘을 주며 근육이 부푼다
export function poseFlex(n: number, t: number): FrontPose {
  const f = Math.min(1, t * 4) * (0.85 + Math.sin(t * 8) * 0.15);
  const legs: [Limb, Limb] = [L(0.22, 0.05), L(0.22, 0.05)];
  if (n === 1) return { arms: [L(1.62, 2.95), L(2.2, -2.6)], legs, back: true, phone: true, pump: 0.5 + f * 0.5 };
  if (n === 2) return { arms: [L(0.95, -0.75), L(0.95, -0.75)], legs: [L(0.3, 0.05), L(0.3, 0.05)], back: true, phone: true, pump: 0.6 + f * 0.6, lats: f };
  return { arms: [L(1.62, 2.95), L(1.62, 2.95)], legs, back: true, phone: true, pump: 0.6 + f * 0.4 };
}

// 오른손 위치 (발 기준, 단위). 폰 · 바벨처럼 손에 든 것을 그릴 때 쓴다
export function handPos(l: Limb): { x: number; y: number } {
  const sx = 6.6;
  const sy = -21.5 + 1.4 + 0.6;
  return { x: sx + Math.sin(l.u) * 5.6 + Math.sin(l.f) * 5.2, y: sy + Math.cos(l.u) * 5.6 + Math.cos(l.f) * 5.2 };
}

// 한 발을 붙잡고 깡충 (t: 초)
export function poseHop(t: number): FrontPose {
  return { arms: [L(0.55, 1.0), L(0.55, 1.0)], legs: [L(0.1, 0.05), L(1.05, -0.4)], mouth: 1, squint: true, drop: -Math.abs(Math.sin(t * Math.PI * 7)) * 5 };
}

// 뛰기 직전 움츠리기 (t: 0 → 1)
export function poseCrouch(t: number): FrontPose {
  const d = Math.min(1, t * 1.6);
  return { arms: [L(0.5 + d * 0.3, 0.9), L(0.5 + d * 0.3, 0.9)], legs: [L(0.15 + d * 1.0, 0.1), L(0.15 + d * 1.0, 0.1)], drop: d * 4.2, pump: 0.3 + d * 0.5, squint: d > 0.6 };
}

// 히어로 착지 (t: 0 → 1): 한쪽 무릎 꿇고 주먹 하나로 바닥을 짚고, 다른 팔은 뒤로 뻗는다. 끝 무렵 일어선다
export function poseLand(t: number): FrontPose {
  const r = Math.max(0, (t - 0.75) / 0.25);
  const up = r * r;
  return {
    arms: [L(1.25 - up * 0.8, 1.6 - up * 1.3), L(0.25 + up * 0.15, 0.08 + up * 0.15)],
    legs: [L(1.35 - up * 1.2, 0.05), L(0.35 - up * 0.25, 1.45 - up * 1.4)],
    drop: 6 * (1 - up),
    pump: 0.7,
  };
}

// ── 옆모습 · 위에서 본 모습 ───────────────────────────

// 벤치프레스: 세로로 놓인 벤치에 머리를 위로 하고 누운 모습을 발끝 쪽에서 본다. (x, y) 는 머리 쪽 벤치 끝 가운데.
// 바벨은 가슴 위를 가로지르고, press 0 이면 가슴까지 내려 팔꿈치가 벌어지며 이두가 솟고, 1 이면 팔을 곧게 펴 위로 든다
export function drawBenchPress(ctx: Ctx, x: number, y: number, b: Body, press: number, pump: number) {
  const k = RIG_K * b.scale;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  // 다리: 엉덩이 → 무릎 → 바닥을 딛은 발 (움직이지 않는다)
  for (const s of [-1, 1]) {
    capsule(ctx, s * 2.4, 17, s * 4.6, 22.5, 2.3, 1.9, PANTS);
    capsule(ctx, s * 4.6, 22.5, s * 6.4, 27, 1.5, 1.2, b.skin);
    oval(ctx, s * 7, 27.6, 1.9, 1.1, 0, SHOE);
  }
  // 몸통 (누움): 넓은 가슴 → 좁은 허리
  const sh = darker(b.shirt);
  ctx.fillStyle = b.shirt;
  ctx.beginPath();
  ctx.moveTo(-6.4, 6.6);
  ctx.quadraticCurveTo(0, 5.4, 6.4, 6.6);
  ctx.lineTo(3.6, 17.6);
  ctx.quadraticCurveTo(0, 18.4, -3.6, 17.6);
  ctx.closePath();
  ctx.fill();
  oval(ctx, -2.5, 9.6, 2.8 + pump * 0.5, 2 + pump * 0.3, 0.15, sh);
  oval(ctx, 2.5, 9.6, 2.8 + pump * 0.5, 2 + pump * 0.3, -0.15, sh);
  oval(ctx, -2.5, 9.2, 2.3, 1.4, 0.15, b.shirt);
  oval(ctx, 2.5, 9.2, 2.3, 1.4, -0.15, b.shirt);
  // 머리 (위를 본다. 바닥에 가까울수록 힘이 들어 눈을 질끈 감는다)
  oval(ctx, 0, 2.6, 3.3, 3.4, 0, b.skin);
  ctx.fillStyle = b.hair;
  ctx.beginPath();
  ctx.ellipse(0, 1.4, 3.5, 2.4, 0, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = "#15171c";
  if (press < 0.35) {
    ctx.fillRect(-2, 2.8, 1.4, 0.45);
    ctx.fillRect(0.6, 2.8, 1.4, 0.45);
    oval(ctx, 0, 4.6, 1, 0.8, 0, "#5a1a1a");
  } else {
    ctx.fillRect(-1.6, 2.4, 0.9, 1);
    ctx.fillRect(0.7, 2.4, 0.9, 1);
  }
  // 어깨 · 팔: 어깨 → 팔꿈치 (내리면 바깥 아래로 벌어진다) → 바벨 잡은 손
  const barY = 8.6 - press * 8.4;
  for (const s of [-1, 1]) {
    const sx = s * 6.4;
    const sy = 7.4;
    const hx = s * 8;
    const ex = s * (11.6 - press * 3.2);
    const ey = 10.8 - press * (10.8 - (sy + barY) / 2);
    oval(ctx, sx, sy, 2.6 + pump * 0.4, 2.4 + pump * 0.4, 0, b.skin);
    capsule(ctx, sx, sy, ex, ey, 1.9, 1.5, b.skin);
    const big = 1 + pump * 0.5 + (1 - press) * 0.4;
    oval(ctx, (sx + ex) / 2, (sy + ey) / 2 - 0.5, 2.3 * big, 1.6 * big, Math.atan2(ey - sy, ex - sx), b.skin);
    capsule(ctx, ex, ey, hx, barY, 1.5, 1.2, b.skin);
  }
  // 바벨: 가로 막대와 양끝 원판
  ctx.fillStyle = "#cfd6e0";
  ctx.fillRect(-17, barY - 0.6, 34, 1.3);
  for (const s of [-1, 1]) {
    ctx.fillStyle = "#222831";
    ctx.fillRect(s * 14.5 - 1.3, barY - 4.6, 2.6, 9.2);
    ctx.fillStyle = "#c53030";
    ctx.fillRect(s * 16.3 - 0.8, barY - 3.4, 1.6, 6.8);
  }
  for (const s of [-1, 1]) oval(ctx, s * 8, barY, 1.6, 1.6, 0, b.skin);
  ctx.restore();
}

// 위에서 본 대자로 뻗기 (breath: 숨쉬기 0 → 1)
export function drawSprawlTop(ctx: Ctx, x: number, y: number, b: Body, breath: number) {
  const k = RIG_K * b.scale * 0.9;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  oval(ctx, 0, 1.5, 15, 6, 0, "rgba(0,0,0,0.28)");
  // 다리 (아래로 벌림)
  for (const s of [-1, 1]) {
    capsule(ctx, s * 2, 3, s * 7, 7, 2.2, 1.8, PANTS);
    capsule(ctx, s * 7, 7, s * 10, 10, 1.4, 1.1, b.skin);
  }
  // 팔 (위로 벌림, 근육 덩어리)
  for (const s of [-1, 1]) {
    capsule(ctx, s * 5, -4, s * 10, -8, 1.9, 1.5, b.skin);
    oval(ctx, s * 7.5, -6.3, 2.4, 1.6, s * -0.7, b.skin);
    capsule(ctx, s * 10, -8, s * 13, -12, 1.5, 1.2, b.skin);
  }
  // 몸통 · 머리
  ctx.fillStyle = b.shirt;
  ctx.beginPath();
  ctx.moveTo(-6, -5);
  ctx.lineTo(6, -5);
  ctx.lineTo(3.4, 4 + breath * 0.5);
  ctx.lineTo(-3.4, 4 + breath * 0.5);
  ctx.closePath();
  ctx.fill();
  oval(ctx, -5.6, -4.6, 2.3, 2.1, 0, b.skin);
  oval(ctx, 5.6, -4.6, 2.3, 2.1, 0, b.skin);
  oval(ctx, 0, -8.6, 3.1, 3.2, 0, b.skin);
  oval(ctx, 0, -10.2, 3.2, 1.8, 0, b.hair);
  ctx.fillStyle = "#15171c";
  ctx.fillRect(-1.6, -8.4, 1.1, 0.4);
  ctx.fillRect(0.5, -8.4, 1.1, 0.4);
  ctx.restore();
}
