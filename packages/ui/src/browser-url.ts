// 브라우저 칸 주소 칸에 친 글을 주소로 바꾸는 규칙.

/** 이 컴퓨터를 가리키는 이름: localhost, *.localhost(Caddy 같은 로컬 프록시), 루프백 · 0.0.0.0 */
const LOCAL_HOST = /^(([\w-]+\.)*localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i;

/** 스킴 없이 친 `호스트:포트…` (worky.localhost:2800/x, example.com:8080). `이름:` 을 스킴으로 읽으면 안 된다 */
const HOST_PORT = /^[\w.-]+:\d+(?=[/?#]|$)/;

/** 주소 칸에 친 글을 주소로 바꾼다. 주소처럼 보이지 않으면 검색한다 */
export function toUrl(input: string): string {
  const t = input.trim();
  if (!t) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !HOST_PORT.test(t)) return t;
  if (looksLikeUrl(t)) return `${LOCAL_HOST.test(t) ? "http" : "https"}://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

/** localhost:3000, example.com/path, 192.168.0.1 같은 글인지 */
export function looksLikeUrl(t: string): boolean {
  const s = t.trim();
  if (/\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#].*)?$/i.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(s);
}
