import { Router } from 'express';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { invalidateBrief } from './agent.js';
import { notifyUser } from './notify.js';
import { canManageMeeting } from './perm.js';

const router = Router();
router.use(requireAuth);

// 모든 변경 요청 후 AI 브리핑 캐시 무효화
router.use((req: AuthedRequest, _res, next) => {
  if (req.method !== 'GET') invalidateBrief(req.userId!);
  next();
});

/** 할 일 관련자인가 — 개인: 소유자 / 회의: 담당자·작성자·호스트·조직 관리자(부서 중간관리자 포함).
 *  완료 체크·수정·삭제 전부 이 게이트 — 관련 없는 참가자가 남의 할 일을 함부로 못 건드리게 */
function canTouchTodo(
  todo: { id: number; user_id: number; meeting_id: number | null },
  userId: number,
): boolean {
  if (todo.meeting_id == null) return todo.user_id === userId;
  if (todo.user_id === userId) return true;
  const assignee = db
    .prepare('SELECT 1 FROM todo_assignees WHERE todo_id = ? AND user_id = ?')
    .get(todo.id, userId);
  if (assignee) return true;
  const meeting = db
    .prepare('SELECT host_id, org_id FROM meetings WHERE id = ?')
    .get(todo.meeting_id) as { host_id: number; org_id: number | null } | undefined;
  return meeting ? canManageMeeting(meeting, userId) : false;
}

/** 회의 코드 → meeting id (없으면 null) */
function meetingIdOf(code: unknown): number | null {
  if (!code) return null;
  const m = db
    .prepare('SELECT id FROM meetings WHERE code = ?')
    .get(String(code).toUpperCase()) as { id: number } | undefined;
  return m?.id ?? null;
}

interface AssigneeProfile {
  username: string;
  name: string | null;
  avatar: string | null;
}

/** 회의 할 일들의 담당자 — todo_id → 프로필(이름·아바타 포함, nowbar 등 표시용) */
function assigneesOf(todoIds: number[]): Map<number, AssigneeProfile[]> {
  const map = new Map<number, AssigneeProfile[]>();
  if (todoIds.length === 0) return map;
  const ph = todoIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ta.todo_id, u.username, u.name, u.avatar FROM todo_assignees ta
       JOIN users u ON u.id = ta.user_id WHERE ta.todo_id IN (${ph}) ORDER BY u.username`,
    )
    .all(...todoIds) as ({ todo_id: number } & AssigneeProfile)[];
  for (const r of rows) {
    const list = map.get(r.todo_id) ?? [];
    list.push({ username: r.username, name: r.name, avatar: r.avatar });
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
  // 알림 발신자는 표시 이름 우선 (w1 표시 이름 규칙 — 없으면 아이디)
  const actor = db.prepare('SELECT username, name FROM users WHERE id = ?').get(actorId) as
    | { username: string; name: string | null }
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
        from: actor?.name || actor?.username || '누군가',
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
    return res.json(
      rows.map((r) => {
        const profs = amap.get(r.id) ?? [];
        // assignees(아이디 배열)는 기존 소비자(허브 피커) 호환용, 프로필은 표시용
        return { ...r, assignees: profs.map((p) => p.username), assigneeProfiles: profs };
      }),
    );
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
  const { done, title, assignees, due_at } = req.body ?? {};
  const todo = db.prepare('SELECT * FROM todos WHERE id = ?').get(req.params.id) as
    | { id: number; user_id: number; meeting_id: number | null; title: string; done: number }
    | undefined;
  if (!todo) return res.status(404).json({ error: '없는 투두입니다' });
  if (!canTouchTodo(todo, req.userId!)) {
    return res.status(403).json({ error: '담당자·작성자·관리자만 할 일을 바꿀 수 있어요' });
  }
  if (done !== undefined) {
    db.prepare('UPDATE todos SET done = ? WHERE id = ?').run(done ? 1 : 0, req.params.id);
    // 완료 = 보고 — 전달→실행→보고 루프의 완결. 지시자(작성자)·호스트에게 알림 (본인 제외)
    if (done && !todo.done && todo.meeting_id != null) {
      const meeting = db
        .prepare('SELECT code, title, host_id FROM meetings WHERE id = ?')
        .get(todo.meeting_id) as { code: string; title: string; host_id: number } | undefined;
      const completer = db.prepare('SELECT username FROM users WHERE id = ?').get(req.userId) as
        | { username: string }
        | undefined;
      const recipients = new Set<number>([todo.user_id, meeting?.host_id ?? -1]);
      recipients.delete(req.userId!);
      recipients.delete(-1);
      for (const uid of recipients) {
        notifyUser(uid, {
          from: completer?.username ?? '누군가',
          text: `'${todo.title}' 할 일을 완료했어요${meeting ? ` ('${meeting.title}')` : ''}`,
          kind: 'todo',
          meetingCode: meeting?.code,
        });
        invalidateBrief(uid);
      }
    }
  }
  if (title !== undefined) {
    db.prepare('UPDATE todos SET title = ? WHERE id = ?').run(title, req.params.id);
  }
  if (due_at !== undefined) {
    // 'YYYY-MM-DD' 또는 null(기한 없음). 마감이 바뀌면 리마인드 플래그 리셋 — 새 기한 기준으로 다시 알림
    const clean = due_at == null || due_at === '' ? null : String(due_at).slice(0, 10);
    if (clean != null && !/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      return res.status(400).json({ error: '마감일 형식이 잘못됐어요' });
    }
    db.prepare(
      'UPDATE todos SET due_at = ?, reminded_soon = 0, reminded_overdue = 0 WHERE id = ?',
    ).run(clean, req.params.id);
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
  const todo = db
    .prepare('SELECT id, user_id, meeting_id FROM todos WHERE id = ?')
    .get(req.params.id) as { id: number; user_id: number; meeting_id: number | null } | undefined;
  if (!todo) return res.json({ ok: true });
  if (!canTouchTodo(todo, req.userId!)) {
    return res.status(403).json({ error: '담당자·작성자·관리자만 지울 수 있어요' });
  }
  db.prepare('DELETE FROM todo_assignees WHERE todo_id = ?').run(req.params.id);
  db.prepare('DELETE FROM todos WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/** 로컬 날짜 YYYY-MM-DD */
function localDateStr(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 마감 리마인드 — AI 총무가 알아서 조르기 (분산·재택의 "옆에서 챙겨줄 사람 없음" 대체).
 *  임박(내일·오늘) 1회 + 지남 1회, 회의 할 일은 담당자 전원·개인 할 일은 소유자에게.
 *  index.ts가 부팅 직후 + 10분 간격으로 호출. 반환 = 보낸 알림 수 */
export function runTodoReminders(now = new Date()): number {
  const today = localDateStr(now);
  const tomorrow = localDateStr(new Date(now.getTime() + 86_400_000));
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.due_at, t.user_id, t.meeting_id, t.reminded_soon, t.reminded_overdue,
              m.code AS mcode, m.title AS mtitle
       FROM todos t LEFT JOIN meetings m ON m.id = t.meeting_id
       WHERE t.done = 0 AND t.due_at IS NOT NULL`,
    )
    .all() as {
    id: number;
    title: string;
    due_at: string;
    user_id: number;
    meeting_id: number | null;
    reminded_soon: number;
    reminded_overdue: number;
    mcode: string | null;
    mtitle: string | null;
  }[];
  let sent = 0;
  for (const t of rows) {
    const due = String(t.due_at).slice(0, 10);
    const phase = due < today ? 'overdue' : due === today || due === tomorrow ? 'soon' : null;
    if (!phase) continue;
    if (phase === 'soon' && t.reminded_soon) continue;
    if (phase === 'overdue' && t.reminded_overdue) continue;
    const targets =
      t.meeting_id != null
        ? (
            db.prepare('SELECT user_id FROM todo_assignees WHERE todo_id = ?').all(t.id) as {
              user_id: number;
            }[]
          ).map((r) => r.user_id)
        : [t.user_id];
    const suffix = t.mtitle ? ` ('${t.mtitle}')` : '';
    const [m, d] = due.slice(5).split('-').map(Number);
    const text =
      phase === 'overdue'
        ? `'${t.title}' 할 일 마감(${m}/${d})이 지났어요 — 확인 부탁해요${suffix}`
        : `'${t.title}' 할 일 마감이 ${due === today ? '오늘' : '내일'}이에요${suffix}`;
    for (const uid of new Set(targets)) {
      notifyUser(uid, { from: 'exist AI', text, kind: 'todo', meetingCode: t.mcode ?? undefined });
      invalidateBrief(uid);
      sent++;
    }
    db.prepare(
      `UPDATE todos SET ${phase === 'soon' ? 'reminded_soon' : 'reminded_overdue'} = 1 WHERE id = ?`,
    ).run(t.id);
  }
  return sent;
}

export default router;
