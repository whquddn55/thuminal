// 글자색 대비 보정 (xterm minimumContrastRatio 와 같은 일). 색은 0xRRGGBB.
// 배경은 그대로 두고 글자색만 밝은 배경이면 어둡게, 어두운 배경이면 밝게 옮긴다.

const lin = (v: number) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function luminance(c: number): number {
  return 0.2126 * lin((c >> 16) & 255) + 0.7152 * lin((c >> 8) & 255) + 0.0722 * lin(c & 255);
}

export function contrast(a: number, b: number): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** a 를 p(0~1) 만큼, b 를 나머지만큼 섞는다 (CSS color-mix in srgb) */
export function mix(a: number, b: number, p: number): number {
  const m = (s: number) => Math.round(((a >> s) & 255) * p + ((b >> s) & 255) * (1 - p));
  return (m(16) << 16) | (m(8) << 8) | m(0);
}

/** fg 가 bg 위에서 ratio 이상 대비가 나게 고친 색. 이미 되면 fg 그대로 */
export function readable(fg: number, bg: number, ratio: number): number {
  if (contrast(fg, bg) >= ratio) return fg;
  const lb = luminance(bg);
  const towardBlack = (lb + 0.05) / 0.05 > 1.05 / (lb + 0.05);
  const at = (t: number) => (towardBlack ? mix(0x000000, fg, t) : mix(0xffffff, fg, t));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const t = (lo + hi) / 2;
    if (contrast(at(t), bg) >= ratio) hi = t;
    else lo = t;
  }
  return at(hi);
}
