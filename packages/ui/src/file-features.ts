// 화면이 데몬 새 기능(파일 쓰기 · 바이트 읽기, 브라우저 칸 대리 …)을 써도 되는지, 파일이 그림 · 영상 · 소리인지.
//
// 옛 데몬은 모르는 요청을 받으면 연결을 끊는다. 그래서 데몬 부 판이 그 기능이 생긴 판 이상일 때만 새 요청을 보낸다.
// 데몬을 다시 띄우면 `daemon_reconnected` 가 오고 판을 다시 본다.

import { useEffect, useState } from "react";

import { FILES_PROTOCOL_MINOR, type HostApi } from "@thuminal/term-core";

/** 이 호스트 데몬의 프로토콜 부 판이 `minor` 이상인지. 모르는 동안(묻는 중)은 null */
export function useDaemonSupports(host: HostApi, minor: number): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      void host.daemon().then(
        (d) => alive && setOk((d.protocol?.[1] ?? 0) >= minor && (d.protocol?.[0] ?? 0) >= 1),
        () => alive && setOk(false),
      );
    check();
    const stop = host.onEvent((e) => e.type === "daemon_reconnected" && check());
    return () => {
      alive = false;
      stop();
    };
  }, [host, minor]);
  return ok;
}

/** 이 호스트 데몬이 파일 쓰기 · 바이트 읽기를 아는지. 모르는 동안(묻는 중)은 null */
export function useFilesSupported(host: HostApi): boolean | null {
  return useDaemonSupports(host, FILES_PROTOCOL_MINOR);
}

export type MediaKind = "image" | "video" | "audio";

const MEDIA: Record<string, MediaKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  svg: "image",
  heic: "image",
  mp4: "video",
  m4v: "video",
  mov: "video",
  webm: "video",
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  flac: "audio",
};

/** 확장자로 본 미디어 종류. 아니면 null (데몬 `thuminal_protocol::media::content_type` 과 같은 목록) */
export function mediaKind(file: string): MediaKind | null {
  const ext = /\.([^./]+)$/.exec(file)?.[1]?.toLowerCase();
  return (ext && MEDIA[ext]) || null;
}
