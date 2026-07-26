import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 멀티 세션 개발용 — DEV_API_PORT로 백엔드 포트 지정 (기본 4000)
const api = `http://localhost:${process.env.DEV_API_PORT ?? 4000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/socket.io': { target: api, changeOrigin: true, ws: true },
      '/sync': { target: api, ws: true },
      '/yjs': { target: api, ws: true },
    },
  },
});
