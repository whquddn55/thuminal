// 인스턴스 하나 = 칸 하나. uvec4:
//   x: 열 | 줄 << 16
//   y: 글자 자리(24비트) | 넓은 글자 << 24 | 밑줄 << 25 | 취소선 << 26 | 컬러 글자 << 27
//   z: 글자색 0xRRGGBB
//   w: 배경색 0xRRGGBB

const COMMON = `#version 300 es
layout(location=0) in vec2 corner;
layout(location=1) in uvec4 inst;
uniform vec2 cell;
uniform vec2 view;
vec4 rgb(uint c) { return vec4(float((c >> 16) & 255u), float((c >> 8) & 255u), float(c & 255u), 255.0) / 255.0; }
vec4 place(vec2 c) {
  vec2 p = (vec2(float(inst.x & 0xffffu), float(inst.x >> 16)) + c) * cell;
  vec2 ndc = p / view * 2.0 - 1.0;
  return vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`;

export const VS_BG = `${COMMON}
out vec4 vColor;
void main() {
  gl_Position = place(corner);
  vColor = rgb(inst.w);
}`;

export const FS_BG = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 o;
void main() { o = vColor; }`;

export const VS_FG = `${COMMON}
uniform vec2 slotSize;
uniform float atlasCols;
uniform float atlasSize;
out vec4 vColor;
out vec2 vUv;
out vec2 vCell;
flat out uint vDeco;
flat out float vHasGlyph;
flat out float vColorGlyph;
void main() {
  uint slot = inst.y & 0xffffffu;
  uint deco = (inst.y >> 25) & 3u;
  if (slot == 0u && deco == 0u) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float wide = float((inst.y >> 24) & 1u) + 1.0;
  vec2 c = corner * vec2(wide, 1.0);
  gl_Position = place(c);
  float s = float(slot);
  vec2 origin = vec2(mod(s, atlasCols), floor(s / atlasCols)) * slotSize;
  vUv = (origin + c * cell) / atlasSize;
  vCell = c;
  vDeco = deco;
  vHasGlyph = slot == 0u ? 0.0 : 1.0;
  vColorGlyph = float((inst.y >> 27) & 1u);
  vColor = rgb(inst.z);
}`;

export const FS_FG = `#version 300 es
precision highp float;
uniform sampler2D atlas;
uniform vec2 cell;
in vec4 vColor;
in vec2 vUv;
in vec2 vCell;
flat in uint vDeco;
flat in float vHasGlyph;
flat in float vColorGlyph;
out vec4 o;
void main() {
  vec4 t = texture(atlas, vUv);
  float a = vHasGlyph * t.a;
  // 컬러 글자(이모지)는 그림 색 그대로, 나머지는 글자색으로 칠한다
  vec3 c = vColorGlyph > 0.5 ? t.rgb : vColor.rgb;
  // 선 굵기는 기기 픽셀 1칸, 밑줄은 칸 아래쪽, 취소선은 가운데
  float px = 1.0 / cell.y;
  bool line = ((vDeco & 1u) != 0u && vCell.y > 1.0 - 2.5 * px && vCell.y < 1.0 - 1.0 * px) || ((vDeco & 2u) != 0u && abs(vCell.y - 0.55) < 0.75 * px);
  if (line) { a = 1.0; c = vColor.rgb; }
  if (a <= 0.0) discard;
  o = vec4(c, a);
}`;
