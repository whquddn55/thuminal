// 안드로이드 앱(apps/android MainActivity.Bridge)이 웹 화면에 넣어 주는 기능 (window.ThuminalApp).
// 옛 앱에는 뒤에 더한 기능이 없으므로 `?` 로 두고 부르기 전에 있는지 본다.

export interface AppBridge {
  clipboardText(): string;
  copyText(text: string): void;
  forget(): void;
  changeServer(): void;
  /** 테마 색(JSON)을 앱에 남긴다. 앱 첫 화면(home.html)이 같은 색으로 그린다 */
  setTheme?(json: string): void;
  /** 앱 버전과 새 버전: {"current":"0.1.11","latest":"0.1.12"} (새 버전이 없으면 latest 는 null) */
  updateInfo?(): string;
  /** 지금 새 버전을 확인한다. 결과는 window.thuminalUpdate(info JSON 또는 확인하지 못했으면 null) */
  checkUpdate?(): void;
  /** 새 버전을 받아 설치 창을 띄운다. 진행은 window.thuminalUpdateStatus(status) */
  installUpdate?(): void;
  /** 안드로이드 앱 알림 설정을 연다 */
  openNotifySettings?(): void;
}

export function appBridge(): AppBridge | null {
  return (window as unknown as { ThuminalApp?: AppBridge }).ThuminalApp ?? null;
}

/** 앱 업데이트 정보 (AppBridge.updateInfo) */
export interface AppUpdateInfo {
  current: string;
  latest: string | null;
}
