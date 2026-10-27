// 포트 주소 만들기와 탭 · 워크트리 포트 고르기.

import type { ListenPort, ProcessReport } from "@thuminal/term-core";
import { describe, expect, it } from "vitest";

import { formatBytes, portsOfSessions, portsOfWorktree, portUrl } from "../src/processes";

const port = (p: Partial<ListenPort>): ListenPort => ({
  port: 3000,
  address: "*",
  pid: 1,
  process: "node",
  command: "node server.js",
  cwd: null,
  session: null,
  worktree: null,
  via: "external",
  ...p,
});

describe("portUrl", () => {
  it("모든 주소는 localhost, 443 · 8443 은 https", () => {
    expect(portUrl(port({ address: "*" }))).toBe("http://localhost:3000");
    expect(portUrl(port({ address: "0.0.0.0", port: 8443 }))).toBe("https://localhost:8443");
    expect(portUrl(port({ address: "[::]", port: 443 }))).toBe("https://localhost:443");
    expect(portUrl(port({ address: "127.0.0.1" }))).toBe("http://127.0.0.1:3000");
    expect(portUrl(port({ address: "[::1]" }))).toBe("http://[::1]:3000");
  });

  it("원격 컴퓨터 포트는 그 컴퓨터 이름으로", () => {
    expect(portUrl(port({ address: "*" }), "100.64.0.2")).toBe("http://100.64.0.2:3000");
    expect(portUrl(port({ address: "127.0.0.1" }), "fd7a:115c::1")).toBe("http://[fd7a:115c::1]:3000");
    // 특정 주소에서만 받으면 그 주소 그대로
    expect(portUrl(port({ address: "192.168.0.5" }), "100.64.0.2")).toBe("http://192.168.0.5:3000");
  });
});

describe("포트 고르기", () => {
  const report: ProcessReport = {
    daemon: { pid: 9, ppid: 1, depth: 0, cpu: 0, rss: 0, command: "thuminald", ports: [] },
    sessions: [],
    ports: [
      port({ port: 8766, session: 2, worktree: "/w/a", via: "tree" }),
      port({ port: 8765, session: 1, worktree: "/w/a", via: "tree" }),
      port({ port: 4000, worktree: "/w/a", via: "cwd" }),
      port({ port: 5000, worktree: "/w/b", via: "command" }),
      port({ port: 7000 }),
    ],
    ports_truncated: false,
    ports_error: null,
  };

  it("탭은 그 세션들 포트만, 번호 차례로", () => {
    expect(portsOfSessions(report, [2, 1]).map((p) => p.port)).toEqual([8765, 8766]);
    expect(portsOfSessions(report, [3])).toEqual([]);
    expect(portsOfSessions(null, [1])).toEqual([]);
  });

  it("워크트리는 세션 · 폴더 · 명령줄로 붙은 것 모두", () => {
    expect(portsOfWorktree(report, "/w/a").map((p) => p.port)).toEqual([8766, 8765, 4000]);
    expect(portsOfWorktree(report, "/w/b").map((p) => p.port)).toEqual([5000]);
  });

  it("크기 글", () => {
    expect(formatBytes(512 * 1024)).toBe("512 KB");
    expect(formatBytes(31.8 * 1024 * 1024)).toBe("31.8 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});
