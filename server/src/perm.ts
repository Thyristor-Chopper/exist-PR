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

/** 그룹(회의) 관리 권한 — 호스트이거나 소속 조직의 관리자 */
export function canManageMeeting(
  meeting: { host_id: number; org_id?: number | null },
  userId: number,
): boolean {
  return meeting.host_id === userId || isOrgManager(meeting.org_id, userId);
}
