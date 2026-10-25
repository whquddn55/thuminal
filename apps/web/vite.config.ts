import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 개발 중에는 `pnpm -C apps/web dev` 로 띄우고 데몬 원격 접속(기본 6780)으로 웹소켓·API 를 넘긴다
const daemon = process.env.THUMINAL_REMOTE ?? "http://127.0.0.1:6780";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1431, strictPort: true, proxy: { "/ws": { target: daemon, ws: true }, "/api": daemon } },
  build: { target: ["safari16", "chrome110"] },
});
