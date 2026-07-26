import { Router } from 'express';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { invalidateBrief } from './agent.js';
import { notifyUser } from './notify.js';

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

/** 회의 할 일들의 담당자 — todo_id → username[] */
function assigneesOf(todoIds: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (todoIds.length === 0) return map;
  const ph = todoIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ta.todo_id, u.username FROM todo_assignees ta
       JOIN users u ON u.id = ta.user_id WHERE ta.todo_id IN (${ph}) ORDER BY u.username`,
    )
    .all(...todoIds) as { todo_id: number; username: string }[];
  for (const r of rows) {
    const list = map.get(r.todo_id) ?? [];
    list.push(r.username);
    map.set(r.todo_id, list);
  }
  return map;
}

/** 담당자 셋 교체 — 그 회의 참가자만 유효. 새로 추가된 사람에게만 알림. 반환 = 반영된 username[] */
function setAssignees(
  todoId: number,
  meetingId: number,
  actorId: number,
  usernames: unknown,
  todoTitle: string,
): string[] {
  const wanted = Array.isArray(usernames)
    ? [...new Set(usernames.map((u) => String(u ?? '').trim()).filter(Boolean))]
    : [];
  const participants = db
    .prepare(
      `SELECT u.id, u.username FROM meeting_participants mp
       JOIN users u ON u.id = mp.user_id WHERE mp.meeting_id = ?`,
    )
    .all(meetingId) as { id: number; username: string }[];
  const byName = new Map(participants.map((p) => [p.username, p.id]));
  const next = wanted.filter((n) => byName.has(n));

  const cur = db
    .prepare('SELECT user_id FROM todo_assignees WHERE todo_id = ?')
    .all(todoId) as { user_id: number }[];
  const curIds = new Set(cur.map((c) => c.user_id));
  const nextIds = new Set(next.map((n) => byName.get(n)!));

  for (const id of curIds) {
    if (!nextIds.has(id)) {
      db.prepare('DELETE FROM todo_assignees WHERE todo_id = ? AND user_id = ?').run(todoId, id);
      invalidateBrief(id);
    }
  }
  const meeting = db
    .prepare('SELECT code, title FROM meetings WHERE id = ?')
    .get(meetingId) as { code: string; title: string } | undefined;
  const actor = db.prepare('SELECT username FROM users WHERE id = ?').get(actorId) as
    | { username: string }
    | undefined;
  for (const id of nextIds) {
    if (curIds.has(id)) continue;
    db.prepare('INSERT OR IGNORE INTO todo_assignees (todo_id, user_id) VALUES (?, ?)').run(
      todoId,
      id,
    );
    invalidateBrief(id);
    if (id !== actorId) {
      notifyUser(id, {
        from: actor?.username ?? '누군가',
        text: `'${todoTitle}' 할 일 담당자로 지정했어요${meeting ? ` ('${meeting.title}')` : ''}`,
        kind: 'todo',
        meetingCode: meeting?.code,
      });
    }
  }
  return next.sort();
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
      .all(mid) as { id: number }[];
    const amap = assigneesOf(rows.map((r) => r.id));
    return res.json(rows.map((r) => ({ ...r, assignees: amap.get(r.id) ?? [] })));
  }
  // ?org= 스코프 — 개인 탭(personal)은 조직 소속 그룹 할 일 제외, 조직 탭은 그 조직 것만
  const org = req.query.org;
  const orgId = typeof org === 'string' && org !== 'personal' ? Number(org) : NaN;
  const scopeSql =
    org === 'personal' ? ' AND m.org_id IS NULL' : Number.isInteger(orgId) ? ' AND m.org_id = ?' : '';
  const scopeArgs: number[] = Number.isInteger(orgId) ? [orgId] : [];
  // 회의 할 일은 담당자 기준(여러 명 가능), 개인 할 일은 소유자 기준
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.done, t.due_at, m.code AS meeting_code, m.title AS meeting_title
       FROM todos t LEFT JOIN meetings m ON m.id = t.meeting_id
       WHERE ((t.meeting_id IS NULL AND t.user_id = ?)
          OR EXISTS (SELECT 1 FROM todo_assignees ta WHERE ta.todo_id = t.id AND ta.user_id = ?))${scopeSql}
       ORDER BY t.created_at`,
    )
    .all(req.userId, req.userId, ...scopeArgs);
  res.json(rows);
});

router.post('/', (req: AuthedRequest, res) => {
  const { title, due_at, meeting, assignees } = req.body ?? {};
  if (!title) return res.status(400).json({ error: '내용을 입력하세요' });
  const mid = meetingIdOf(meeting);
  const info = db
    .prepare('INSERT INTO todos (user_id, title, due_at, meeting_id) VALUES (?, ?, ?, ?)')
    .run(req.userId, title, due_at ?? null, mid);
  const id = info.lastInsertRowid as number;
  let names: string[] = [];
  if (mid) {
    // 지정 없으면 작성자 본인 담당 (기존 "내 목록에 뜸" 동작 유지)
    const me = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId) as
      | { username: string }
      | undefined;
    const want = Array.isArray(assignees) && assignees.length ? assignees : [me?.username];
    names = setAssignees(id, mid, req.userId!, want, String(title));
  }
  res.json({ id, title, done: 0, due_at: due_at ?? null, assignees: names });
});

router.patch('/:id', (req: AuthedRequest, res) => {
  const { done, title, assignees } = req.body ?? {};
  const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id) as
    | { id: number; user_id: number; meeting_id: number | null; title: string }
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
  let names: string[] | undefined;
  if (assignees !== undefined && todo.meeting_id != null) {
    names = setAssignees(
      todo.id,
      todo.meeting_id,
      req.userId!,
      assignees,
      title !== undefined ? String(title) : todo.title,
    );
  }
  res.json({ ok: true, ...(names !== undefined ? { assignees: names } : {}) });
});

router.delete('/:id', (req: AuthedRequest, res) => {
  const todo = db.prepare('SELECT user_id, meeting_id FROM todos WHERE id = ?').get(req.params.id) as
    | { user_id: number; meeting_id: number | null }
    | undefined;
  if (!todo) return res.json({ ok: true });
  if (todo.meeting_id == null && todo.user_id !== req.userId) {
    return res.status(403).json({ error: '권한이 없어요' });
  }
  db.prepare('DELETE FROM todo_assignees WHERE todo_id = ?').run(req.params.id);
  db.prepare('DELETE FROM todos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
