import { Router } from 'express';
import crypto from 'node:crypto';
import db from './db.js';
import { requireAuth, type AuthedRequest } from './auth.js';
import { byPositionDesc } from './positions.js';
import { notifyUser } from './notify.js';

/** 조직의 관리자(owner/admin) userId 목록 — 알림 대상 */
function managerIds(orgId: number): number[] {
  return (
    db
      .prepare(
        `SELECT user_id FROM organization_members
         WHERE org_id = ? AND status = 'active' AND role IN ('owner','admin')`,
      )
      .all(orgId) as { user_id: number }[]
  ).map((r) => r.user_id);
}

/*
 * 조직(organization) — 회사·팀 단위.
 * 누구나 조직을 만들 수 있고(생성자=owner), 가입은 가입코드로 신청 → 관리자 승인제.
 * 회의는 조직에 소속될 수도(조직 회의), 소속되지 않을 수도(개인 회의) 있다.
 */

const router = Router();
router.use(requireAuth);

/** 가입코드 — "XXXX-XXXX" (혼동 문자 제외) */
function generateJoinCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () =>
    Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `${group()}-${group()}`;
}

interface Membership {
  role: 'owner' | 'admin' | 'member';
  status: 'pending' | 'active';
}

function getMembership(orgId: number, userId: number): Membership | undefined {
  return db
    .prepare('SELECT role, status FROM organization_members WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId) as Membership | undefined;
}

/** active 멤버인가 */
function isMember(orgId: number, userId: number): boolean {
  const m = getMembership(orgId, userId);
  return !!m && m.status === 'active';
}

/** 승인·관리 권한(owner/admin)인가 */
function isManager(orgId: number, userId: number): boolean {
  const m = getMembership(orgId, userId);
  return !!m && m.status === 'active' && (m.role === 'owner' || m.role === 'admin');
}

/** 내가 속한(active) 조직 목록 — 멤버 수, 내 역할, (관리자면) 대기 신청 수 포함 */
router.get('/', (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT o.id, o.name, o.join_code, o.owner_id, om.role,
              (SELECT COUNT(*) FROM organization_members m2
               WHERE m2.org_id = o.id AND m2.status = 'active') AS member_count,
              (SELECT COUNT(*) FROM organization_members m3
               WHERE m3.org_id = o.id AND m3.status = 'pending') AS pending_count
       FROM organizations o
       JOIN organization_members om ON om.org_id = o.id
       WHERE om.user_id = ? AND om.status = 'active'
       ORDER BY o.created_at`,
    )
    .all(req.userId) as {
    id: number;
    name: string;
    join_code: string;
    owner_id: number;
    role: string;
    member_count: number;
    pending_count: number;
  }[];

  res.json(
    rows.map((o) => ({
      id: o.id,
      name: o.name,
      joinCode: o.join_code,
      role: o.role,
      isManager: o.role === 'owner' || o.role === 'admin',
      memberCount: o.member_count,
      // 관리자에게만 대기 신청 수 노출
      pendingCount: o.role === 'owner' || o.role === 'admin' ? o.pending_count : 0,
    })),
  );
});

/** 내가 가입 신청해둔(pending) 조직 — "승인 대기 중" 표시용 */
router.get('/pending', (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT o.id, o.name FROM organizations o
       JOIN organization_members om ON om.org_id = o.id
       WHERE om.user_id = ? AND om.status = 'pending' ORDER BY o.created_at`,
    )
    .all(req.userId) as { id: number; name: string }[];
  res.json(rows);
});

/** 조직 생성 — 생성자는 owner(active) */
router.post('/', (req: AuthedRequest, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: '조직 이름을 입력하세요' });
  if (name.length > 40) return res.status(400).json({ error: '조직 이름은 40자 이내로 입력하세요' });

  let joinCode = generateJoinCode();
  while (db.prepare('SELECT id FROM organizations WHERE join_code = ?').get(joinCode)) {
    joinCode = generateJoinCode();
  }

  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO organizations (name, join_code, owner_id) VALUES (?, ?, ?)')
      .run(name, joinCode, req.userId);
    db.prepare(
      `INSERT INTO organization_members (org_id, user_id, role, status)
       VALUES (?, ?, 'owner', 'active')`,
    ).run(info.lastInsertRowid, req.userId);
    return info.lastInsertRowid as number;
  });
  const id = tx();
  res.json({ id, name, joinCode, role: 'owner', isManager: true, memberCount: 1, pendingCount: 0 });
});

/** 가입 신청 — 가입코드로 pending 등록 */
router.post('/join', (req: AuthedRequest, res) => {
  const raw = String(req.body?.joinCode ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (raw.length !== 8) return res.status(400).json({ error: '가입코드를 확인하세요' });
  const joinCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;

  const org = db
    .prepare('SELECT id, name FROM organizations WHERE join_code = ?')
    .get(joinCode) as { id: number; name: string } | undefined;
  if (!org) return res.status(404).json({ error: '존재하지 않는 가입코드입니다' });

  const existing = getMembership(org.id, req.userId!);
  if (existing?.status === 'active') {
    return res.status(409).json({ error: '이미 이 조직의 멤버예요' });
  }
  if (existing?.status === 'pending') {
    return res.status(409).json({ error: '이미 가입 신청을 보냈어요 — 승인을 기다려주세요' });
  }

  db.prepare(
    `INSERT INTO organization_members (org_id, user_id, role, status)
     VALUES (?, ?, 'member', 'pending')`,
  ).run(org.id, req.userId);

  // 관리자에게 가입 신청 도착 알림
  for (const mid of managerIds(org.id)) {
    notifyUser(mid, {
      from: org.name,
      text: `${req.username}님이 ${org.name} 가입을 신청했어요`,
      kind: 'org-request',
    });
  }
  res.json({ ok: true, orgName: org.name, status: 'pending' });
});

/** 조직 상세 — 멤버 목록(+대기 목록은 관리자만), 내 역할 */
router.get('/:id', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  if (!isMember(orgId, req.userId!)) {
    return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
  }
  const org = db
    .prepare('SELECT id, name, join_code, owner_id FROM organizations WHERE id = ?')
    .get(orgId) as { id: number; name: string; join_code: string; owner_id: number } | undefined;
  if (!org) return res.status(404).json({ error: '존재하지 않는 조직입니다' });

  const manager = isManager(orgId, req.userId!);

  const members = db
    .prepare(
      `SELECT u.id AS user_id, u.username, u.avatar, om.role, om.status,
              om.position, om.department, om.created_at
       FROM organization_members om JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ? AND om.status = 'active'`,
    )
    .all(orgId) as {
    user_id: number;
    username: string;
    avatar: string;
    role: string;
    status: string;
    position: string | null;
    department: string | null;
    created_at: string;
  }[];

  // 부서 → 직급 높은 순 → 가입 순으로 정렬 (한국 조직도식)
  members.sort((a, b) => {
    const dep = (a.department ?? 'zzz').localeCompare(b.department ?? 'zzz', 'ko');
    if (dep !== 0) return dep;
    const pos = byPositionDesc(a, b);
    if (pos !== 0) return pos;
    return a.created_at.localeCompare(b.created_at);
  });

  // 대기 신청은 관리자에게만
  const pending = manager
    ? (db
        .prepare(
          `SELECT u.id AS user_id, u.username, u.avatar, om.created_at
           FROM organization_members om JOIN users u ON u.id = om.user_id
           WHERE om.org_id = ? AND om.status = 'pending' ORDER BY om.created_at`,
        )
        .all(orgId) as { user_id: number; username: string; avatar: string; created_at: string }[])
    : [];

  res.json({
    id: org.id,
    name: org.name,
    joinCode: manager ? org.join_code : undefined,
    ownerId: org.owner_id,
    myRole: getMembership(orgId, req.userId!)!.role,
    isManager: manager,
    members: members.map((m) => ({
      userId: m.user_id,
      username: m.username,
      avatar: m.avatar,
      role: m.role,
      position: m.position,
      department: m.department,
    })),
    pending: pending.map((p) => ({ userId: p.user_id, username: p.username, avatar: p.avatar })),
  });
});

/** 내 포커스 — 일반 멤버의 조직 홈용: 이 조직에서 내가 지금 챙길 것들
 *  (미완료 할 일 · 다가오는 일정 · 안읽은 채팅). 팀 인사이트는 관리자용, 멤버는 이걸 본다. */
router.get('/:id/my-focus', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  if (!isMember(orgId, req.userId!)) {
    return res.status(403).json({ error: '이 조직의 멤버가 아니에요' });
  }
  // 내가 참가 중인 이 조직의 그룹들
  const myMeetings = db
    .prepare(
      `SELECT m.id, m.code, m.title FROM meetings m
       JOIN meeting_participants mp ON mp.meeting_id = m.id AND mp.user_id = ?
       WHERE m.org_id = ?`,
    )
    .all(req.userId, orgId) as { id: number; code: string; title: string }[];
  if (myMeetings.length === 0) return res.json({ todos: [], events: [], unread: [] });
  const ids = myMeetings.map((m) => m.id);
  const ph = ids.map(() => '?').join(',');
  const byId = new Map(myMeetings.map((m) => [m.id, m]));

  // 미완료 할 일 (그룹 할 일은 공유)
  const todos = (
    db
      .prepare(
        `SELECT t.id, t.title, t.due_at, t.meeting_id FROM todos t
         WHERE t.meeting_id IN (${ph}) AND t.done = 0 ORDER BY t.due_at IS NULL, t.due_at, t.created_at LIMIT 8`,
      )
      .all(...ids) as { id: number; title: string; due_at: string | null; meeting_id: number }[]
  ).map((t) => ({
    id: t.id,
    title: t.title,
    dueAt: t.due_at,
    meetingCode: byId.get(t.meeting_id)?.code,
    meetingTitle: byId.get(t.meeting_id)?.title,
  }));

  // 다가오는 일정 (오늘 포함, 날짜순)
  const events = (
    db
      .prepare(
        `SELECT e.id, e.title, e.date, e.time, e.meeting_id FROM meeting_events e
         WHERE e.meeting_id IN (${ph}) AND e.date >= date('now', 'localtime')
         ORDER BY e.date, e.time IS NULL, e.time LIMIT 6`,
      )
      .all(...ids) as { id: number; title: string; date: string; time: string | null; meeting_id: number }[]
  ).map((e) => ({
    id: e.id,
    title: e.title,
    date: e.date,
    time: e.time,
    meetingCode: byId.get(e.meeting_id)?.code,
    meetingTitle: byId.get(e.meeting_id)?.title,
  }));

  // 그룹별 안읽은 채팅 수
  const unread = (
    db
      .prepare(
        `SELECT m.id AS meeting_id, COUNT(msg.id) AS cnt FROM meetings m
         JOIN messages msg ON msg.meeting_id = m.id AND msg.user_id != ?
           AND msg.id > COALESCE((SELECT last_read FROM chat_reads WHERE user_id = ? AND meeting_id = m.id), 0)
         WHERE m.id IN (${ph}) GROUP BY m.id`,
      )
      .all(req.userId, req.userId, ...ids) as { meeting_id: number; cnt: number }[]
  )
    .filter((u) => u.cnt > 0)
    .map((u) => ({
      meetingCode: byId.get(u.meeting_id)?.code,
      meetingTitle: byId.get(u.meeting_id)?.title,
      count: u.cnt,
    }));

  res.json({ todos, events, unread });
});

/** 가입 승인 (관리자) — 직급·부서를 함께 지정할 수 있음 */
router.post('/:id/members/:userId/approve', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  if (!isManager(orgId, req.userId!)) {
    return res.status(403).json({ error: '승인 권한이 없어요' });
  }
  const m = getMembership(orgId, targetId);
  if (!m || m.status !== 'pending') {
    return res.status(404).json({ error: '대기 중인 신청이 아니에요' });
  }
  const position =
    req.body?.position != null ? String(req.body.position).trim().slice(0, 20) || null : null;
  const department =
    req.body?.department != null ? String(req.body.department).trim().slice(0, 30) || null : null;
  db.prepare(
    `UPDATE organization_members
       SET status = 'active', position = ?, department = ?
     WHERE org_id = ? AND user_id = ?`,
  ).run(position, department, orgId, targetId);

  // 신청자에게 승인 알림 (직급·부서가 있으면 함께)
  const org = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId) as
    | { name: string }
    | undefined;
  const detail = [department, position].filter(Boolean).join(' ');
  notifyUser(targetId, {
    from: org?.name ?? '조직',
    text: `${org?.name ?? '조직'} 가입이 승인됐어요${detail ? ` — ${detail}` : ''}`,
    kind: 'org-approved',
  });
  res.json({ ok: true });
});

/** 가입 거절 / 멤버 제거 (관리자) — owner는 제거 불가 */
router.delete('/:id/members/:userId', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  if (!isManager(orgId, req.userId!)) {
    return res.status(403).json({ error: '권한이 없어요' });
  }
  const m = getMembership(orgId, targetId);
  if (!m) return res.status(404).json({ error: '대상을 찾을 수 없어요' });
  if (m.role === 'owner') return res.status(400).json({ error: '소유자는 제거할 수 없어요' });
  db.prepare('DELETE FROM organization_members WHERE org_id = ? AND user_id = ?').run(
    orgId,
    targetId,
  );
  res.json({ ok: true });
});

/* 멤버 정보 변경
 *  - role(admin↔member): 소유자만
 *  - position(직급)·department(부서): 관리자(owner/admin)
 *  body에 온 필드만 부분 변경 */
router.patch('/:id/members/:userId', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const body = req.body ?? {};

  const m = getMembership(orgId, targetId);
  if (!m || m.status !== 'active') return res.status(404).json({ error: '활성 멤버가 아니에요' });

  // 역할 변경 — 소유자 전용
  if (body.role !== undefined) {
    const role = String(body.role);
    if (!['admin', 'member'].includes(role)) {
      return res.status(400).json({ error: '역할은 admin 또는 member여야 해요' });
    }
    const me = getMembership(orgId, req.userId!);
    if (!me || me.status !== 'active' || me.role !== 'owner') {
      return res.status(403).json({ error: '소유자만 역할을 바꿀 수 있어요' });
    }
    if (m.role === 'owner') return res.status(400).json({ error: '소유자 역할은 바꿀 수 없어요' });
    db.prepare('UPDATE organization_members SET role = ? WHERE org_id = ? AND user_id = ?').run(
      role,
      orgId,
      targetId,
    );
  }

  // 직급·부서 변경 — 관리자(owner/admin)
  if (body.position !== undefined || body.department !== undefined) {
    if (!isManager(orgId, req.userId!)) {
      return res.status(403).json({ error: '직급·부서는 관리자만 설정할 수 있어요' });
    }
    if (body.position !== undefined) {
      const position = body.position === null ? null : String(body.position).trim().slice(0, 20) || null;
      db.prepare(
        'UPDATE organization_members SET position = ? WHERE org_id = ? AND user_id = ?',
      ).run(position, orgId, targetId);
    }
    if (body.department !== undefined) {
      const department =
        body.department === null ? null : String(body.department).trim().slice(0, 30) || null;
      db.prepare(
        'UPDATE organization_members SET department = ? WHERE org_id = ? AND user_id = ?',
      ).run(department, orgId, targetId);
    }
  }

  res.json({ ok: true });
});

export { isMember };
export default router;
