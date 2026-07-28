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

/*
 * ── 커스텀 역할(IAM식) ──
 * 소유자 = 루트 계정, admin = 전체 관리 정책.
 * 커스텀 역할 = 소유자가 만든 정책(액션 조합)으로, 부여받은 멤버(중간관리자)는
 * "자기 부서" 리소스 안의 일반 멤버에게만 액션을 행사할 수 있다.
 */
export const ORG_ACTIONS = [
  // 멤버(인사) — 스코프: 자기 부서 일반 멤버 (승인·거절은 대기자 대상, 승인 시 자기 부서로 배정)
  'member:approve',
  'member:reject',
  'member:edit-position',
  'member:edit-department',
  'member:remove',
  // 그룹 — 스코프: 자기 부서원이 호스트인 조직 그룹 (create만 예외 — 본인이 새로 만드는 권한)
  'group:create',
  'group:lock',
  'group:settings',
  'group:edit-info',
  'group:edit-period',
  'group:schedule',
  'group:kick',
  'group:transfer',
  'group:delete',
  'group:channels',
  'group:files',
  'group:recap',
] as const;
export type OrgAction = (typeof ORG_ACTIONS)[number];

/** 액션 한국어 라벨 — 알림·감사 로그 문구용 */
const ACTION_LABEL_KO: Record<string, string> = {
  'member:approve': '가입 승인',
  'member:reject': '가입 거절',
  'member:edit-position': '직급 수정',
  'member:edit-department': '부서 수정',
  'member:remove': '멤버 내보내기',
  'group:create': '그룹 생성',
  'group:lock': '그룹 입장 잠금',
  'group:settings': '그룹 설정',
  'group:edit-info': '그룹 정보 수정',
  'group:edit-period': '그룹 기간 수정',
  'group:schedule': '그룹 일정 관리',
  'group:kick': '통화 강퇴',
  'group:transfer': '호스트 위임',
  'group:delete': '그룹 삭제',
  'group:channels': '채널 관리',
  'group:files': '파일 관리',
  'group:recap': '회의 정리 실행',
};

function orgNameOf(orgId: number): string {
  const o = db.prepare('SELECT name FROM organizations WHERE id = ?').get(orgId) as
    | { name: string }
    | undefined;
  return o?.name ?? '조직';
}

/** 감사 로그(CloudTrail식) — 인사·권한 변경을 남긴다. text는 사람이 읽는 한국어 스냅샷 */
export function audit(
  orgId: number,
  actorId: number,
  action: string,
  targetId: number | null,
  text: string,
) {
  db.prepare(
    'INSERT INTO org_audit (org_id, actor_id, action, target_id, text) VALUES (?, ?, ?, ?, ?)',
  ).run(orgId, actorId, action, targetId, text);
}

function usernameOf(userId: number): string {
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as
    | { username: string }
    | undefined;
  return u?.username ?? `#${userId}`;
}

interface FullMembership {
  role: 'owner' | 'admin' | 'member';
  status: string;
  department: string | null;
  role_id: number | null;
}

function getFullMembership(orgId: number, userId: number): FullMembership | undefined {
  return db
    .prepare(
      'SELECT role, status, department, role_id FROM organization_members WHERE org_id = ? AND user_id = ?',
    )
    .get(orgId, userId) as FullMembership | undefined;
}

/** 커스텀 역할의 액션 목록 */
function rolePerms(roleId: number | null): OrgAction[] {
  if (!roleId) return [];
  const r = db.prepare('SELECT perms FROM org_roles WHERE id = ?').get(roleId) as
    | { perms: string }
    | undefined;
  if (!r) return [];
  try {
    const arr = JSON.parse(r.perms) as unknown[];
    return arr.filter((p): p is OrgAction => ORG_ACTIONS.includes(p as OrgAction));
  } catch {
    return [];
  }
}

/** 내 커스텀 권한 (active 멤버 기준) */
function myPerms(orgId: number, userId: number): { perms: OrgAction[]; dept: string | null } {
  const m = getFullMembership(orgId, userId);
  if (!m || m.status !== 'active' || m.role !== 'member') return { perms: [], dept: null };
  return { perms: rolePerms(m.role_id), dept: m.department };
}

/** 조직에 그룹을 만들 수 있는가 — owner/admin 또는 group:create 권한 보유자 (meetings 라우터가 사용) */
export function canCreateOrgGroup(orgId: number, userId: number): boolean {
  if (isManager(orgId, userId)) return true;
  return myPerms(orgId, userId).perms.includes('group:create');
}

/** 대상 멤버에게 액션을 행사할 수 있는가 — owner/admin은 전체, 중간관리자는 자기 부서의 일반 멤버만 */
function canActOnMember(
  orgId: number,
  actorId: number,
  target: FullMembership,
  action: OrgAction,
): boolean {
  if (isManager(orgId, actorId)) return true;
  const { perms, dept } = myPerms(orgId, actorId);
  if (!perms.includes(action)) return false;
  // 스코프: 자기 부서(부서 없으면 불가) + 일반 멤버(역할 보유자·관리자·소유자는 소유자만 건드림)
  if (!dept || target.department !== dept) return false;
  return target.role === 'member' && !target.role_id;
}

/** 내가 속한(active) 조직 목록 — 멤버 수, 내 역할, (관리자면) 대기 신청 수 포함 */
router.get('/', (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT o.id, o.name, o.join_code, o.owner_id, om.role, om.role_id,
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
    role_id: number | null;
    member_count: number;
    pending_count: number;
  }[];

  res.json(
    rows.map((o) => {
      const managing = o.role === 'owner' || o.role === 'admin';
      return {
        id: o.id,
        name: o.name,
        joinCode: o.join_code,
        role: o.role,
        isManager: managing,
        // 클라가 "새 그룹 만들기" 버튼을 숨길 근거 — 서버 POST /meetings에서도 같은 규칙으로 거른다
        canCreateGroup: managing || rolePerms(o.role_id).includes('group:create'),
        memberCount: o.member_count,
        // 관리자에게만 대기 신청 수 노출
        pendingCount: managing ? o.pending_count : 0,
      };
    }),
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

/** 소유자(루트)인가 */
function isOwner(orgId: number, userId: number): boolean {
  const m = getMembership(orgId, userId);
  return !!m && m.status === 'active' && m.role === 'owner';
}

/* ── 역할(정책) 관리 — 소유자 전용 ── */

/** 역할 생성 — {name, perms: OrgAction[]} */
router.post('/:id/roles', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  if (!isOwner(orgId, req.userId!)) {
    return res.status(403).json({ error: '역할은 소유자만 만들 수 있어요' });
  }
  const name = String(req.body?.name ?? '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: '역할 이름을 입력하세요' });
  const perms = Array.isArray(req.body?.perms)
    ? (req.body.perms as unknown[]).filter((p): p is OrgAction => ORG_ACTIONS.includes(p as OrgAction))
    : [];
  if (perms.length === 0) return res.status(400).json({ error: '권한을 하나 이상 선택하세요' });
  const info = db
    .prepare('INSERT INTO org_roles (org_id, name, perms) VALUES (?, ?, ?)')
    .run(orgId, name, JSON.stringify(perms));
  audit(orgId, req.userId!, 'role.create', null, `역할 "${name}" 생성 (${perms.join(', ')})`);
  res.json({ id: info.lastInsertRowid, name, perms });
});

/** 역할 수정 — 이름·권한 부분 변경 */
router.patch('/:id/roles/:roleId', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  const roleId = Number(req.params.roleId);
  if (!isOwner(orgId, req.userId!)) {
    return res.status(403).json({ error: '역할은 소유자만 수정할 수 있어요' });
  }
  const role = db
    .prepare('SELECT id, name FROM org_roles WHERE id = ? AND org_id = ?')
    .get(roleId, orgId) as { id: number; name: string } | undefined;
  if (!role) return res.status(404).json({ error: '역할을 찾을 수 없어요' });
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 20);
    if (!name) return res.status(400).json({ error: '역할 이름을 입력하세요' });
    db.prepare('UPDATE org_roles SET name = ? WHERE id = ?').run(name, roleId);
    audit(orgId, req.userId!, 'role.update', null, `역할 "${role.name}" 이름 → "${name}"`);
  }
  if (req.body?.perms !== undefined) {
    const perms = Array.isArray(req.body.perms)
      ? (req.body.perms as unknown[]).filter((p): p is OrgAction => ORG_ACTIONS.includes(p as OrgAction))
      : [];
    if (perms.length === 0) return res.status(400).json({ error: '권한을 하나 이상 선택하세요' });
    db.prepare('UPDATE org_roles SET perms = ? WHERE id = ?').run(JSON.stringify(perms), roleId);
    audit(orgId, req.userId!, 'role.update', null, `역할 "${role.name}" 권한 → ${perms.join(', ')}`);
  }
  res.json({ ok: true });
});

/** 역할 삭제 — 부여받은 멤버는 일반 멤버로 돌아감 */
router.delete('/:id/roles/:roleId', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  const roleId = Number(req.params.roleId);
  if (!isOwner(orgId, req.userId!)) {
    return res.status(403).json({ error: '역할은 소유자만 삭제할 수 있어요' });
  }
  const role = db.prepare('SELECT name FROM org_roles WHERE id = ? AND org_id = ?').get(roleId, orgId) as
    | { name: string }
    | undefined;
  db.prepare('UPDATE organization_members SET role_id = NULL WHERE org_id = ? AND role_id = ?').run(
    orgId,
    roleId,
  );
  db.prepare('DELETE FROM org_roles WHERE id = ? AND org_id = ?').run(roleId, orgId);
  if (role) audit(orgId, req.userId!, 'role.delete', null, `역할 "${role.name}" 삭제`);
  res.json({ ok: true });
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
  const mine = myPerms(orgId, req.userId!);

  const members = db
    .prepare(
      `SELECT u.id AS user_id, u.username, u.avatar, om.role, om.status,
              om.position, om.department, om.created_at, om.role_id, r.name AS role_name
       FROM organization_members om
       JOIN users u ON u.id = om.user_id
       LEFT JOIN org_roles r ON r.id = om.role_id
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
    role_id: number | null;
    role_name: string | null;
  }[];

  // 부서 → 직급 높은 순 → 가입 순으로 정렬 (한국 조직도식)
  members.sort((a, b) => {
    const dep = (a.department ?? 'zzz').localeCompare(b.department ?? 'zzz', 'ko');
    if (dep !== 0) return dep;
    const pos = byPositionDesc(a, b);
    if (pos !== 0) return pos;
    return a.created_at.localeCompare(b.created_at);
  });

  // 대기 신청은 관리자 + 승인/거절 권한을 가진 중간관리자에게
  const canApprove =
    manager || mine.perms.includes('member:approve') || mine.perms.includes('member:reject');
  const pending = canApprove
    ? (db
        .prepare(
          `SELECT u.id AS user_id, u.username, u.avatar, om.created_at
           FROM organization_members om JOIN users u ON u.id = om.user_id
           WHERE om.org_id = ? AND om.status = 'pending' ORDER BY om.created_at`,
        )
        .all(orgId) as { user_id: number; username: string; avatar: string; created_at: string }[])
    : [];

  // 역할(정책) 목록 — 조직도에서 뱃지·소유자 관리 UI에 필요
  const roles = (
    db.prepare('SELECT id, name, perms FROM org_roles WHERE org_id = ? ORDER BY id').all(orgId) as {
      id: number;
      name: string;
      perms: string;
    }[]
  ).map((r) => ({ id: r.id, name: r.name, perms: JSON.parse(r.perms) as string[] }));

  // AI 위임 제안(Access Analyzer식, 규칙 기반) — 소유자에게만.
  // 사실에서 계산만 하고 실행은 사람이 (자동 실행 금지 원칙)
  const suggestions: { id: string; text: string }[] = [];
  if (getMembership(orgId, req.userId!)?.role === 'owner') {
    const roleIdsWithApprove = new Set(
      roles.filter((r) => r.perms.includes('member:approve')).map((r) => r.id),
    );
    const hasApproveDelegate = members.some((m) => m.role_id && roleIdsWithApprove.has(m.role_id));
    if (pending.length >= 2 && !hasApproveDelegate) {
      suggestions.push({
        id: 'delegate-approve',
        text: `가입 대기가 ${pending.length}건 쌓여 있어요 — "가입 승인" 권한을 부서 리더에게 위임하면 처리가 빨라져요`,
      });
    }
    // 부서에 사람은 많은데(3+) 관리 손이 없는 곳 — 중간관리자 위임 제안 (최대 2곳)
    const byDept = new Map<string, { total: number; managed: boolean }>();
    for (const m of members) {
      if (!m.department) continue;
      const d = byDept.get(m.department) ?? { total: 0, managed: false };
      d.total++;
      if (m.role === 'admin' || m.role === 'owner' || m.role_id) d.managed = true;
      byDept.set(m.department, d);
    }
    for (const [dept, info] of byDept) {
      if (suggestions.length >= 3) break;
      if (info.total >= 3 && !info.managed) {
        suggestions.push({
          id: `delegate-dept-${dept}`,
          text: `${dept}(${info.total}명)에 중간관리자가 없어요 — 역할을 만들어 위임해보세요`,
        });
      }
    }
  }

  res.json({
    id: org.id,
    name: org.name,
    joinCode: manager ? org.join_code : undefined,
    ownerId: org.owner_id,
    myRole: getMembership(orgId, req.userId!)!.role,
    isManager: manager,
    myPerms: mine.perms,
    myDept: mine.dept,
    roles,
    suggestions,
    members: members.map((m) => ({
      userId: m.user_id,
      username: m.username,
      avatar: m.avatar,
      role: m.role,
      roleId: m.role_id,
      roleName: m.role_name,
      position: m.position,
      department: m.department,
    })),
    pending: pending.map((p) => ({ userId: p.user_id, username: p.username, avatar: p.avatar })),
  });
});

/** 감사 로그 — 관리자(owner/admin)만. 인사·권한 변경의 책임 추적 */
router.get('/:id/audit', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  if (!isManager(orgId, req.userId!)) {
    return res.status(403).json({ error: '활동 기록은 관리자만 볼 수 있어요' });
  }
  const rows = db
    .prepare(
      `SELECT a.id, a.action, a.text, a.created_at, u.username AS actor
       FROM org_audit a JOIN users u ON u.id = a.actor_id
       WHERE a.org_id = ? ORDER BY a.id DESC LIMIT 60`,
    )
    .all(orgId) as { id: number; action: string; text: string; created_at: string; actor: string }[];
  res.json(rows.map((r) => ({ id: r.id, action: r.action, text: r.text, actor: r.actor, at: r.created_at })));
});

/** 조직 전체 그룹 목록 — 관리자(owner/admin) 전용 조회.
 *  내가 참가 안 한 그룹도 전부 보인다 (운영 감독용 — 참가·개입은 별개 문제) */
router.get('/:id/groups', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  if (!isManager(orgId, req.userId!)) {
    return res.status(403).json({ error: '전체 그룹은 관리자만 볼 수 있어요' });
  }
  const rows = db
    .prepare(
      `SELECT m.id, m.code, m.title, m.thumbnail, m.created_at,
              u.username AS host, om.department AS host_dept,
              (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id) AS participant_count,
              EXISTS(SELECT 1 FROM meeting_participants me WHERE me.meeting_id = m.id AND me.user_id = ?) AS joined
       FROM meetings m
       JOIN users u ON u.id = m.host_id
       LEFT JOIN organization_members om ON om.org_id = m.org_id AND om.user_id = m.host_id
       WHERE m.org_id = ?
       ORDER BY m.created_at DESC`,
    )
    .all(req.userId, orgId) as {
    id: number;
    code: string;
    title: string;
    thumbnail: string | null;
    created_at: string;
    host: string;
    host_dept: string | null;
    participant_count: number;
    joined: number;
  }[];
  res.json(
    rows.map((r) => ({
      id: r.id,
      code: r.code,
      title: r.title,
      thumbnail: r.thumbnail,
      host: r.host,
      hostDept: r.host_dept,
      participantCount: r.participant_count,
      joined: !!r.joined,
      createdAt: r.created_at,
    })),
  );
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
  const mgr = isManager(orgId, req.userId!);
  const mine = myPerms(orgId, req.userId!);
  if (!mgr && !mine.perms.includes('member:approve')) {
    return res.status(403).json({ error: '승인 권한이 없어요' });
  }
  const m = getMembership(orgId, targetId);
  if (!m || m.status !== 'pending') {
    return res.status(404).json({ error: '대기 중인 신청이 아니에요' });
  }
  const position =
    req.body?.position != null ? String(req.body.position).trim().slice(0, 20) || null : null;
  // 중간관리자의 승인은 자기 부서로만 받을 수 있다 (IAM 리소스 스코프)
  const department = !mgr
    ? mine.dept
    : req.body?.department != null
      ? String(req.body.department).trim().slice(0, 30) || null
      : null;
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
  audit(
    orgId,
    req.userId!,
    'member.approve',
    targetId,
    `${usernameOf(targetId)}님 가입 승인${detail ? ` (${detail})` : ''}`,
  );
  res.json({ ok: true });
});

/** 가입 거절 / 멤버 제거 (관리자) — owner는 제거 불가 */
router.delete('/:id/members/:userId', (req: AuthedRequest, res) => {
  const orgId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const m = getFullMembership(orgId, targetId);
  if (!m) return res.status(404).json({ error: '대상을 찾을 수 없어요' });
  if (m.role === 'owner') return res.status(400).json({ error: '소유자는 제거할 수 없어요' });
  if (m.status === 'pending') {
    // 가입 거절 — 대기자는 부서가 없어 스코프 대신 member:reject 보유 여부로
    if (!isManager(orgId, req.userId!) && !myPerms(orgId, req.userId!).perms.includes('member:reject')) {
      return res.status(403).json({ error: '가입 거절 권한이 없어요' });
    }
  } else if (!canActOnMember(orgId, req.userId!, m, 'member:remove')) {
    return res.status(403).json({ error: '권한이 없어요' });
  }
  db.prepare('DELETE FROM organization_members WHERE org_id = ? AND user_id = ?').run(
    orgId,
    targetId,
  );
  audit(
    orgId,
    req.userId!,
    m.status === 'pending' ? 'member.reject' : 'member.remove',
    targetId,
    m.status === 'pending'
      ? `${usernameOf(targetId)}님 가입 거절`
      : `${usernameOf(targetId)}님 내보내기`,
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

  const m = getFullMembership(orgId, targetId);
  if (!m || m.status !== 'active') return res.status(404).json({ error: '활성 멤버가 아니에요' });

  // 커스텀 역할 부여/해제 — 소유자 전용, 일반 멤버에게만 (admin은 이미 전체 권한)
  if (body.roleId !== undefined) {
    if (!isOwner(orgId, req.userId!)) {
      return res.status(403).json({ error: '역할 부여는 소유자만 할 수 있어요' });
    }
    if (m.role === 'owner') return res.status(400).json({ error: '소유자에겐 역할을 줄 수 없어요' });
    const roleId = body.roleId === null ? null : Number(body.roleId);
    if (roleId !== null) {
      const role = db
        .prepare('SELECT id FROM org_roles WHERE id = ? AND org_id = ?')
        .get(roleId, orgId);
      if (!role) return res.status(404).json({ error: '역할을 찾을 수 없어요' });
    }
    db.prepare(
      "UPDATE organization_members SET role_id = ?, role = 'member' WHERE org_id = ? AND user_id = ?",
    ).run(roleId, orgId, targetId);
    m.role_id = roleId;
    m.role = 'member';
    const roleName =
      roleId == null
        ? null
        : (db.prepare('SELECT name FROM org_roles WHERE id = ?').get(roleId) as { name: string }).name;
    audit(
      orgId,
      req.userId!,
      'member.assign_role',
      targetId,
      roleName
        ? `${usernameOf(targetId)}님에게 역할 "${roleName}" 부여`
        : `${usernameOf(targetId)}님 역할 해제`,
    );
    // 당사자에게 알림 — 무슨 권한이 생겼는지까지
    if (roleName && roleId != null) {
      const permsKo = rolePerms(roleId).map((p) => ACTION_LABEL_KO[p] ?? p);
      const summary = permsKo.slice(0, 4).join(', ') + (permsKo.length > 4 ? ` 외 ${permsKo.length - 4}개` : '');
      notifyUser(targetId, {
        from: orgNameOf(orgId),
        text: `"${roleName}" 역할을 받았어요 — 부서 안에서 ${summary} 권한이 생겼어요`,
        kind: 'org-role',
      });
    } else {
      notifyUser(targetId, {
        from: orgNameOf(orgId),
        text: '역할이 해제됐어요 — 일반 멤버로 돌아갑니다',
        kind: 'org-role',
      });
    }
  }

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
    // admin으로 승격되면 커스텀 역할은 의미 없으니 해제
    db.prepare(
      `UPDATE organization_members SET role = ?,
         role_id = CASE WHEN ? = 'admin' THEN NULL ELSE role_id END
       WHERE org_id = ? AND user_id = ?`,
    ).run(role, role, orgId, targetId);
    audit(
      orgId,
      req.userId!,
      'member.set_role',
      targetId,
      `${usernameOf(targetId)}님을 ${role === 'admin' ? '관리자로 지정' : '일반 멤버로 변경'}`,
    );
    notifyUser(targetId, {
      from: orgNameOf(orgId),
      text:
        role === 'admin'
          ? '관리자로 지정됐어요 — 조직 전체를 관리할 수 있어요'
          : '일반 멤버로 변경됐어요',
      kind: 'org-role',
    });
  }

  // 직급·부서 변경 — 관리자(owner/admin) 또는 해당 액션 권한의 중간관리자(자기 부서 멤버만).
  // 소유자의 정보는 소유자 본인만
  if (body.position !== undefined || body.department !== undefined) {
    if (m.role === 'owner' && req.userId !== targetId) {
      return res.status(403).json({ error: '소유자 정보는 본인만 수정할 수 있어요' });
    }
    if (body.position !== undefined) {
      if (m.role !== 'owner' && !canActOnMember(orgId, req.userId!, m, 'member:edit-position')) {
        return res.status(403).json({ error: '직급을 수정할 권한이 없어요' });
      }
      const position = body.position === null ? null : String(body.position).trim().slice(0, 20) || null;
      db.prepare(
        'UPDATE organization_members SET position = ? WHERE org_id = ? AND user_id = ?',
      ).run(position, orgId, targetId);
      audit(
        orgId,
        req.userId!,
        'member.update',
        targetId,
        `${usernameOf(targetId)}님 직급 → ${position ?? '미지정'}`,
      );
    }
    if (body.department !== undefined) {
      if (m.role !== 'owner' && !canActOnMember(orgId, req.userId!, m, 'member:edit-department')) {
        return res.status(403).json({ error: '부서를 수정할 권한이 없어요' });
      }
      const department =
        body.department === null ? null : String(body.department).trim().slice(0, 30) || null;
      db.prepare(
        'UPDATE organization_members SET department = ? WHERE org_id = ? AND user_id = ?',
      ).run(department, orgId, targetId);
      audit(
        orgId,
        req.userId!,
        'member.update',
        targetId,
        `${usernameOf(targetId)}님 부서 → ${department ?? '미지정'}`,
      );
    }
  }

  res.json({ ok: true });
});

export { isMember };
export default router;
