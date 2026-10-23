// term-core HostApi 의 Tauri 구현. src-tauri/src/lib.rs 의 명령을 부른다.

import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Attachment,
  CreateSession,
  DaemonEvent,
  DaemonInfo,
  HostApi,
  RepoInfo,
  SessionId,
  SessionInfo,
  SnapshotFormat,
  WorktreeInfo,
} from "@thuminal/term-core";

export class TauriHostApi implements HostApi {
  private listeners = new Set<(e: DaemonEvent) => void>();
  private subscribed: Promise<void> | null = null;
  private info: Promise<DaemonInfo> | null = null;

  daemon(): Promise<DaemonInfo> {
    this.info ??= invoke<DaemonInfo>("daemon_info");
    return this.info;
  }

  listSessions(): Promise<SessionInfo[]> {
    return invoke("list_sessions");
  }

  createSession(req: CreateSession): Promise<SessionInfo> {
    return invoke("create_session", { req });
  }

  async attach(id: SessionId, format: SnapshotFormat, onOutput: (bytes: Uint8Array) => void): Promise<Attachment> {
    // 채널의 첫 메시지는 저장본, 그 뒤는 출력이다 (src-tauri attach 명령 참고)
    let snapshot: Uint8Array | null = null;
    let resolveSnapshot!: () => void;
    const gotSnapshot = new Promise<void>((r) => (resolveSnapshot = r));
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buf) => {
      const bytes = new Uint8Array(buf);
      if (snapshot === null) {
        snapshot = bytes;
        resolveSnapshot();
      } else {
        onOutput(bytes);
      }
    };
    const r = await invoke<{ session: SessionInfo; format: SnapshotFormat }>("attach", { id, format, channel });
    await gotSnapshot;
    return {
      session: r.session,
      format: r.format,
      snapshot: snapshot!,
      detach: () => invoke("detach", { id }),
    };
  }

  input(id: SessionId, bytes: Uint8Array): Promise<void> {
    return invoke("input", { id, data: Array.from(bytes) });
  }

  resize(id: SessionId, cols: number, rows: number): Promise<void> {
    return invoke("resize", { id, cols, rows });
  }

  setLabels(id: SessionId, labels: Record<string, string>): Promise<void> {
    return invoke("set_labels", { id, labels });
  }

  kill(id: SessionId): Promise<void> {
    return invoke("kill", { id });
  }

  remove(id: SessionId): Promise<void> {
    return invoke("remove", { id });
  }

  listRepos(): Promise<RepoInfo[]> {
    return invoke("list_repos");
  }

  addRepo(path: string): Promise<RepoInfo> {
    return invoke("add_repo", { path });
  }

  removeRepo(repo: string): Promise<void> {
    return invoke("remove_repo", { repo });
  }

  listWorktrees(): Promise<WorktreeInfo[]> {
    return invoke("list_worktrees");
  }

  createWorktree(repo: string, branch: string, base?: string): Promise<WorktreeInfo> {
    return invoke("create_worktree", { repo, branch, base: base ?? null });
  }

  removeWorktree(repo: string, path: string, opts: { force: boolean; deleteBranch: boolean }): Promise<void> {
    return invoke("remove_worktree", { repo, path, force: opts.force, deleteBranch: opts.deleteBranch });
  }

  async registerFont(family: string): Promise<number> {
    const faces = await invoke<{ id: number; weight: number; italic: boolean }[]>("font_faces", { family });
    await Promise.all(
      faces.map(async (f) => {
        const data = await invoke<ArrayBuffer>("font_face_data", { id: f.id });
        const face = new FontFace(family, data, { weight: String(f.weight), style: f.italic ? "italic" : "normal" });
        document.fonts.add(await face.load());
      }),
    );
    return faces.length;
  }

  onEvent(cb: (e: DaemonEvent) => void): () => void {
    this.listeners.add(cb);
    this.subscribed ??= (async () => {
      const channel = new Channel<DaemonEvent>();
      channel.onmessage = (e) => {
        for (const l of this.listeners) l(e);
      };
      await invoke("subscribe_events", { channel });
    })();
    return () => this.listeners.delete(cb);
  }
}
