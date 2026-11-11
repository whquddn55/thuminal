// 터미널 출력에서 OSC 52 클립보드 쓰기(`ESC ] 52 ; <대상> ; <base64> BEL|ST`)를 찾는다.
//
// 마우스를 받는 프로그램(원격 claude 등)은 직접 글을 고르고, 그 컴퓨터 클립보드 대신 이 신호로 터미널에 복사를 맡긴다.
// 출력은 조각으로 오므로 신호가 두 조각에 걸쳐도 이어 본다. 읽기 요청(`?`)에는 답하지 않는다 (원격 프로그램이 이 컴퓨터
// 클립보드를 읽지 못하게). 엔진에는 출력을 그대로 넘기고 이것은 옆에서 보기만 한다.

const PREFIX = [0x1b, 0x5d, 0x35, 0x32, 0x3b]; // ESC ] 5 2 ;
/** 이보다 긴 신호는 버린다 */
const MAX_BYTES = 8 << 20;

export class Osc52Scanner {
  /** 시작 부분을 찾은 뒤 모으는 본문 (`<대상>;<base64>`). 없으면 신호 밖이다 */
  private body: number[] | null = null;
  /** 앞 조각 끝에 걸린 시작 부분 길이 (PREFIX 의 앞 몇 바이트) */
  private partial = 0;
  /** 앞 조각이 ESC 로 끝났다 (ST = ESC \ 의 앞 반) */
  private esc = false;

  /** 조각 하나를 본다. 이 조각에서 끝난 복사 글들을 돌려준다 */
  scan(bytes: Uint8Array): string[] {
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (this.body) {
        if (b === 0x07 || (this.esc && b === 0x5c)) {
          const text = decode(this.body);
          if (text !== null) out.push(text);
          this.body = null;
          this.esc = false;
          continue;
        }
        if (this.esc) this.body.push(0x1b);
        this.esc = b === 0x1b;
        if (!this.esc) this.body.push(b);
        if (this.body.length > MAX_BYTES) this.body = null;
        continue;
      }
      if (b === PREFIX[this.partial]) {
        this.partial++;
        if (this.partial === PREFIX.length) {
          this.body = [];
          this.partial = 0;
        }
      } else this.partial = b === PREFIX[0] ? 1 : 0;
    }
    return out;
  }
}

/** `<대상>;<base64>` 를 글로 푼다. 읽기 요청 · 지우기 · 잘못된 것은 null */
function decode(body: number[]): string | null {
  const s = String.fromCharCode(...body.slice(0, 64));
  const semi = s.indexOf(";");
  if (semi < 0) return null;
  let data = "";
  for (let i = semi + 1; i < body.length; i += 8192) data += String.fromCharCode(...body.slice(i, Math.min(body.length, i + 8192)));
  if (!data || data === "?") return null;
  try {
    const bin = atob(data);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(u8);
  } catch {
    return null;
  }
}
