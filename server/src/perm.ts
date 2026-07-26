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

/** 그룹(회의) 관련 세분 액션 — AWS IAM식. 스코프는 "자기 부서원이 호스트인 조직 그룹" */
export type GroupAction =
  | 'group:lock'
  | 'group:settings'
  | 'group:edit-info'
  | 'group:edit-period'
  | 'group:schedule'
  | 'group:kick'
  | 'group:transfer'
  | 'group:delete'
  | 'group:channels'
  | 'group:files'
  | 'group:recap';

/** 커스텀 역할(중간관리자)의 그룹 권한 — action 없으면 group:* 아무거나 있는지(관리 UI 노출용) */
function isDeptGroupManager(
  meeting: { host_id: number; org_id?: number | null },
  userId: number,
  action?: GroupAction,
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
    const perms = JSON.parse(role.perms) as string[];
    // 'group:manage'는 구 와일드카드 — 마이그레이션 전 DB 호환
    const has = action
      ? perms.includes(action) || perms.includes('group:manage')
      : perms.some((p) => p.startsWith('group:'));
    if (!has) return false;
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

/** 그룹(회의) 관리 권한 — 호스트 / 소속 조직 관리자 / 부서 스코프 중간관리자.
 *  action을 주면 그 액션 권한을 정확히 검사, 없으면 "관리 권한이 하나라도 있나"(UI 노출용) */
export function canManageMeeting(
  meeting: { host_id: number; org_id?: number | null },
  userId: number,
  action?: GroupAction,
): boolean {
  return (
    meeting.host_id === userId ||
    isOrgManager(meeting.org_id, userId) ||
    isDeptGroupManager(meeting, userId, action)
  );
}
