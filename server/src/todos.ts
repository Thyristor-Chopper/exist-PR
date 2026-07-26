import { Router } from 'express';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { invalidateBrief } from './agent.js';

const router = Router();
router.use(requireAuth);

// 모든 변경 요청 후 AI 브리핑 캐시 무효화
router.use((req: AuthedRequest, _res, next) => {
  if (req.method !== 'GET') invalidateBrief(req.userId!);
  next();
});

/** 회의 코드 → meeting id (없으면 null) */
function meetingIdOf(code: unknown): number | null {
  if (!code) return null;
  const m = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(code).toUpperCase()) as { id: number } | undefined;
  return m?.id ?? null;
}

/** 목록 — ?meeting=CODE면 그 회의 공유 할 일, 없으면 내 할 일 전부
 *  (개인 + 회의에서 나에게 배정된 것 — recap 자동 배정이 홈 목록에 바로 뜨도록) */
router.get('/', (req: AuthedRequest, res) => {
  if (req.query.meeting) {
    const mid = meetingIdOf(req.query.meeting);
    if (!mid) return res.json([]);
    const rows = db
      .prepare(
        `SELECT t.id, t.title, t.done, t.due_at, u.username AS author
         FROM todos t JOIN users u ON u.id = t.user_id
         WHERE t.meeting_id = ? ORDER BY t.created_at`,
      )
      .all(mid);
    return res.json(rows);
  }
  // ?org= 스코프 — 개인 탭(personal)은 조직 소속 그룹 할 일 제외, 조직 탭은 그 조직 것만
  const org = req.query.org;
  const orgId = typeof org === 'string' && org !== 'personal' ? Number(org) : NaN;
  const scopeSql =
    org === 'personal' ? ' AND m.org_id IS NULL' : Number.isInteger(orgId) ? ' AND m.org_id = ?' : '';
  const scopeArgs: number[] = Number.isInteger(orgId) ? [orgId] : [];
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.done, t.due_at, m.code AS meeting_code, m.title AS meeting_title
       FROM todos t LEFT JOIN meetings m ON m.id = t.meeting_id
       WHERE t.user_id = ?${scopeSql} ORDER BY t.created_at`,
    )
    .all(req.userId, ...scopeArgs);
  res.json(rows);
});

router.post('/', (req: AuthedRequest, res) => {
  const { title, due_at, meeting } = req.body ?? {};
  if (!title) return res.status(400).json({ error: '내용을 입력하세요' });
  const mid = meetingIdOf(meeting);
  const info = db
    .prepare('INSERT INTO todos (user_id, title, due_at, meeting_id) VALUES (?, ?, ?, ?)')
    .run(req.userId, title, due_at ?? null, mid);
  res.json({ id: info.lastInsertRowid, title, done: 0, due_at: due_at ?? null });
});

router.patch('/:id', (req: AuthedRequest, res) => {
  const { done, title } = req.body ?? {};
  const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id) as
    | { user_id: number; meeting_id: number | null }
    | undefined;
  if (!todo) return res.status(404).json({ error: '없는 투두입니다' });
  // 개인 할 일은 본인만, 회의 할 일은 공유라 누구나
  if (todo.meeting_id == null && todo.user_id !== req.userId) {
    return res.status(403).json({ error: '권한이 없어요' });
  }
  if (done !== undefined) {
    db.prepare('UPDATE todos SET done = ? WHERE id = ?').run(done ? 1 : 0, req.params.id);
  }
  if (title !== undefined) {
    db.prepare('UPDATE todos SET title = ? WHERE id = ?').run(title, req.params.id);
  }
  res.json({ ok: true });
});

router.delete('/:id', (req: AuthedRequest, res) => {
  const todo = db.prepare('SELECT user_id, meeting_id FROM todos WHERE id = ?').get(req.params.id) as
    | { user_id: number; meeting_id: number | null }
    | undefined;
  if (!todo) return res.json({ ok: true });
  if (todo.meeting_id == null && todo.user_id !== req.userId) {
    return res.status(403).json({ error: '권한이 없어요' });
  }
  db.prepare('DELETE FROM todos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
