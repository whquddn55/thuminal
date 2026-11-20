// 화면 보호기 설정. 터미널 글꼴처럼 이 앱(localStorage)에 남긴다. 처음에는 꺼져 있다.

import { create } from "zustand";

export interface IdleScreenSettings {
  enabled: boolean;
  /** 창 안에서 입력이 이만큼(분) 없으면 띄운다 */
  minutes: number;
}

export const IDLE_MINUTES_MIN = 1;
export const IDLE_MINUTES_MAX = 120;
const DEFAULT: IdleScreenSettings = { enabled: false, minutes: 10 };
const KEY = "thuminal.idleScreen";

function load(): IdleScreenSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

export const useIdleScreenSettings = create<IdleScreenSettings>(load);

export function setIdleScreenSettings(patch: Partial<IdleScreenSettings>) {
  const next = { ...useIdleScreenSettings.getState(), ...patch };
  next.minutes = Math.round(Math.min(IDLE_MINUTES_MAX, Math.max(IDLE_MINUTES_MIN, next.minutes || DEFAULT.minutes)));
  useIdleScreenSettings.setState(next);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 저장하지 못해도 이번 실행에는 쓴다
  }
}
