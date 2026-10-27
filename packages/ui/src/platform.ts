// 화면을 띄운 컴퓨터의 OS. 창 꾸밈과 단축키 표시가 여기에 따라 갈린다
// (원격 웹 화면이면 데몬이 도는 컴퓨터가 아니라 브라우저를 띄운 기기다)

const ua = typeof navigator === "undefined" ? "" : `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;

/** macOS · iPadOS · iOS. 창 단추(신호등)가 화면 위에 얹히고, 단축키는 ⌘ 를 쓴다 */
export const IS_MAC = /Mac|iPhone|iPad|iPod/.test(ua);
