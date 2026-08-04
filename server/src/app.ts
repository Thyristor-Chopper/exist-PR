import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import authRouter from './auth.js';
import meetingsRouter from './meetings.js';
import todosRouter from './todos.js';
import agentRouter from './agent.js';
import workspacesRouter from './workspaces.js';
import orgsRouter from './orgs.js';
import dmRouter from './dm.js';
import notificationsRouter from './notifications.js';
import runnerRouter from './runner.js';
import insightsRouter from './insights.js';
import pushRouter from './push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';

/*
 * API 라우터·미들웨어가 마운트된 express app 을 만든다.
 * 소켓(Socket.IO)·미디어(mediasoup)·presence·리마인더는 index.ts 가 추가한다.
 * 이렇게 app 생성을 분리해야 통합 테스트(supertest)가 서버를 띄우지 않고 app 만 쓸 수 있다.
 */
export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // 리버스 프록시(HTTPS 종단) 뒤에서 req.ip 정상화
  if (!isProd) app.use(cors({ origin: CLIENT_ORIGIN }));
  app.use(express.json({ limit: '1mb' }));

  // 기본 보안 헤더
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'exist' }));
  app.use('/api/auth', authRouter);
  app.use('/api/meetings', meetingsRouter);
  app.use('/api/todos', todosRouter);
  app.use('/api/agent', agentRouter);
  app.use('/api/workspaces', workspacesRouter);
  app.use('/api/orgs', orgsRouter);
  app.use('/api/dm', dmRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/run', runnerRouter);
  app.use('/api/insights', insightsRouter);
  app.use('/api/push', pushRouter);

  // 프로덕션: 빌드된 클라이언트 정적 서빙 + SPA 폴백
  // ⚠️ index.html·sw.js는 no-cache 필수 — 헤더 없이 내보내면 브라우저 휴리스틱 캐시가
  // 옛 index.html(=옛 해시 번들 참조)을 물고 있어 배포해도 사용자 화면이 안 바뀐다.
  // 해시 붙은 /assets/* 는 내용이 곧 주소라 1년 immutable로 캐시.
  const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
  if (isProd && fs.existsSync(clientDist)) {
    app.use(
      express.static(clientDist, {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache');
          } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
    console.log(`[static] serving client from ${clientDist}`);
  }

  // 전역 에러 핸들러 — 미포착 예외가 Express 기본 핸들러(HTML + 스택 노출)로 새지 않게.
  // 반드시 마지막에 마운트해야 모든 라우터의 예외를 받는다.
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error('[unhandled]', err);
      if (res.headersSent) return;
      res.status(500).json({ error: '서버 오류가 났어요 — 잠시 후 다시 시도해주세요' });
    },
  );

  return app;
}
