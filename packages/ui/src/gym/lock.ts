// 화면 보호기 잠금. 암호를 정하면 잠금이 켜지고, 화면 보호기를 닫을 때 그 암호를 묻는다.
//
// - 암호는 원문이 아니라 소금을 친 해시로 이 앱(localStorage)에 남긴다. 원격 접속 웹 화면은 http 로 열려 crypto.subtle 이 없을 수 있어
//   SHA-256 을 직접 돌린다 (소금 + 앞 결과를 `ROUNDS` 번 거듭 해시한다).
// - 잠긴 채 앱을 끄면 다시 켤 때도 잠긴 화면으로 시작한다 (`LOCKED_KEY`). ⌘Q 로 잠금을 건너뛰지 못하게 한다.
// - 암호를 잊으면 앱을 끄고 데이터 폴더에 `idle-lock-reset` 파일을 만든 뒤 다시 켠다 (껍데기 `idleLockReset`). 웹은 브라우저의 사이트 데이터를 지운다.
//   잠금은 thuminal 창만 가린다. 데몬 밑 터미널은 CLI 로도 읽히므로, 이 컴퓨터 계정을 쓸 수 있는 사람을 막는 것은 OS 화면 잠금이다.

import { create } from "zustand";

const KEY = "thuminal.idleLock";
const LOCKED_KEY = "thuminal.idleLocked";
const ROUNDS = 20_000;

interface Stored {
  salt: string;
  hash: string;
  rounds: number;
}

function read(): Stored | null {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Stored) : null;
    return v?.salt && v.hash ? v : null;
  } catch {
    return null;
  }
}

/** 잠금이 켜져 있는지 (암호를 정했는지) */
export const useIdleLock = create<{ on: boolean }>(() => ({ on: read() !== null }));

export function lockOn(): boolean {
  return useIdleLock.getState().on;
}

export function setLockPassword(password: string) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const v: Stored = { salt, hash: hashPassword(password, salt, ROUNDS), rounds: ROUNDS };
  localStorage.setItem(KEY, JSON.stringify(v));
  useIdleLock.setState({ on: true });
}

export function clearLock() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LOCKED_KEY);
  } catch {
    // 지우지 못해도 이번 실행에는 꺼진다
  }
  useIdleLock.setState({ on: false });
}

export function checkPassword(password: string): boolean {
  const v = read();
  if (!v) return true;
  return same(hashPassword(password, v.salt, v.rounds || ROUNDS), v.hash);
}

/** 잠긴 채 앱을 껐는지 */
export function wasLocked(): boolean {
  try {
    return lockOn() && localStorage.getItem(LOCKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markLocked(locked: boolean) {
  try {
    if (locked) localStorage.setItem(LOCKED_KEY, "1");
    else localStorage.removeItem(LOCKED_KEY);
  } catch {
    // 남기지 못하면 다시 켤 때 잠기지 않을 뿐이다
  }
}

function hashPassword(password: string, salt: string, rounds: number): string {
  const enc = new TextEncoder();
  const saltBytes = enc.encode(salt);
  let h = sha256(concat(saltBytes, enc.encode(password)));
  for (let i = 1; i < rounds; i++) h = sha256(concat(saltBytes, h));
  return hex(h);
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4) */
export function sha256(data: Uint8Array): Uint8Array {
  const len = data.length;
  const blocks = Math.ceil((len + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(data);
  buf[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(bits / 0x1_0000_0000));
  dv.setUint32(buf.length - 4, bits >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let b = 0; b < blocks; b++) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(b * 64 + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, bb, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    H[0] += a;
    H[1] += bb;
    H[2] += c;
    H[3] += d;
    H[4] += e;
    H[5] += f;
    H[6] += g;
    H[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}
