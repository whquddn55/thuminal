// 월드 상태: 에이전트 상태를 받아 누가 어디로 갈지 정하고, 침대 · 팀 자리(포드)를 나눠 주고, 걷게 · 날게 한다.
//
// 화면은 헬스장이다 (그리기는 render.ts · World.tsx). 여기서 "책상 (desk)" 은 운동 장비를 뜻한다 (팀장 큰 벤치 · 팀원 벤치).
//   세션(팀장)  일함 → 포드의 큰 세로 벤치에 누워 체스트 프레스 (팀원을 크게 키운 모습. 팀원이 있으면 "하나 더!!!" 외친다)
//               쉼 → 장비를 던져 올리고 거울 앞으로 날아가 포즈 세 가지로 오운완 셀카를 찍은 뒤 숙소로 걸어간다
//   팀원        팀장 포드 아래 줄에 벤치를 놓고 벤치프레스. 맡은 일을 끝내면 (대기) 벤치는 둔 채 거울 앞에서 셀카 세 장을 찍고
//               돌아와 벤치 옆 바닥에 대자로 뻗는다. 끝나면 셀카를 찍고 출입문으로 나간다
//   도구 오류   바벨을 발등에 떨어뜨려 잠깐 깡충깡충 (oops)
// 장비 자리로 갈 때는 장비를 들어 자리로 던지고 (날아가 쿵 내려앉으며 충격파 · 화면 흔들림), 몸을 움츠렸다 튀어 올라 뒤따라 날아가 히어로 착지로 선다.
// 장비를 두고 쉬러 가거나 나갈 때는 장비를 위로 던져 올리고 거울 앞으로 날아가 셀카를 찍은 뒤 걸어간다. 장비 없이 옮길 때만 걷는다
//   서브에이전트 드론. 출입문에서 날아와 부모(팀장 · 팀원) 둘레 구역 안을 이곳저곳 옮겨 다닌다. 서브의 서브는 부모 드론 곁을 옮겨 다니는 작은 드론.
//               끝나면 출입문으로 날아가 사라진다
// 처음 연결했을 때 이미 있던 사람 · 드론은 제자리에 바로 놓는다. 그 뒤로 생긴 것은 출입문에서 나타난다.
// 포드 번호 · 팀원 자리 번호는 서버가 정해 준다 (AgentInfo.podSlot · mateSlot). 그래서 새로고침해도, 모니터가 달라도 앉는 순서가 같다.
// 번호는 줄 서기처럼 앞으로 당겨진다. 번호가 바뀌면 앉아 있던 팀장 · 팀원은 책상을 다시 이고 새 자리로 옮긴다.

import type { AgentInfo } from "./types";
import { BENCH_L, DOOR, H, LEAD_BENCH_L, PARTITION_X, T, W, beds, findPath, isBlocked, mateSeat, pods, spots, type Bed, type MateSeat, type Pod, type Spot } from "./map";

export type Mode = "work" | "rest" | "exit";
export type Pose = "walk" | "stand" | "sleep" | "sitfront" | "sitside" | "lift" | "crouch" | "fly" | "land" | "selfie";
export type Dir = "up" | "down" | "left" | "right";

type Goal =
  | { kind: "bed"; bed: Bed }
  | { kind: "lead"; pod: Pod }
  | { kind: "mate"; pod: Pod; idx: number }
  | { kind: "spot"; spot: Spot }
  | { kind: "free"; x: number; y: number }
  | { kind: "exit" }
  // 대형 거울 앞에서 포즈 세 가지로 오운완 셀카를 찍고 then (숙소 · 출입문 · 팀원 벤치) 으로 간다
  | { kind: "mirror"; x: number; y: number; then: Goal };

export interface Avatar {
  key: string;
  info: AgentInfo;
  x: number; // 서 있는 칸 가운데 (논리 px)
  y: number;
  path: { x: number; y: number }[];
  goal: Goal | null;
  mode: Mode;
  pose: Pose;
  dir: Dir;
  phase: number;
  teammate: boolean; // 팀장 포드에 앉는 팀원
  bed?: Bed;
  seat?: { pod: Pod; idx: number }; // 팀원이 앉는 자리
  spot?: Spot;
  carrying: boolean; // 책상을 머리 위로 들고 있다 (던지기 직전. 팀장은 큰 책상, 팀원은 작은 책상)
  deskDown: boolean; // 팀원 작은 책상이 자리에 놓여 있다 (팀장 책상은 World.placedDesks)
  steps: Step[]; // 던지고 날아가는 동작 순서. 비어 있으면 걷거나 멈춰 있다
  stepT: number; // 지금 동작을 시작한 뒤 지난 초
  z: number; // 날 때 땅에서 뜬 높이 (px)
  oopsAt: number; // 도구 오류로 바벨을 발등에 떨어뜨린 시각 (Date.now, 0 이면 없음). 잠깐 깡충깡충 뛴다
  tilt: number; // 날 때 몸 기울기 (라디안, 머리가 나는 쪽을 본다)
  trail: { x: number; y: number }[]; // 날 때 지나온 몸 위치 (잔상 · 속도선). 최근 것이 끝
  gone: boolean;
  born: number;
  hit?: { x: number; y: number; w: number; h: number };
}

export interface Drone {
  key: string;
  info: AgentInfo;
  x: number;
  y: number;
  anchor: string; // 따라다니는 대상: 사람(Avatar) key 또는 부모 드론 key
  slot: number; // 같은 대상을 따라다니는 드론 가운데 몇 번째
  count: number; // 같은 대상을 따라다니는 드론 수
  leaving: boolean;
  behind: boolean; // 팀장 몸 뒤쪽에 있다 (몸보다 먼저 그린다)
  // 구역 안을 돌아다니기: 대상 기준 위치 (ox, oy) 를 지금 (fx, fy) 에서 다음 지점 (tx, ty) 으로 md 초 동안 옮기고, 닿으면 wait 초 쉰다
  area?: string; // 지금 구역 종류. 바뀌면 (주인이 앉거나 일어서면) 다음 지점을 새로 고른다
  ox: number;
  oy: number;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  mt: number;
  md: number;
  wait: number;
  born: number;
  phase: number;
}

const SPEED = 13.2 * T; // 걷는 속도 (px/초)
const FLY = 18 * T; // 드론이 날아오고 날아가는 속도
const LIFT_S = 0.3; // 책상을 머리 위로 들어 올리는 시간
const DESK_SPEED = 34 * T; // 던진 책상이 나는 속도
const JUMP_SPEED = 34 * T; // 사람이 날아가는 속도
export const LAND_S = 1.2; // 히어로 착지 자세로 버티는 시간 (끝 무렵에 일어선다)
export const CROUCH_S = 0.5; // 뛰기 전에 움츠려 힘을 모으는 시간
export const SELFIE_SHOT = 1.1; // 셀카 한 장 (포즈 하나) 에 쓰는 시간
export const SELFIE_S = SELFIE_SHOT * 3; // 거울 앞에서 포즈 세 가지로 오운완 셀카를 찍는 시간
export const OOPS_MS = 1600; // 바벨을 떨어뜨리고 깡충깡충 뛰는 시간
const FOLLOW_S = 0.25; // 책상을 던진 뒤 두 팔을 든 채 멈춰 있는 시간

// 던지고 날아가는 동작 한 단계
type Step =
  | { k: "lift" }
  | { k: "throw"; x: number; y: number; land?: DeskLand }
  | { k: "wait"; dur: number }
  | { k: "crouch" }
  | { k: "fly"; x: number; y: number; sx?: number; sy?: number; dur?: number; h?: number }
  | { k: "land" };

// 던진 책상이 내려앉을 자리. 없으면 갈 곳에 닿자마자 연기로 사라진다
type DeskLand = { kind: "lead"; pod: Pod } | { kind: "mate"; pod: Pod; idx: number };

export interface FlyingDesk {
  owner: string;
  big: boolean;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  t: number;
  dur: number;
  h: number; // 포물선 꼭대기 높이
  land?: DeskLand;
  x: number; // 지금 땅 위치와 높이 (그리기용)
  y: number;
  z: number;
  spin: number;
}

// 착지 충격파: 바닥에 납작하게 퍼지는 고리
export interface Ring {
  x: number;
  y: number;
  r: number; // 다 퍼졌을 때 반지름
  age: number;
  life: number;
}

// 솟았다가 가속하며 내리꽂는 높이 (k: 0 → 1). 0.35 에서 꼭대기
function slam(k: number, h: number): number {
  return k < 0.35 ? h * (1 - (1 - k / 0.35) ** 2) : h * (1 - ((k - 0.35) / 0.65) ** 2.4);
}


const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// 드론은 정해진 원을 돌지 않는다 (날파리 같다는 피드백). 주인 둘레 자기 구역 안에서 무작위로 다음 지점을 골라
// 부드럽게 출발해 딱 멈추고, 잠깐 쉬었다 또 간다. 같은 주인의 다른 드론과 떨어진 곳을 고른다
const DRONE_SPEED = 110; // 다음 지점으로 가는 빠르기 (px/초)
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

const center = (tx: number, ty: number) => ({ x: tx * T + T / 2, y: ty * T + T / 2 });
const tileOf = (a: { x: number; y: number }) => ({ x: Math.round((a.x - T / 2) / T), y: Math.round((a.y - T / 2) / T) });

function wantMode(info: AgentInfo): Mode {
  if (info.status === "busy" || info.status === "shell" || info.status === "active") return "work";
  if (info.status === "done") return "exit";
  return "rest";
}

function goalTile(g: Goal): { x: number; y: number } {
  switch (g.kind) {
    case "bed":
      return { x: g.bed.ax, y: g.bed.ay };
    case "lead":
      return { x: g.pod.cx, y: g.pod.y0 };
    case "mate": {
      const s = mateSeat(g.pod, g.idx);
      return { x: s.x, y: s.y };
    }
    case "spot":
      return { x: g.spot.ax, y: g.spot.ay };
    case "free":
      return { x: g.x, y: g.y };
    case "exit":
      return { x: DOOR.ax, y: DOOR.ay };
    case "mirror":
      return { x: g.x, y: g.y };
  }
}

// 드론 구역의 기준점. kind 에 따라 구역 모양이 다르다
//   wide: 책상에 앉은 팀장 — 몸 둘레 넓고 납작한 구역 (몸보다 위쪽에 있으면 몸에 가려진다)
//   side: 작은 책상에 앉은 팀원 — 바깥쪽 옆구리 (포드 사이 빈 칸). 많으면 아래로 길어진다
//   head: 그 밖 — 머리 위. 많으면 위로 길어진다
export function orbitCenter(av: Avatar): { x: number; y: number; kind: "wide" | "side" | "head" } {
  const s = av.teammate ? 1.1 : 1.45;
  if (av.pose === "sleep" && av.bed) return { x: (av.bed.x + av.bed.w / 2) * T, y: av.bed.y * T + 4, kind: "head" };
  if (av.pose === "sitfront") return { x: av.x, y: av.y - 8, kind: "wide" };
  if (av.pose === "sitside") return { x: av.x + (av.dir === "right" ? -22 : 22), y: av.y - 12, kind: "side" };
  return { x: av.x, y: av.y + 7 - 27 * s - (av.teammate ? 10 : 44) - av.z, kind: "head" };
}

export class World {
  avatars = new Map<string, Avatar>();
  drones = new Map<string, Drone>();
  private bedOwner = new Map<number, string>();
  private spotOwner = new Map<number, string>();
  placedDesks = new Set<number>(); // 팀장 책상이 놓여 있는 포드 id (팀장이 앉아 있는 동안)
  private mateCount = new Map<number, number>(); // 포드 id → 그 포드 팀원 수 (탑 층 간격을 정한다)
  desks: FlyingDesk[] = []; // 던져서 날아가는 책상
  rings: Ring[] = []; // 착지 충격파
  shake = 0; // 화면 흔들림 세기 (px). 착지할 때 커지고 빠르게 잦아든다
  private synced = false;

  sync(agents: AgentInfo[], now: number) {
    // 빈 목록은 "처음" 으로 치지 않는다 (서버 데이터가 오기 전에 불릴 수 있다)
    const first = !this.synced;
    if (agents.length) this.synced = true;
    const byKey = new Map(agents.map((a) => [a.key, a]));
    const people = agents.filter((a) => a.kind !== "subagent");
    const seen = new Set<string>();
    // 팀장이 먼저 자리를 잡아야 팀원이 그 포드를 찾는다
    people.sort((a, b) => (a.kind === "teammate" ? 1 : 0) - (b.kind === "teammate" ? 1 : 0));
    for (const info of people) {
      seen.add(info.key);
      const mode = wantMode(info);
      let av = this.avatars.get(info.key);
      if (!av) {
        const door = center(DOOR.ax, DOOR.ay);
        av = {
          key: info.key,
          info,
          x: door.x,
          y: door.y,
          path: [],
          goal: null,
          mode: "rest",
          pose: "stand",
          dir: "up",
          phase: Math.random() * 10,
          teammate: false,
          carrying: false,
          deskDown: false,
          steps: [],
          stepT: 0,
          z: 0,
          tilt: 0,
          trail: [],
          oopsAt: 0,
          gone: false,
          born: first ? 0 : now,
        };
        this.avatars.set(info.key, av);
        av.teammate = this.rootOf(av) !== av;
        this.setMode(av, mode, first);
        continue;
      }
      av.info = info;
      if (av.mode === "exit") continue;
      const teammate = this.rootOf(av) !== av;
      if (teammate !== av.teammate) {
        av.teammate = teammate;
        this.setMode(av, mode, false);
      } else if (av.mode !== mode) this.setMode(av, mode, false);
      else if (!teammate && mode === "work" && this.podFor(av) !== (av.goal?.kind === "lead" ? av.goal.pod : undefined)) {
        this.setMode(av, mode, false); // 서버가 포드 번호를 바꿨다 (서버를 다시 띄웠을 때 등)
      }
    }
    for (const av of this.avatars.values()) {
      if (!seen.has(av.key) && av.mode !== "exit") this.setMode(av, "exit", false);
    }
    this.seatTeammates(first);
    this.syncDrones(
      agents.filter((a) => a.kind === "subagent"),
      byKey,
      first,
      now,
    );
  }

  // 팀원이 앉을 포드의 팀장. 팀원이 아니면 자기 자신
  rootOf(av: Avatar): Avatar {
    if (av.info.kind !== "teammate") return av;
    let pk = av.info.parent ?? `s:${av.info.sessionId}`;
    for (let i = 0; i < 10; i++) {
      const p = this.avatars.get(pk);
      if (!p || p === av) return av;
      if (p.info.kind !== "teammate") return p;
      pk = p.info.parent ?? "";
    }
    return av;
  }

  private pickBed(av: Avatar): Bed | undefined {
    if (av.bed) return av.bed;
    const bed = beds.find((b) => !this.bedOwner.has(b.id));
    if (bed) {
      this.bedOwner.set(bed.id, av.key);
      av.bed = bed;
    }
    return bed;
  }

  // 서버가 정한 포드 번호의 포드. 화면이 작아 그 번호 포드가 없으면 없음 (대기석에 선다)
  private podFor(av: Avatar): Pod | undefined {
    const n = av.info.podSlot;
    return n === undefined || av.mode === "exit" ? undefined : pods[n];
  }

  private pickSpot(av: Avatar): Goal {
    if (!av.spot) {
      const spot = spots.find((s) => !this.spotOwner.has(s.id));
      if (spot) {
        this.spotOwner.set(spot.id, av.key);
        av.spot = spot;
      }
    }
    if (av.spot) return { kind: "spot", spot: av.spot };
    for (let i = 0; i < 200; i++) {
      const x = PARTITION_X + 2 + Math.floor(Math.random() * (W - PARTITION_X - 4));
      const y = 3 + Math.floor(Math.random() * (H - 5));
      if (!isBlocked(x, y)) return { kind: "free", x, y };
    }
    return { kind: "free", x: DOOR.ax, y: DOOR.ay - 2 };
  }

  private releaseSpot(av: Avatar) {
    if (av.spot) this.spotOwner.delete(av.spot.id);
    av.spot = undefined;
  }


  private setMode(av: Avatar, mode: Mode, instant: boolean) {
    const was = av.mode;
    av.mode = mode;
    if (mode === "exit") {
      this.releaseSpot(av);
      if (av.bed) this.bedOwner.delete(av.bed.id);
      av.bed = undefined;
      av.seat = undefined;
      this.go(av, { kind: "exit" }, false);
      return;
    }
    if (av.teammate) {
      // 자리는 seatTeammates 가 팀장 포드에 정한다 (대기 중이어도 그 자리에서 쉰다).
      // 맡은 일을 끝내면 (일함 → 대기) 벤치는 둔 채 거울로 걸어가 오운완 셀카를 찍고 돌아와 쉰다
      if (was === "work" && mode === "rest" && !instant && av.pose === "sitside" && av.seat) this.selfieTrip(av);
      return;
    }
    this.releaseSpot(av);
    if (mode === "work") {
      const pod = this.podFor(av);
      // 처음 연결했을 때는 이미 앉아 있는 것으로
      this.go(av, pod ? { kind: "lead", pod } : this.pickSpot(av), instant);
    } else {
      // 쉬러 간다 (장비를 두고 가면 go 가 거울 앞 오운완 셀카부터 찍게 한다)
      const bed = this.pickBed(av);
      this.go(av, bed ? { kind: "bed", bed } : this.pickSpot(av), instant);
    }
  }

  // 팀원 자리 (탑에 쌓인 층이면 비켜 앉는 높이까지)
  seatOf(av: Avatar): MateSeat | undefined {
    const s = av.seat;
    return s && mateSeat(s.pod, s.idx, this.mateCount.get(s.pod.id));
  }

  private seatTeammates(instant: boolean) {
    this.mateCount.clear();
    for (const av of this.avatars.values()) {
      if (!av.teammate || av.mode === "exit") continue;
      const pod = this.podFor(this.rootOf(av));
      if (pod) this.mateCount.set(pod.id, Math.max(this.mateCount.get(pod.id) ?? 0, (av.info.mateSlot ?? 0) + 1));
    }
    for (const av of this.avatars.values()) {
      if (!av.teammate || av.mode === "exit") continue;
      const root = this.rootOf(av);
      const pod = this.podFor(root);
      if (!pod) {
        if (!av.goal || av.goal.kind === "mate") this.go(av, this.pickSpot(av), instant);
        continue;
      }
      const idx = av.info.mateSlot ?? 0;
      if (!av.seat || av.seat.pod !== pod || av.seat.idx !== idx) av.seat = { pod, idx };
      const g = av.goal;
      if (g?.kind === "mate" && g.pod === av.seat.pod && g.idx === av.seat.idx) continue;
      // 셀카 나들이 중이면 끝나고 알아서 이 자리로 돌아온다
      const back = g?.kind === "mirror" ? g.then : undefined;
      if (back?.kind === "mate" && back.pod === av.seat.pod && back.idx === av.seat.idx) continue;
      this.releaseSpot(av);
      this.go(av, { kind: "mate", pod: av.seat.pod, idx: av.seat.idx }, instant);
    }
  }

  // 팀원 셀카 나들이: 벤치는 자리에 둔 채 거울 앞으로 걸어가고, 셀카 뒤 같은 자리로 걸어 돌아온다
  private selfieTrip(av: Avatar) {
    const s = av.seat!;
    av.goal = this.mirrorGoal(av, { kind: "mate", pod: s.pod, idx: s.idx });
    av.steps = [];
    av.stepT = 0;
    const target = goalTile(av.goal);
    const from = tileOf(av);
    av.path = [from, ...findPath(from.x, from.y, target.x, target.y)];
    av.pose = "walk";
  }

  private go(av: Avatar, goal: Goal, instant: boolean) {
    const prev = av.goal;
    // 벤치를 둔 채 다녀온 팀원이 같은 자리로 돌아올 때는 장비를 집지도 던지지도 않고 걸어온다
    const keep = goal.kind === "mate" && av.deskDown && av.seat?.pod === goal.pod && av.seat.idx === goal.idx;
    // 쓰던 장비를 집어 든다 (팀장 큰 벤치 · 팀원 벤치)
    const hadDesk = !keep && ((prev?.kind === "lead" && this.placedDesks.delete(prev.pod.id)) || av.deskDown);
    if (!keep) av.deskDown = false;
    // 운동을 마치고 쉬러 가거나 나갈 때는 대형 거울 앞에서 오운완 셀카부터 찍는다
    if (hadDesk && !instant && (goal.kind === "bed" || goal.kind === "exit")) goal = this.mirrorGoal(av, goal);
    av.goal = goal;
    av.steps = [];
    av.stepT = 0;
    av.z = 0;
    av.carrying = false;
    const target = goalTile(goal);
    const c = center(target.x, target.y);
    if (instant) {
      av.x = c.x;
      av.y = c.y;
      av.path = [];
      this.arrive(av);
      return;
    }
    av.path = [];
    const land = keep ? undefined : this.deskLand(goal);
    if (!land && !hadDesk) {
      const from = tileOf(av);
      av.path = [from, ...findPath(from.x, from.y, target.x, target.y)];
      av.pose = "walk";
      return;
    }
    // 책상을 들어 갈 곳으로 던지고 뒤따라 날아간다. 책상 자리로 가면 책상이 내려앉은 뒤에 날아간다
    const to = land ? this.deskPoint(land) : { x: c.x, y: goal.kind === "exit" ? c.y + 2 * T : c.y };
    const deskDur = clamp(Math.hypot(to.x - av.x, to.y - av.y) / DESK_SPEED, 0.35, 0.9);
    // 던진 뒤 팔을 든 채 멈췄다가 움츠려 힘을 모으고 박차 오른다. 책상 자리로 가면 책상이 내려앉을 때까지 기다린다
    av.steps = [{ k: "lift" }, { k: "throw", x: to.x, y: to.y, land }, { k: "wait", dur: Math.max(FOLLOW_S, land ? deskDur - CROUCH_S : 0) }, { k: "crouch" }, { k: "fly", x: c.x, y: c.y }];
    if (goal.kind !== "exit") av.steps.push({ k: "land" });
  }

  // 셀카 찍을 거울 앞 자리: 위쪽 벽 바로 아래 줄에서 지금 자리와 가까운 곳 (다른 사람과 겹치지 않게 조금씩 비킨다)
  private mirrorGoal(av: Avatar, then: Goal): Extract<Goal, { kind: "mirror" }> {
    const taken = new Set([...this.avatars.values()].filter((o) => o !== av && o.goal?.kind === "mirror").map((o) => (o.goal as { x: number }).x));
    let x = clamp(tileOf(av).x, PARTITION_X + 2, W - 3);
    for (let d = 0; d < 20 && taken.has(x); d++) x = clamp(x + (d % 2 ? -d : d), PARTITION_X + 2, W - 3);
    return { kind: "mirror", x, y: 2, then };
  }

  // 도구 오류: 바벨을 발등에 떨어뜨린다 (화면이 새 오류 이벤트를 보고 부른다)
  oops(key: string, now: number) {
    const av = this.avatars.get(key);
    if (av && (av.pose === "sitfront" || av.pose === "sitside")) av.oopsAt = now;
  }

  private deskLand(goal: Goal): DeskLand | undefined {
    if (goal.kind === "lead") return { kind: "lead", pod: goal.pod };
    if (goal.kind === "mate") return { kind: "mate", pod: goal.pod, idx: goal.idx };
    return undefined;
  }

  // 장비가 놓이는 자리 가운데 (render.ts 의 drawPlatform · drawBench 와 같은 자리)
  private deskPoint(land: DeskLand): { x: number; y: number } {
    const px = land.pod.cx * T + T / 2;
    if (land.kind === "lead") return { x: px, y: land.pod.y0 * T - 2 + LEAD_BENCH_L / 2 };
    const s = mateSeat(land.pod, land.idx, this.mateCount.get(land.pod.id));
    return { x: s.x * T + T / 2, y: s.y * T + s.drop + 2 + BENCH_L / 2 };
  }


  // 쿵: 충격파 고리 (바닥에서 튀는 충격선과 같이 그린다) 와 화면 흔들림. power 는 0.5 (사라지는 책상) ~ 1.6 (팀장 책상)
  private impact(x: number, y: number, power: number, shake = true) {
    this.rings.push({ x, y, r: 34 * power, age: 0, life: 0.32 });
    if (shake) this.shake = Math.max(this.shake, 4.5 * power);
  }

  // 던지고 날아가는 동작을 한 프레임 진행한다
  private runSteps(av: Avatar, dt: number) {
    for (let guard = 0; guard < 8 && av.steps.length; guard++) {
      const st = av.steps[0];
      av.stepT += dt;
      let done = false;
      switch (st.k) {
        case "lift":
          av.pose = "lift";
          av.carrying = true;
          done = av.stepT >= LIFT_S;
          break;
        case "throw": {
          const big = !av.teammate;
          const sx = av.x;
          const sy = av.y;
          const dist = Math.hypot(st.x - sx, st.y - sy);
          this.desks.push({ owner: av.key, big, sx, sy, tx: st.x, ty: st.y, t: 0, dur: clamp(dist / DESK_SPEED, 0.35, 0.9), h: clamp(50 + dist * 0.4, 60, 190), land: st.land, x: sx, y: sy, z: 0, spin: (Math.random() - 0.5) * 2 });
          av.carrying = false;
          av.pose = "lift"; // 던진 자세 그대로 두 팔을 든 채
          done = true;
          break;
        }
        case "wait":
          done = av.stepT >= st.dur;
          break;
        case "crouch":
          av.pose = "crouch";
          done = av.stepT >= CROUCH_S;
          break;
        case "fly": {
          if (st.dur === undefined) {
            const dist = Math.hypot(st.x - av.x, st.y - av.y);
            st.sx = av.x;
            st.sy = av.y;
            st.dur = clamp(dist / JUMP_SPEED, 0.45, 1);
            st.h = clamp(50 + dist * 0.4, 60, 190);
            this.impact(av.x, av.y, 0.6, false); // 바닥을 박찬다
          }
          const k = Math.min(1, av.stepT / st.dur);
          const dx = st.x - st.sx!;
          const px = av.x;
          const py = av.y - av.z;
          av.x = st.sx! + dx * k;
          av.y = st.sy! + (st.y - st.sy!) * k;
          av.z = slam(k, st.h!);
          av.pose = "fly";
          if (Math.abs(dx) > 1) av.dir = dx > 0 ? "right" : "left";
          // 머리가 나는 쪽을 보게 기운다 (솟을 때는 위로, 내리꽂을 때는 아래로)
          const vx = av.x - px;
          const vy = av.y - av.z - py;
          if (Math.hypot(vx, vy) > 0.5) av.tilt = clamp(Math.atan2(vx, -vy), -2.4, 2.4);
          av.trail.push({ x: av.x, y: av.y - av.z });
          if (av.trail.length > 7) av.trail.shift();
          done = k >= 1;
          if (done) {
            av.z = 0;
            av.trail = [];
            av.tilt = 0;
          }
          break;
        }
        case "land":
          if (av.pose !== "land") {
            av.pose = "land";
            av.dir = "down";
            this.impact(av.x, av.y, av.teammate ? 0.9 : 1.2);
          }
          done = av.stepT >= LAND_S;
          break;
      }
      if (!done) return;
      av.steps.shift();
      av.stepT = 0;
      dt = 0;
    }
    if (!av.steps.length) this.arrive(av);
  }

  private arrive(av: Avatar) {
    const g = av.goal;
    if (!g) return;
    av.carrying = false;
    av.z = 0;
    av.trail = [];
    switch (g.kind) {
      case "bed":
        av.pose = "sleep";
        break;
      case "lead":
        av.pose = "sitfront";
        av.dir = "down";
        this.placedDesks.add(g.pod.id);
        break;
      case "mate": {
        av.pose = "sitside";
        av.deskDown = true;
        av.dir = mateSeat(g.pod, g.idx).side === "left" ? "right" : "left";
        break;
      }
      case "exit":
        av.gone = true;
        break;
      case "mirror":
        av.pose = "selfie";
        av.dir = "up";
        av.stepT = 0;
        break;
      default:
        av.pose = "stand";
        av.dir = "down";
    }
  }

  // ── 드론 ─────────────────────────────────────────

  private syncDrones(subs: AgentInfo[], byKey: Map<string, AgentInfo>, first: boolean, now: number) {
    const seen = new Set<string>();
    for (const info of subs) {
      seen.add(info.key);
      let d = this.drones.get(info.key);
      if (info.status === "done") {
        if (d) d.leaving = true;
        continue;
      }
      if (!d) {
        const door = center(DOOR.ax, DOOR.ay);
        d = { key: info.key, info, x: door.x, y: door.y, anchor: "", slot: 0, count: 1, leaving: false, behind: false, born: first ? 0 : now, phase: Math.random() * 10, ox: 0, oy: 0, fx: 0, fy: 0, tx: 0, ty: 0, mt: 0, md: 0, wait: 0 };
        this.drones.set(info.key, d);
      }
      d.info = info;
      d.leaving = false;
      d.anchor = this.anchorOf(info, byKey);
    }
    for (const d of this.drones.values()) if (!seen.has(d.key)) d.leaving = true;
    // 같은 대상을 도는 드론끼리 순번을 매긴다
    const groups = new Map<string, Drone[]>();
    for (const d of this.drones.values()) {
      if (d.leaving) continue;
      const g = groups.get(d.anchor) ?? [];
      g.push(d);
      groups.set(d.anchor, g);
    }
    for (const g of groups.values()) {
      g.sort((a, b) => (a.info.startedAt ?? 0) - (b.info.startedAt ?? 0));
      g.forEach((d, i) => {
        d.slot = i;
        d.count = g.length;
      });
    }
    // 처음 연결했을 때는 제자리에 바로 놓는다 (부모 드론부터)
    if (first) {
      const list = [...this.drones.values()].sort((a, b) => (this.drones.has(a.anchor) ? 1 : 0) - (this.drones.has(b.anchor) ? 1 : 0));
      for (const d of list) {
        const p = this.orbitPos(d);
        d.x = p.x;
        d.y = p.y;
      }
    }
  }

  // 부모를 거슬러 올라가 처음 만나는 사람 · 아직 일하는 드론
  private anchorOf(info: AgentInfo, byKey: Map<string, AgentInfo>): string {
    let pk = info.parent;
    for (let i = 0; i < 10 && pk; i++) {
      if (this.avatars.has(pk)) return pk;
      const p = byKey.get(pk);
      if (p?.kind === "subagent" && p.status !== "done") return pk;
      pk = p?.parent;
    }
    return `s:${info.sessionId}`;
  }

  // 드론 구역 (기준점에서 떨어진 범위). 드론이 늘어도 주인 자리를 벗어나지 않게 한다 (옆 팀원 · 옆 포드를 침범하지 않게)
  //   팀장: 몸 둘레 좌우 ±44px, 위아래로 납작하게
  //   앉은 팀원: 바깥쪽 옆구리 좁은 띠. 6 대가 넘으면 아래로 길어진다
  //   그 밖: 머리 위. 4 대가 넘으면 위로 길어진다
  //   서브의 서브: 부모 드론 바로 곁
  private droneArea(kind: string, count: number, out: number): { x0: number; x1: number; y0: number; y1: number } {
    const rows = Math.floor(Math.max(0, count - 1) / 6);
    if (kind === "wide") return { x0: -44, x1: 44, y0: -20, y1: 12 };
    if (kind === "side") return out < 0 ? { x0: -12, x1: 6, y0: -8, y1: 6 + rows * 9 } : { x0: -6, x1: 12, y0: -8, y1: 6 + rows * 9 };
    if (kind === "sub") return { x0: -11, x1: 11, y0: -7, y1: 5 };
    return { x0: -18, x1: 18, y0: -8 - Math.floor(Math.max(0, count - 1) / 4) * 9, y1: 4 };
  }

  // 구역 안을 돌아다닌다: 다음 지점까지 부드럽게 출발해 딱 멈추고, 잠깐 쉬었다가 다른 드론과 떨어진 새 지점을 고른다
  private wander(d: Drone, dt: number, kind: string, out: number) {
    const a = this.droneArea(kind, d.count, out);
    const rand = () => ({ x: a.x0 + Math.random() * (a.x1 - a.x0), y: a.y0 + Math.random() * (a.y1 - a.y0) });
    if (d.area !== kind) {
      // 구역이 바뀌면 (처음 · 주인이 앉거나 일어섬) 새 구역 아무 곳에서 시작한다
      const p = rand();
      d.area = kind;
      d.ox = d.fx = d.tx = p.x;
      d.oy = d.fy = d.ty = p.y;
      d.md = 0;
      d.wait = Math.random() * 0.6;
      return;
    }
    if (d.mt < d.md) {
      d.mt = Math.min(d.md, d.mt + dt);
      const k = easeInOut(d.mt / d.md);
      d.ox = d.fx + (d.tx - d.fx) * k;
      d.oy = d.fy + (d.ty - d.fy) * k;
      if (d.mt >= d.md) d.wait = 0.25 + Math.random() * 0.85;
      return;
    }
    d.wait -= dt;
    if (d.wait > 0) return;
    // 후보 몇 곳 가운데 같은 주인의 다른 드론 (가는 곳) 과 가장 먼 곳
    const others = [...this.drones.values()].filter((o) => o !== d && o.anchor === d.anchor && !o.leaving);
    let best = rand();
    let bestGap = -1;
    for (let i = 0; i < 5; i++) {
      const p = i ? rand() : best;
      const gap = Math.min(Infinity, ...others.map((o) => Math.hypot(o.tx - p.x, o.ty - p.y)));
      if (gap > bestGap) {
        best = p;
        bestGap = gap;
      }
    }
    d.fx = d.ox;
    d.fy = d.oy;
    d.tx = best.x;
    d.ty = best.y;
    d.mt = 0;
    d.md = clamp(Math.hypot(d.tx - d.fx, d.ty - d.fy) / DRONE_SPEED, 0.25, 0.8);
  }

  // 드론이 있어야 할 곳 (기준점 + 구역 안 지금 위치). dt 만큼 돌아다니기도 진행한다
  orbitPos(d: Drone, dt = 0): { x: number; y: number; behind?: boolean } {
    const parentDrone = this.drones.get(d.anchor);
    if (parentDrone) {
      this.wander(d, dt, "sub", 1);
      return { x: parentDrone.x + d.ox, y: parentDrone.y + d.oy };
    }
    const av = this.avatars.get(d.anchor);
    const c = av ? orbitCenter(av) : { ...center(DOOR.ax, DOOR.ay - 1), kind: "head" as const };
    this.wander(d, dt, c.kind, av && c.x < av.x ? -1 : 1);
    return { x: c.x + d.ox, y: c.y + d.oy, behind: c.kind === "wide" && d.oy < -4 };
  }

  // 던진 책상: 포물선으로 날아 자리에 쿵 내려앉는다. 그 사이 주인이 다른 데로 가게 됐거나 내려앉을 자리가 없으면 작은 충격파와 함께 사라진다
  private updateDesks(dt: number) {
    this.desks = this.desks.filter((d) => {
      d.t += dt;
      const k = Math.min(1, d.t / d.dur);
      d.x = d.sx + (d.tx - d.sx) * k;
      d.y = d.sy + (d.ty - d.sy) * k;
      d.z = slam(k, d.h);
      if (k < 1) return true;
      const owner = this.avatars.get(d.owner);
      const g = owner?.goal;
      const l = d.land;
      const still = !!l && !!g && g.kind === l.kind && g.pod === l.pod && (l.kind !== "mate" || (g.kind === "mate" && g.idx === l.idx));
      if (still && l) {
        if (l.kind === "lead") this.placedDesks.add(l.pod.id);
        else owner!.deskDown = true;
        this.impact(d.x, d.y + (d.big ? 8 : 6), d.big ? 1.6 : 1);
      } else this.impact(d.x, d.y, 0.5, false);
      return false;
    });
    for (const r of this.rings) r.age += dt;
    this.rings = this.rings.filter((r) => r.age < r.life);
    this.shake *= Math.exp(-dt * 12);
    if (this.shake < 0.2) this.shake = 0;
  }

  update(dt: number) {
    for (const [key, av] of this.avatars) {
      av.phase += dt;
      if (av.gone) {
        this.avatars.delete(key);
        continue;
      }
      if (av.steps.length) {
        this.runSteps(av, dt);
        continue;
      }
      if (av.pose === "selfie") {
        av.stepT += dt;
        // 세 장을 다 찍으면 갈 곳으로 걸어간다
        if (av.stepT >= SELFIE_S && av.goal?.kind === "mirror") this.go(av, av.goal.then, false);
        continue;
      }
      if (av.pose === "sitside") {
        // 탑에 쌓인 팀원은 바닥 칸에서 아래로 비켜 앉는다 (팀원 수가 바뀌면 층 간격도 바뀐다)
        const s = this.seatOf(av);
        if (s) av.y = center(s.x, s.y).y + s.drop;
        continue;
      }
      if (av.pose !== "walk") continue;
      let budget = SPEED * dt;
      while (budget > 0 && av.path.length) {
        const c = center(av.path[0].x, av.path[0].y);
        const dx = c.x - av.x;
        const dy = c.y - av.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.01) av.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
        if (d <= budget) {
          av.x = c.x;
          av.y = c.y;
          budget -= d;
          av.path.shift();
        } else {
          av.x += (dx / d) * budget;
          av.y += (dy / d) * budget;
          budget = 0;
        }
      }
      if (!av.path.length) this.arrive(av);
    }
    this.updateDesks(dt);
    for (const [key, d] of this.drones) {
      d.phase += dt;
      // 사람이 사라졌으면 출입문으로 날아간다
      const target = d.leaving ? center(DOOR.ax, DOOR.ay) : this.orbitPos(d, dt);
      d.behind = !d.leaving && "behind" in target && !!target.behind;
      const dx = target.x - d.x;
      const dy = target.y - d.y;
      const dist = Math.hypot(dx, dy);
      const step = FLY * dt;
      if (dist > 40 || d.leaving) {
        // 멀면 곧장 날아간다
        if (dist <= step) {
          d.x = target.x;
          d.y = target.y;
          if (d.leaving) this.drones.delete(key);
        } else {
          d.x += (dx / dist) * step;
          d.y += (dy / dist) * step;
        }
      } else {
        // 가까우면 자리를 바짝 따라간다 (박자에 맞춰 착 옮기는 움직임이 무뎌지지 않게)
        const k = Math.min(1, dt * 30);
        d.x += dx * k;
        d.y += dy * k;
      }
    }
  }
}
