import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// 직접 더한 글자 크기(text-2xs, text-3xs)를 알려 주지 않으면 tailwind-merge 가 글자색 클래스와 겹친다고 보고 지운다
const twMerge = extendTailwindMerge({ extend: { classGroups: { "font-size": [{ text: ["2xs", "3xs"] }] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
