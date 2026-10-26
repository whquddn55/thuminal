// 파일 이름으로 찾기: 오른쪽 사이드바 거르기, 새 탭 메뉴 찾기 칸, Markdown 열기가 같이 쓴다.

/** 파일 이름에 든 것 먼저, 그다음 경로에 든 것, 글자가 차례로 든 것. 같은 줄이면 짧은 경로가 앞이다 */
export function matchFiles(files: string[], query: string, limit: number): string[] {
  const q = query.toLowerCase();
  const scored: [number, string][] = [];
  for (const f of files) {
    const low = f.toLowerCase();
    const name = low.slice(low.lastIndexOf("/") + 1);
    let score = -1;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (low.includes(q)) score = 2;
    else {
      let i = 0;
      for (const ch of low) if (ch === q[i]) i++;
      if (i === q.length) score = 3;
    }
    if (score >= 0) scored.push([score, f]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
  return scored.slice(0, limit).map(([, f]) => f);
}

/** 경로의 마지막 이름 */
export function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** 경로의 폴더 부분. 맨 위면 빈 글 */
export function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
