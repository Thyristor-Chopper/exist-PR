import db from './db.js';

/*
 * IAM 권한 헬퍼 — 조직 역할(owner/admin)을 그룹(회의)·공동편집 관리 권한에 연결.
 * 규칙: 그룹 관리 행위 = 호스트 또는 (그룹이 조직 소속이면) 그 조직의 active한 owner/admin.
 * 개인 그룹(org_id 없음)은 기존대로 호스트만.
 */

/** 조직의 active한 owner/admin인지 */
export function isOrgManager(orgId: number | null | undefined, userId: number): boolean {
  if (!orgId) return false;
  const m = db
    .prepare('SELECT role, status FROM organization_members WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId) as { role: string; status: string } | undefined;
  return !!m && m.status === 'active' && (m.role === 'owner' || m.role === 'admin');
}

/** 조직의 active한 멤버인지 (역할 무관) */
export function isOrgMember(orgId: number, userId: number): boolean {
  const m = db
    .prepare('SELECT status FROM organization_members WHERE org_id = ? AND user_id = ?')
    .get(orgId, userId) as { status: string } | undefined;
  return !!m && m.status === 'active';
}

/** 커스텀 역할(중간관리자)의 group:manage — 자기 부서원이 호스트인 조직 그룹을 관리 */
function isDeptGroupManager(
  meeting: { host_id: number; org_id?: number | null },
  userId: number,
): boolean {
  if (!meeting.org_id) return false;
  const me = db
    .prepare(
      'SELECT status, department, role_id FROM organization_members WHERE org_id = ? AND user_id = ?',
    )
    .get(meeting.org_id, userId) as
    | { status: string; department: string | null; role_id: number | null }
    | undefined;
  if (!me || me.status !== 'active' || !me.role_id || !me.department) return false;
  const role = db.prepare('SELECT perms FROM org_roles WHERE id = ?').get(me.role_id) as
    | { perms: string }
    | undefined;
  if (!role) return false;
  try {
    if (!(JSON.parse(role.perms) as string[]).includes('group:manage')) return false;
  } catch {
    return false;
  }
  const host = db
    .prepare(
      'SELECT status, department FROM organization_members WHERE org_id = ? AND user_id = ?',
    )
    .get(meeting.org_id, meeting.host_id) as
    | { status: string; department: string | null }
    | undefined;
  return !!host && host.status === 'active' && host.department === me.department;
}

/** 그룹(회의) 관리 권한 — 호스트 / 소속 조직 관리자 / 부서 스코프 중간관리자(group:manage) */
export function canManageMeeting(
  meeting: { host_id: number; org_id?: number | null },
  userId: number,
): boolean {
  return (
    meeting.host_id === userId ||
    isOrgManager(meeting.org_id, userId) ||
    isDeptGroupManager(meeting, userId)
  );
}
