// 월드 지도: 타일 격자, 침대 · 팀 자리(포드), 길찾기.
//
//   x 0 ──── 10 ──────────────────────────────────── W-1
//     │숙소  │   [팀장]   [팀장]   [팀장]  …         대│
//     │침대  ═   ▭▭▭     ▭▭▭                        기│
//     │4×n   │  ▫▫ ▫▫  ← 팀원 책상 (마주 보는 2개씩)   석│
//     │      ═   [팀장] …  (다음 줄 포드)               │
//     └──────┴──────────────── 출입문 ─────────────────┘
// 숙소는 평소 화면에서 접혀 있고, 버튼을 누르면 오버레이로 펼쳐진다.
//
// 지도 크기는 화면 크기에 따라 정해진다 (configureMap). 한 칸이 화면에서 늘 비슷한 크기가 되도록
// 화면이 크면 칸 수가 늘고, 포드 · 침대 · 대기석 수도 따라 늘어난다.
// 아래 값들은 export let 이라 configureMap 이 바꾸면 가져다 쓰는 모듈에도 바로 반영된다.

export const T = 24; // 타일 한 칸 (논리 px)
export const PARTITION_X = 10;
export const OFFICE_X0 = PARTITION_X * T; // 평소 화면에 보이는 사무실 영역은 칸막이부터 오른쪽 끝까지
export let W = 48;
export let H = 27;
export let WORLD_W = W * T;
export let WORLD_H = H * T;
export let OFFICE_W = WORLD_W - OFFICE_X0;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// 침대는 걸어서 도착하는 칸 (ax, ay) 을 가진다
export interface Bed extends Rect {
  id: number;
  ax: number;
  ay: number;
}

// 팀 자리: 팀장 의자 (cx, y0), 그 아래 큰 책상, 다시 그 아래 팀원 책상 줄
export interface Pod {
  id: number;
  cx: number;
  y0: number;
}

export interface Spot {
  id: number;
  ax: number;
  ay: number;
}

export type DecorKind = "plant";
export interface Decor extends Rect {
  kind: DecorKind;
}

const POD_STEP_X = 7; // 포드 가로 간격 (팀원 의자 양끝 5 칸 + 사이 2 칸)
const POD_STEP_Y = 12; // 포드 세로 간격 (말풍선 3 칸 + 팀장 2 칸 + 팀원 3 줄)
const POD_FIRST_Y = 5;

export let DOORWAYS: number[] = [];
export let DOOR = { ax: 31, ay: H - 1 };
export let beds: Bed[] = [];
export let pods: Pod[] = [];
export let decor: Decor[] = [];
export let spots: Spot[] = [];
let grid = new Uint8Array(W * H); // 1 = 막힘

function setBlock(x: number, y: number, v = 1) {
  if (x >= 0 && y >= 0 && x < W && y < H) grid[y * W + x] = v;
}
function blockRect(r: Rect) {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) setBlock(x, y);
}

export function leadDesk(p: Pod): Rect {
  return { x: p.cx - 1, y: p.y0 + 1, w: 3, h: 1 };
}

// 팀원 자리: i 번째 팀원은 (i / 2) 번째 줄, 짝수는 왼쪽(오른쪽을 봄) · 홀수는 오른쪽(왼쪽을 봄)
// 포드 안에는 3 줄까지. 맨 아랫줄이 차면 그 다음 팀원은 맨 아랫줄 왼쪽 · 오른쪽 자리에 번갈아 아래로 한 층씩 겹쳐 쌓는다.
// 탑은 아래 포드에 닿지 않게 MATE_DROP_MAX 까지만 내려가고, 층이 많으면 층 간격을 좁힌다. n 은 그 포드의 팀원 수
export const MATE_ROW0 = 3; // 팀장 의자에서 몇 칸 아래가 첫 줄
export const LEAD_BENCH_L = 56; // 팀장 벤치 길이 (px). 팀원 벤치를 팀장 크기로 키운 것으로, 포드 의자 칸 위쪽에서 아래로 놓인다
export const BENCH_L = 40; // 팀원 벤치 길이 (px). 자리 칸 위쪽 (머리) 에서 아래로 세로로 놓인다
export const MATE_ROW_GAP = 2;
export const MATE_ROWS = 3;
const MATE_DROP = 10; // 탑 한 층이 내려가는 높이 (논리 px)
const MATE_DROP_MAX = 34; // 탑이 내려갈 수 있는 끝 (아래 포드 말풍선 위)
export interface MateSeat {
  x: number;
  y: number; // 바닥 칸 (걸어서 도착하는 칸)
  side: "left" | "right";
  layer: number; // 0 이면 바닥, 1 부터 탑에 쌓인 층
  drop: number; // 바닥 칸에서 아래로 비켜 앉는 높이 (px)
  front: boolean; // 같은 자리에서 맨 앞 (가장 아래) 층인지. 이름표는 맨 앞만 늘 보인다
}
export function mateSeat(p: Pod, i: number, n = i + 1): MateSeat {
  const base = (MATE_ROWS - 1) * 2; // 맨 아랫줄 첫 자리 번호
  const side = i % 2 === 0 ? "left" : "right";
  const row = Math.min(Math.floor(i / 2), MATE_ROWS - 1);
  const layer = i < base ? 0 : Math.floor((i - base) / 2);
  const top = n > base ? Math.floor((n - 1 - base) / 2) : 0; // 가장 깊은 층
  const step = top ? Math.min(MATE_DROP, MATE_DROP_MAX / top) : 0;
  return {
    x: side === "left" ? p.cx - 2 : p.cx + 2,
    y: p.y0 + MATE_ROW0 + row * MATE_ROW_GAP,
    side,
    layer,
    drop: layer * step,
    front: i < base || i + 2 >= n,
  };
}

// 사무실 가로 칸 수 · 세로 칸 수로 지도를 다시 만든다. 바뀌었으면 true
export function configureMap(officeCols: number, rows: number): boolean {
  const w = PARTITION_X + Math.max(24, Math.round(officeCols));
  const h = Math.max(20, Math.round(rows));
  if (w === W && h === H && pods.length) return false;
  W = w;
  H = h;
  WORLD_W = W * T;
  WORLD_H = H * T;
  OFFICE_W = WORLD_W - OFFICE_X0;
  grid = new Uint8Array(W * H);

  // 벽 (위쪽 벽은 앞면까지 두 칸)
  for (let x = 0; x < W; x++) {
    setBlock(x, 0);
    setBlock(x, 1);
    setBlock(x, H - 1);
  }
  for (let y = 0; y < H; y++) {
    setBlock(0, y);
    setBlock(W - 1, y);
    setBlock(PARTITION_X, y);
  }
  // 숙소 ↔ 사무실 문 (위 · 아래 두 곳), 바깥 출입문 (사무실 아래 가운데)
  const d1 = Math.round(H * 0.25);
  const d2 = Math.round(H * 0.7);
  DOORWAYS = [d1, d1 + 1, d2, d2 + 1];
  for (const y of DOORWAYS) setBlock(PARTITION_X, y, 0);
  const doorX = Math.round((PARTITION_X + W) / 2);
  DOOR = { ax: doorX, ay: H - 1 };
  setBlock(doorX, H - 1, 0);
  setBlock(doorX + 1, H - 1, 0);

  // 침대: 틈 없이 4개씩, 높이가 되는 만큼 줄을 둔다. 침대 줄 사이 한 칸과 오른쪽 한 칸이 통로
  beds = [];
  for (let y = 2; y + 3 <= H - 2; y += 4) {
    for (const x of [1, 3, 5, 7]) {
      const b: Bed = { id: beds.length, x, y, w: 2, h: 3, ax: x, ay: y + 3 };
      beds.push(b);
      blockRect(b);
    }
  }

  // 포드 자리: 사무실 폭 · 높이에 들어가는 만큼. 사무실 정중앙에 가까운 자리부터 채운다 (포드 가운데 = 의자에서 3 칸 아래).
  // 0 번은 정중앙에 가장 가까운 포드, 그 뒤로는 0 번에서 몇 칸 떨어졌는지로 정한 같은 순서를 쓴다
  // (같은 줄 오른쪽 → 왼쪽 → 아래 → 위 → 대각선 → 더 먼 곳). 그래야 모니터 크기가 달라도 n 번이 0 번 기준 같은 곳에 놓인다.
  // 책상은 미리 놓지 않고 팀장이 들고 와서 놓는다
  const cols: number[] = [];
  for (let cx = PARTITION_X + 4; cx + 2 <= W - 4; cx += POD_STEP_X) cols.push(cx);
  // 남는 폭을 양쪽에 나눠 가운데로 모은다
  const slack = W - 4 - (cols.at(-1)! + 2);
  const shift = Math.floor(slack / 2);
  const rowsY: number[] = [];
  for (let y0 = POD_FIRST_Y; y0 + 8 <= H - 2; y0 += POD_STEP_Y) rowsY.push(y0);
  const cx0 = (PARTITION_X + W) / 2;
  const cy0 = H / 2;
  const all = rowsY.flatMap((y0) => cols.map((cx) => ({ cx: cx + shift, y0 })));
  const near = (p: { cx: number; y0: number }) => Math.hypot(p.cx - cx0, p.y0 + 3 - cy0);
  const c = all.reduce((best, p) => (near(p) < near(best) ? p : best));
  pods = all
    .map((p) => ({ ...p, dc: (p.cx - c.cx) / POD_STEP_X, dr: (p.y0 - c.y0) / POD_STEP_Y }))
    .sort((a, b) => Math.hypot(a.dc, 1.5 * a.dr) - Math.hypot(b.dc, 1.5 * b.dr) || b.dr - a.dr || b.dc - a.dc)
    .map((p, id) => ({ id, cx: p.cx, y0: p.y0 }));

  decor = [
    { kind: "plant", x: PARTITION_X + 1, y: 2, w: 1, h: 1 },
    { kind: "plant", x: PARTITION_X + 1, y: H - 2, w: 1, h: 1 },
  ];
  for (const d of decor) blockRect(d);

  // 포드가 모자라면 서 있을 대기석 (사무실 오른쪽 벽을 따라)
  spots = [];
  for (let y = 3; y <= H - 2; y += 2) spots.push({ id: spots.length, ax: W - 2, ay: y });
  return true;
}

configureMap(38, 27);

export function isBlocked(x: number, y: number): boolean {
  return x < 0 || y < 0 || x >= W || y >= H || grid[y * W + x] === 1;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// 4방향 A*. 시작 칸은 막혀 있어도 된다. 경로는 시작 칸 다음부터 도착 칸까지
export function findPath(sx: number, sy: number, tx: number, ty: number): { x: number; y: number }[] {
  if (sx === tx && sy === ty) return [];
  // 지도 밖은 갈 수 없다 (밖을 가리키면 아래 경로 되짚기가 끝나지 않는다)
  const out = (x: number, y: number) => x < 0 || y < 0 || x >= W || y >= H;
  if (out(sx, sy) || out(tx, ty)) return [];
  const N = W * H;
  const g = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const inOpen = new Uint8Array(N);
  const open: number[] = [];
  const s = sy * W + sx;
  const t = ty * W + tx;
  const h = (i: number) => Math.abs((i % W) - tx) + Math.abs(((i / W) | 0) - ty);
  g[s] = 0;
  open.push(s);
  inOpen[s] = 1;
  while (open.length) {
    let bi = 0;
    let bf = Infinity;
    for (let k = 0; k < open.length; k++) {
      const f = g[open[k]] + h(open[k]);
      if (f < bf) {
        bf = f;
        bi = k;
      }
    }
    const cur = open[bi];
    open[bi] = open[open.length - 1];
    open.pop();
    inOpen[cur] = 0;
    if (cur === t) break;
    closed[cur] = 1;
    const cx = cur % W;
    const cy = (cur / W) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (closed[ni] || (grid[ni] === 1 && ni !== t)) continue;
      const ng = g[cur] + 1;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        if (!inOpen[ni]) {
          open.push(ni);
          inOpen[ni] = 1;
        }
      }
    }
  }
  if (came[t] === -1) return [];
  const path: { x: number; y: number }[] = [];
  for (let i = t; i !== s; i = came[i]) path.push({ x: i % W, y: (i / W) | 0 });
  return path.reverse();
}
