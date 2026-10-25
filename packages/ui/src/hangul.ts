// 두벌식 한글 조합기. macOS 입력기가 이 앱의 글 칸에 붙지 않은 채 한국어 자판의 자모만 넘겨 줄 때 쓴다.
//
// 입력 소스를 바꾼 직후 WKWebView 에 입력기 연결이 안 되어 있으면 keydown 이 keyCode 229 가 아닌 "ㅎ" 로 오고
// 조합 이벤트도 바꿔 쓰기도 없이 자모가 하나씩 들어온다 (ㅎㅏㄴㄱㅡㄹ). 그때 자모를 여기서 직접 글자로 묶는다.
// 규칙은 macOS 두벌식과 같다: 같은 자음 두 번은 쌍자음이 되지 않고, 겹받침 뒤 모음이 오면 뒷자음이 다음 글자로 간다.

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ";

const VOWEL_PAIRS: Record<string, string> = { ㅗㅏ: "ㅘ", ㅗㅐ: "ㅙ", ㅗㅣ: "ㅚ", ㅜㅓ: "ㅝ", ㅜㅔ: "ㅞ", ㅜㅣ: "ㅟ", ㅡㅣ: "ㅢ" };
const FINAL_PAIRS: Record<string, string> = {
  ㄱㅅ: "ㄳ",
  ㄴㅈ: "ㄵ",
  ㄴㅎ: "ㄶ",
  ㄹㄱ: "ㄺ",
  ㄹㅁ: "ㄻ",
  ㄹㅂ: "ㄼ",
  ㄹㅅ: "ㄽ",
  ㄹㅌ: "ㄾ",
  ㄹㅍ: "ㄿ",
  ㄹㅎ: "ㅀ",
  ㅂㅅ: "ㅄ",
};
/** 겹받침 → [남는 받침, 다음 글자 첫소리] */
const FINAL_SPLIT: Record<string, [string, string]> = Object.fromEntries(Object.entries(FINAL_PAIRS).map(([k, v]) => [v, [k[0], k[1]]]));

/** 한국어 자판이 내는 호환 자모(ㄱ~ㅣ)인지 */
export function isJamo(key: string): boolean {
  return key.length === 1 && (CHO.includes(key) || JUNG.includes(key));
}

interface Syllable {
  cho: string;
  jung: string;
  jong: string;
}

const EMPTY: Syllable = { cho: "", jung: "", jong: "" };

function render(s: Syllable): string {
  if (s.cho && s.jung) {
    const code = 0xac00 + (CHO.indexOf(s.cho) * 21 + JUNG.indexOf(s.jung)) * 28 + Math.max(0, JONG.indexOf(s.jong || " "));
    return String.fromCharCode(code);
  }
  return s.cho || s.jung;
}

export class HangulComposer {
  private cur: Syllable = EMPTY;
  /** 지금 글자의 지난 상태들. 지우기(⌫)가 자모 하나씩 되돌린다 */
  private history: Syllable[] = [];

  /** 조합 중인 글자 (없으면 "") */
  get preedit(): string {
    return render(this.cur);
  }

  /** 자모 하나를 넣는다. 다 된 글자가 있으면 돌려준다 */
  feed(j: string): string {
    const s = this.cur;
    const consonant = CHO.includes(j);
    let done = "";
    let next: Syllable;
    if (consonant) {
      if (s.cho && s.jung && !s.jong && JONG.includes(j)) next = { ...s, jong: j };
      else if (s.jong && FINAL_PAIRS[s.jong + j]) next = { ...s, jong: FINAL_PAIRS[s.jong + j] };
      else {
        done = render(s);
        next = { cho: j, jung: "", jong: "" };
      }
    } else if (s.jong) {
      // 받침을 떼어 다음 글자 첫소리로 옮긴다
      const split = FINAL_SPLIT[s.jong];
      done = render({ ...s, jong: split ? split[0] : "" });
      next = { cho: split ? split[1] : s.jong, jung: j, jong: "" };
    } else if (s.jung) {
      const pair = VOWEL_PAIRS[s.jung + j];
      if (pair) next = { ...s, jung: pair };
      else {
        done = render(s);
        next = { cho: "", jung: j, jong: "" };
      }
    } else next = { ...s, jung: j };
    // 새 글자가 시작되면 그 글자의 지난 상태를 처음부터 다시 쌓는다 (각 + ㅏ → 가 + 가 의 지난 상태는 빈 글자, ㄱ)
    if (done) this.history = next.cho && next.jung ? [EMPTY, { ...EMPTY, cho: next.cho }] : [EMPTY];
    else this.history.push(s);
    this.cur = next;
    return done;
  }

  /** 조합 중인 글자에서 자모 하나를 지운다. 지울 것이 없으면 false */
  backspace(): boolean {
    if (!this.preedit) return false;
    this.cur = this.history.pop() ?? EMPTY;
    return true;
  }

  /** 조합을 끝내고 남은 글자를 돌려준다 */
  flush(): string {
    const out = this.preedit;
    this.cur = EMPTY;
    this.history = [];
    return out;
  }
}
