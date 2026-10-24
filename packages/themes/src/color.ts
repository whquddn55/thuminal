// 색 계산 도우미. 색은 0xRRGGBB 숫자로 다룬다.

/** `#rrggbb` → 0xRRGGBB */
export function parseHex(hex: string): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`#rrggbb 꼴이 아니다: ${hex}`);
  return parseInt(hex.slice(1), 16);
}

/** 0xRRGGBB → `#rrggbb` */
export function toHex(c: number): string {
  return `#${(c & 0xffffff).toString(16).padStart(6, "0")}`;
}

const ch = (c: number, shift: number) => (c >> shift) & 255;
const pack = (r: number, g: number, b: number) =>
  (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);

/** CSS `color-mix(in srgb, a p, b)` 와 같다 (p 는 0~1, a 의 몫) */
export function mix(a: number, b: number, p: number): number {
  const m = (s: number) => ch(a, s) * p + ch(b, s) * (1 - p);
  return pack(m(16), m(8), m(0));
}

/** WCAG 상대 밝기 (0~1) */
export function luminance(c: number): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(ch(c, 16)) + 0.7152 * lin(ch(c, 8)) + 0.0722 * lin(ch(c, 0));
}

/** WCAG 대비 (1~21) */
export function contrast(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 배경이 밝은가 (검정 글자가 흰 글자보다 잘 읽히면 밝다) */
export function isLight(bg: number): boolean {
  return contrast(bg, 0x000000) > contrast(bg, 0xffffff);
}

/**
 * c 가 bg 위에서 ratio 이상 대비가 나도록 고친다. 이미 되면 그대로 돌려준다.
 * 밝은 배경이면 채널을 같은 비율로 줄여(색조를 지키며) 어둡게, 어두운 배경이면 흰색 쪽으로 섞어 밝게 한다.
 */
export function ensureContrast(c: number, bg: number, ratio: number): number {
  if (contrast(c, bg) >= ratio) return c;
  const towardBlack = isLight(bg);
  const at = (t: number) =>
    towardBlack ? pack(ch(c, 16) * (1 - t), ch(c, 8) * (1 - t), ch(c, 0) * (1 - t)) : mix(0xffffff, c, t);
  // t 를 0 → 1 로 늘릴수록 대비가 커진다. 맞는 가장 작은 t 를 찾는다
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const t = (lo + hi) / 2;
    if (contrast(at(t), bg) >= ratio) hi = t;
    else lo = t;
  }
  return at(hi);
}
