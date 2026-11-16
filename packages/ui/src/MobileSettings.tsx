// 폰 설정 화면. 데스크톱 설정창(Settings.tsx)의 항목을 쓰되, 폰에서는 항목 목록 → 항목 화면으로 넘어간다.
//
// 테마 · 터미널 글꼴은 데스크톱과 같은 컴포넌트다. 알림 · 컴퓨터 · 정보는 폰에서 하는 일이 달라 여기서 그린다:
// 알림 종류는 안드로이드 설정이 들고, 컴퓨터 목록은 앱 첫 화면이 들고, 앱 업데이트는 앱(Updater)이 한다.

import { BellIcon, CaretRightIcon, DesktopIcon, InfoIcon, PaletteIcon, TextAaIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { appBridge, type AppUpdateInfo } from "./app-bridge";
import { cn } from "./lib/utils";
import { Header } from "./mobile-parts";
import { button, FontSection, Group, Row, ThemeSection } from "./Settings";
import { useModel } from "./store";

/** 폰 터미널 글자 크기를 남기는 키 */
export const FONT_KEY = "thuminal.mobileFontSize";
/** 폰 터미널 글자 크기 기본값 (글꼴 · 굵기는 설정창 값을 쓴다) */
export const MOBILE_FONT_SIZE = 12;
const FONT_MIN = 8;
const FONT_MAX = 20;

/** GitHub 에 게시한 최신 APK (업데이트를 확인하지 못하는 옛 앱이 한 번 손으로 받는다) */
const APK_URL = "https://github.com/whquddn55/thuminal/releases/latest/download/thuminal.apk";

export type SettingsPage = "theme" | "font" | "notify" | "computers" | "about";

const PAGES: { id: SettingsPage; label: string; icon: React.ReactNode; desc: string; app?: boolean }[] = [
  { id: "theme", label: "테마", icon: <PaletteIcon />, desc: "누르면 바로 바뀌어요." },
  { id: "font", label: "터미널 글꼴", icon: <TextAaIcon />, desc: "글꼴 · 굵기는 데스크톱과 같고, 글자 크기는 이 폰에만 남아요." },
  { id: "notify", label: "알림", icon: <BellIcon />, desc: "에이전트가 묻거나 일을 마쳤을 때 알려요.", app: true },
  { id: "computers", label: "컴퓨터", icon: <DesktopIcon />, desc: "연결한 컴퓨터를 고르거나 더해요.", app: true },
  { id: "about", label: "정보", icon: <InfoIcon />, desc: "버전과 업데이트" },
];

/** 설정 화면. page 가 없으면 항목 목록 */
export function SettingsScreen({ page, go, back }: { page?: SettingsPage; go: (page: SettingsPage) => void; back: () => void }) {
  const inApp = appBridge() !== null;
  const cur = PAGES.find((p) => p.id === page);
  if (!cur) {
    return (
      <>
        <Header title="설정" back={back} />
        <div className="min-h-0 flex-1 overflow-y-auto pt-2 pb-[env(safe-area-inset-bottom)]">
          {PAGES.filter((p) => inApp || !p.app).map((p) => (
            <button
              key={p.id}
              className="mx-2 flex min-h-14 w-[calc(100%-1rem)] items-center gap-3 rounded-lg px-3 py-2 text-left active:bg-accent [&_svg]:size-5 [&_svg]:shrink-0"
              onClick={() => go(p.id)}
            >
              <span className="text-muted-foreground">{p.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px]">{p.label}</span>
                <span className="block truncate text-[12px] text-muted-foreground">{p.desc}</span>
              </span>
              {p.id === "about" && <UpdateDot />}
              <CaretRightIcon className="size-4 text-muted-foreground" />
            </button>
          ))}
        </div>
      </>
    );
  }
  return (
    <>
      <Header title={cur.label} sub={cur.desc} back={back} />
      <div key={cur.id} className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+24px)] select-text">
        {cur.id === "theme" ? <ThemeSection /> : cur.id === "font" ? <PhoneFont /> : cur.id === "notify" ? <PhoneNotify /> : cur.id === "computers" ? <PhoneComputers /> : <PhoneAbout />}
      </div>
    </>
  );
}

function PhoneFont() {
  const [size, setSize] = useState(() => Number(localStorage.getItem(FONT_KEY)) || MOBILE_FONT_SIZE);
  const set = (n: number) => {
    localStorage.setItem(FONT_KEY, String(n));
    setSize(n);
  };
  return <FontSection size={{ value: size, min: FONT_MIN, max: FONT_MAX, set }} />;
}

function PhoneNotify() {
  const bridge = appBridge();
  return (
    <Group note="알림은 데스크톱 데몬이 보내요. 데스크톱 설정 → 알림에서 고른 것과 상관없이, 이 폰은 아래 안드로이드 설정을 따라요.">
      <Row title="알림 종류" desc="응답 대기 · 일 마침 · 오류처럼 종류마다 안드로이드 설정에서 끄고 켜요.">
        {bridge?.openNotifySettings ? (
          <button className={button} onClick={() => bridge.openNotifySettings?.()}>
            알림 설정 열기
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">앱을 업데이트하면 열 수 있어요</span>
        )}
      </Row>
    </Group>
  );
}

function PhoneComputers() {
  return (
    <Group note="컴퓨터를 더할 때는 그 컴퓨터 설정 → 원격 접속의 QR을 찍어요.">
      <Row title="컴퓨터 목록" desc="다른 컴퓨터를 고르거나, 이름을 바꾸거나, 더해요.">
        <button className={button} onClick={() => appBridge()?.changeServer()}>
          목록 열기
        </button>
      </Row>
    </Group>
  );
}

/** 앱이 알려 준 업데이트 정보와 진행. 옛 앱이면 info 가 null */
function useAppUpdate(): { info: AppUpdateInfo | null; status: string | null; checking: boolean; check: () => void; install: () => void } {
  const bridge = appBridge();
  const [info, setInfo] = useState<AppUpdateInfo | null>(() => {
    try {
      return bridge?.updateInfo ? (JSON.parse(bridge.updateInfo()) as AppUpdateInfo) : null;
    } catch {
      return null;
    }
  });
  const [status, setStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const w = window as unknown as { thuminalUpdate?: (j: string | null) => void; thuminalUpdateStatus?: (s: string) => void };
    w.thuminalUpdate = (j) => {
      setChecking(false);
      if (j) {
        setInfo(JSON.parse(j) as AppUpdateInfo);
        setStatus(null);
      } else setStatus("error:업데이트를 확인하지 못했어요");
    };
    w.thuminalUpdateStatus = setStatus;
    return () => {
      delete w.thuminalUpdate;
      delete w.thuminalUpdateStatus;
    };
  }, []);
  return {
    info,
    status,
    checking,
    check: () => {
      setChecking(true);
      bridge?.checkUpdate?.();
    },
    install: () => bridge?.installUpdate?.(),
  };
}

/** 새 앱 버전이 있으면 설정 목록 "정보" 줄에 점 */
function UpdateDot() {
  const { info } = useAppUpdate();
  return info?.latest ? <span className="size-2 rounded-full bg-primary" aria-label={`새 버전 ${info.latest}`} /> : null;
}

function PhoneAbout() {
  const model = useModel();
  const bridge = appBridge();
  const [daemon, setDaemon] = useState<{ version: string; engine: string } | null>(null);
  useEffect(() => {
    void model.services.host.daemon().then(setDaemon, () => undefined);
  }, [model]);
  const { info, status, checking, check, install } = useAppUpdate();
  const busy = status === "downloading" || status === "installing";
  const desc = checking
    ? "확인하는 중…"
    : status === "downloading"
      ? "받는 중이에요…"
      : status === "installing"
        ? "설치 창에서 업데이트를 눌러 주세요."
        : status === "permission"
          ? "설치를 허용한 뒤 다시 눌러 주세요."
          : status?.startsWith("error:")
            ? status.slice(6)
            : info?.latest
              ? `새 버전이 있어요: ${info.latest}`
              : "최신 버전이에요. 6시간마다 저절로 확인해요.";
  return (
    <>
      <Group>
        <Row title="앱" desc={info ? `thuminal ${info.current}` : bridge ? "업데이트를 확인하지 못하는 옛 버전" : "브라우저"} />
        <Row title="데스크톱 데몬" desc={daemon ? `thuminal ${daemon.version} · 엔진 ${daemon.engine}` : "읽는 중…"} />
      </Group>
      {info ? (
        <Group note="새 버전은 GitHub에 게시한 Release에서 받아요. 처음 한 번은 이 앱이 설치하도록 허용해야 해요.">
          <Row title="업데이트" desc={<span className={cn(status?.startsWith("error:") && "text-destructive", info.latest && !status && "text-foreground")}>{desc}</span>}>
            <button className={button} disabled={checking || busy} onClick={check}>
              확인
            </button>
            {info.latest && (
              <button className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-50" disabled={busy} onClick={install}>
                업데이트
              </button>
            )}
          </Row>
        </Group>
      ) : (
        bridge && (
          <Group note="이 버전의 앱은 업데이트를 스스로 확인하지 못해요. 새 앱을 한 번 받아 깔면 그다음부터는 앱이 알려 줘요.">
            <Row title="새 앱 받기" desc="폰 브라우저에서 받아요. 같은 앱 위에 덮어 깔리고 컴퓨터 목록은 남아요.">
              <a className={cn(button, "inline-flex items-center")} href={APK_URL}>
                받기
              </a>
            </Row>
          </Group>
        )
      )}
    </>
  );
}
