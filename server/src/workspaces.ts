import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { isMember } from './orgs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..'), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const router = Router();

/** 에셋 서빙 — <img src>는 Authorization 헤더가 없으므로 인증 제외 (UUID 파일명으로 보호) */
router.get('/uploads/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const file = path.join(UPLOAD_DIR, safe);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

router.use(requireAuth);

/** ?ctx=personal|<orgId> — meetings.org_id와 같은 규약. 개인=내가 만든 것만, 조직=활성 멤버만 */
function parseCtx(
  req: AuthedRequest,
): { ok: false; status: 400 | 403; error: string } | { ok: true; orgId: number | null } {
  const raw = String((req.query.ctx ?? req.body?.ctx ?? 'personal') as string);
  if (raw === 'personal') return { ok: true, orgId: null };
  const orgId = Number(raw);
  if (!Number.isInteger(orgId)) return { ok: false, status: 400, error: '잘못된 컨텍스트예요' };
  if (!isMember(orgId, req.userId!))
    return { ok: false, status: 403, error: '조직 멤버만 쓸 수 있어요' };
  return { ok: true, orgId };
}

/** 이 사용자가 만질 수 있는 작업공간인가 — 개인은 만든 사람, 조직은 활성 멤버 */
function canTouch(ws: { created_by: number; org_id: number | null }, userId: number): boolean {
  return ws.org_id == null ? ws.created_by === userId : isMember(ws.org_id, userId);
}

router.get('/', (req: AuthedRequest, res) => {
  const ctx = parseCtx(req);
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const rows =
    ctx.orgId == null
      ? db
          .prepare(
            'SELECT id, name, created_by, created_at FROM workspaces WHERE org_id IS NULL AND created_by = ? ORDER BY id',
          )
          .all(req.userId)
      : db
          .prepare(
            'SELECT id, name, created_by, created_at FROM workspaces WHERE org_id = ? ORDER BY id',
          )
          .all(ctx.orgId);
  res.json(rows);
});

router.post('/', (req: AuthedRequest, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '작업공간 이름을 입력하세요' });
  }
  const ctx = parseCtx(req);
  if (!ctx.ok) return res.status(ctx.status).json({ error: ctx.error });
  const info = db
    .prepare('INSERT INTO workspaces (name, created_by, org_id) VALUES (?, ?, ?)')
    .run(name, req.userId, ctx.orgId);
  res.json({ id: info.lastInsertRowid, name });
});

/** tldraw 캔버스 에셋(이미지 등) 업로드 — 최대 20MB */
const MAX_UPLOAD = 20 * 1024 * 1024;

router.post('/uploads', (req: AuthedRequest, res) => {
  const id = crypto.randomUUID();
  const qname = typeof req.query.name === 'string' ? req.query.name : '';
  const ext = qname.split('.').pop()?.replace(/[^\w]/g, '') || 'bin';
  const filename = `${id}.${ext}`;
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_UPLOAD) {
      res.status(413).json({ error: '파일이 너무 큽니다 (최대 20MB)' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.headersSent) return;
    try {
      fs.writeFileSync(path.join(UPLOAD_DIR, filename), Buffer.concat(chunks));
      res.json({ url: `/api/workspaces/uploads/${filename}` });
    } catch (e) {
      // 이벤트 콜백 안의 예외는 Express가 못 잡는다(프로세스 크래시) — 직접 응답
      console.error('[uploads]', e);
      res.status(500).json({ error: '업로드 저장에 실패했어요' });
    }
  });
});

/** 작업공간 이름 변경 */
router.patch('/:id', (req: AuthedRequest, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '이름을 입력하세요' });
  }
  const ws = db
    .prepare('SELECT id, created_by, org_id FROM workspaces WHERE id = ?')
    .get(req.params.id) as { id: number; created_by: number; org_id: number | null } | undefined;
  if (!ws) return res.status(404).json({ error: '없는 작업공간입니다' });
  if (!canTouch(ws, req.userId!)) return res.status(403).json({ error: '권한이 없어요' });
  db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  res.json({ ok: true });
});

/** 작업공간 삭제 (캔버스 스냅샷은 보존 — 복구 여지) */
router.delete('/:id', (req: AuthedRequest, res) => {
  const ws = db
    .prepare('SELECT id, created_by, org_id FROM workspaces WHERE id = ?')
    .get(req.params.id) as { id: number; created_by: number; org_id: number | null } | undefined;
  if (!ws) return res.status(404).json({ error: '없는 작업공간입니다' });
  if (!canTouch(ws, req.userId!)) return res.status(403).json({ error: '권한이 없어요' });
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
