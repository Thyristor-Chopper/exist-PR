import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useOrgStore } from '../orgStore';
import Logo from '../components/Logo';
import Avatar from '../components/Avatar';
import { BuildingIcon, UsersIcon, ShareIcon, CheckMarkIcon, GearIcon } from '../components/Icons';
import { POSITIONS } from '../lib/positions';
import InsightsPanel from '../components/InsightsPanel';

interface Member {
  userId: number;
  username: string;
  avatar: string;
  role: 'owner' | 'admin' | 'member';
  roleId: number | null;
  roleName: string | null;
  position: string | null;
  department: string | null;
}
interface Pending {
  userId: number;
  username: string;
  avatar: string;
}
interface OrgRole {
  id: number;
  name: string;
  perms: string[];
}
interface OrgDetail {
  id: number;
  name: string;
  joinCode?: string;
  ownerId: number;
  myRole: 'owner' | 'admin' | 'member';
  isManager: boolean;
  myPerms: string[];
  myDept: string | null;
  roles: OrgRole[];
  suggestions: { id: string; text: string }[];
  members: Member[];
  pending: Pending[];
}

interface AuditRow {
  id: number;
  action: string;
  text: string;
  actor: string;
  at: string;
}

const ROLE_LABEL: Record<string, string> = { owner: '소유자', admin: '관리자', member: '멤버' };

/* IAM식 세분 액션 — 커스텀 역할(중간관리자)에 조합해 부여 */
const ACTION_LABEL: Record<string, string> = {
  'member:approve': '가입 승인',
  'member:reject': '가입 거절',
  'member:edit-position': '직급 수정',
  'member:edit-department': '부서 수정',
  'member:remove': '내보내기',
  'group:lock': '입장 잠금',
  'group:settings': '설정(편집 허용·음소거)',
  'group:edit-info': '정보 수정(제목·썸네일)',
  'group:edit-period': '기간·반복 수정',
  'group:schedule': '일정 관리',
  'group:kick': '통화 강퇴',
  'group:transfer': '호스트 위임',
  'group:delete': '그룹 삭제',
  'group:channels': '채널 관리',
  'group:files': '파일 관리',
  'group:recap': '회의 정리 실행',
};
const ACTION_GROUPS: { title: string; hint: string; actions: string[] }[] = [
  {
    title: '멤버',
    hint: '자기 부서의 일반 멤버에게만',
    actions: ['member:approve', 'member:reject', 'member:edit-position', 'member:edit-department', 'member:remove'],
  },
  {
    title: '그룹',
    hint: '자기 부서원이 호스트인 그룹에만',
    actions: [
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
    ],
  },
];

/** 부서별 그룹 — 부서 있는 그룹 먼저(가나다), 미지정 마지막. 그룹 내 직급 높은 순 */
function groupByDept(members: Member[]): { dept: string | null; people: Member[] }[] {
  const map = new Map<string | null, Member[]>();
  for (const m of members) {
    const key = m.department || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(m);
  }
  const rank = (p: string | null) => (p ? POSITIONS.indexOf(p as (typeof POSITIONS)[number]) : -1);
  return [...map.entries()]
    .map(([dept, people]) => ({
      dept,
      people: [...people].sort((a, b) => rank(b.position) - rank(a.position)),
    }))
    .sort((a, b) => {
      if (a.dept === null) return 1;
      if (b.dept === null) return -1;
      return a.dept.localeCompare(b.dept, 'ko');
    });
}

/** 조직도 = 조직 운영 통합 화면 (보기 + 가입 승인 + 직급/부서/역할/제거 관리) */
export default function OrgChartPage() {
  const { id } = useParams();
  const orgId = Number(id);
  const navigate = useNavigate();
  const reloadOrgs = useOrgStore((s) => s.load);
  const [detail, setDetail] = useState<OrgDetail | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  // 승인 전 입력할 직급·부서 (대기자 userId별)
  const [draft, setDraft] = useState<Record<number, { position: string; department: string }>>({});

  const load = useCallback(async () => {
    try {
      setDetail(await api<OrgDetail>(`/api/orgs/${orgId}`));
    } catch {
      navigate('/');
    }
  }, [orgId, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    await load();
    await reloadOrgs();
  }

  function setDraft_(userId: number, patch: Partial<{ position: string; department: string }>) {
    setDraft((prev) => {
      const cur = prev[userId] ?? { position: '', department: '' };
      return { ...prev, [userId]: { ...cur, ...patch } };
    });
  }

  async function approve(userId: number) {
    const d = draft[userId];
    await api(`/api/orgs/${orgId}/members/${userId}/approve`, {
      method: 'POST',
      body: { position: d?.position || null, department: d?.department || null },
    });
    await refresh();
  }
  async function remove(userId: number) {
    await api(`/api/orgs/${orgId}/members/${userId}`, { method: 'DELETE' });
    await refresh();
  }
  // (구 setRole은 assignRole로 대체)
  /** 역할 지정 — 'member' | 'admin' | 'r<커스텀역할id>' */
  async function assignRole(userId: number, value: string) {
    const body =
      value === 'admin'
        ? { role: 'admin' }
        : value === 'member'
          ? { role: 'member', roleId: null }
          : { roleId: Number(value.slice(1)) };
    await api(`/api/orgs/${orgId}/members/${userId}`, { method: 'PATCH', body });
    await load();
  }

  // ── 활동 기록(감사 로그) — 관리자 전용, 접이식(열 때 로드) ──
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditRows, setAuditRows] = useState<AuditRow[] | null>(null);
  async function toggleAudit() {
    const next = !auditOpen;
    setAuditOpen(next);
    if (next) {
      try {
        setAuditRows(await api<AuditRow[]>(`/api/orgs/${orgId}/audit`));
      } catch {
        setAuditRows([]);
      }
    }
  }

  // ── 역할(정책) 관리 — 소유자 전용, 모달 ──
  const [rolesOpen, setRolesOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState('');
  const [newRolePerms, setNewRolePerms] = useState<string[]>([]);

  async function createRole(e: React.FormEvent) {
    e.preventDefault();
    if (!newRoleName.trim() || newRolePerms.length === 0) return;
    await api(`/api/orgs/${orgId}/roles`, {
      method: 'POST',
      body: { name: newRoleName.trim(), perms: newRolePerms },
    });
    setNewRoleName('');
    setNewRolePerms([]);
    await load();
  }
  async function toggleRolePerm(role: OrgRole, action: string) {
    const perms = role.perms.includes(action)
      ? role.perms.filter((p) => p !== action)
      : [...role.perms, action];
    if (perms.length === 0) {
      window.dispatchEvent(
        new CustomEvent('app:error', { detail: '권한이 하나는 남아야 해요 — 필요 없으면 역할을 삭제하세요' }),
      );
      return;
    }
    await api(`/api/orgs/${orgId}/roles/${role.id}`, { method: 'PATCH', body: { perms } });
    await load();
  }
  async function deleteRole(roleId: number) {
    await api(`/api/orgs/${orgId}/roles/${roleId}`, { method: 'DELETE' });
    await load();
  }
  async function setPosition(userId: number, position: string) {
    await api(`/api/orgs/${orgId}/members/${userId}`, {
      method: 'PATCH',
      body: { position: position || null },
    });
    await load();
  }
  async function setDepartment(userId: number, department: string) {
    await api(`/api/orgs/${orgId}/members/${userId}`, {
      method: 'PATCH',
      body: { department: department || null },
    });
    await load();
  }

  async function copyCode() {
    if (!detail?.joinCode) return;
    try {
      await navigator.clipboard.writeText(detail.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 수동 */
    }
  }

  /** 초대 링크 복사 — 받는 사람은 링크만 누르면 (로그인 후) 자동으로 가입 신청까지 진행 */
  async function copyInviteLink() {
    if (!detail?.joinCode) return;
    try {
      await navigator.clipboard.writeText(
        `${location.origin}/join/org/${detail.joinCode.replace(/[^A-Z0-9]/gi, '')}`,
      );
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      /* 수동 */
    }
  }

  const groups = detail ? groupByDept(detail.members) : [];
  const manager = !!detail?.isManager;
  const owner = detail?.myRole === 'owner';
  const perms = detail?.myPerms ?? [];
  const canApprove = manager || perms.includes('member:approve');
  const canReject = manager || perms.includes('member:reject');
  /** 대상 멤버를 편집할 수 있나 — 중간관리자는 자기 부서의 일반 멤버만, 액션별로 따로 */
  const inMyScope = (m: Member) =>
    m.role === 'member' && !m.roleId && !!detail?.myDept && m.department === detail.myDept;
  const canEditPos = (m: Member) =>
    manager ? m.role !== 'owner' || owner : perms.includes('member:edit-position') && inMyScope(m);
  const canEditDept = (m: Member) =>
    manager ? m.role !== 'owner' || owner : perms.includes('member:edit-department') && inMyScope(m);
  const canEditTarget = (m: Member) => canEditPos(m) || canEditDept(m);
  const canRemoveTarget = (m: Member) =>
    m.role !== 'owner' && (manager || (perms.includes('member:remove') && inMyScope(m)));

  return (
    <div className="orgchart-page">
      <header className="orgchart-top">
        <button className="orgchart-back" onClick={() => navigate('/')} title="대시보드로">
          ‹ 대시보드
        </button>
        <Logo />
        <span />
      </header>

      {!detail ? (
        <div className="orgchart-loading">조직도를 불러오는 중…</div>
      ) : (
        <main className="orgchart-main">
          <div className="orgchart-header">
            <div className="orgchart-title">
              <span className="orgchart-icon">
                <BuildingIcon size={26} />
              </span>
              <div>
                <h1>{detail.name}</h1>
                <div className="orgchart-sub">
                  <UsersIcon size={14} /> 멤버 {detail.members.length}명 · 부서{' '}
                  {groups.filter((g) => g.dept).length}개
                </div>
              </div>
            </div>
            {manager && detail.joinCode && (
              <span className="orgchart-invite">
                <button className="orgchart-code" onClick={copyCode} title="가입코드 복사">
                  가입코드 <b>{detail.joinCode}</b> {copied ? '✓' : ''}
                </button>
                <button
                  className="orgchart-code"
                  onClick={() => void copyInviteLink()}
                  title="초대 링크 복사 — 받은 사람은 링크만 누르면 자동으로 가입 신청돼요"
                >
                  {linkCopied ? <CheckMarkIcon size={13} /> : <ShareIcon size={13} />}
                  {linkCopied ? '복사됨' : '초대 링크'}
                </button>
                {owner && (
                  <button
                    className="orgchart-code"
                    onClick={() => setRolesOpen(true)}
                    title="역할 관리 — 권한 조합을 만들어 중간관리자를 지정해요"
                  >
                    <GearIcon size={13} /> 역할 관리
                  </button>
                )}
              </span>
            )}
          </div>

          {/* AI 위임 제안 — 소유자에게만, 규칙 기반(사실에서 계산). 실행은 사람이 */}
          {owner && (detail.suggestions ?? []).length > 0 && (
            <section className="org-suggest">
              {detail.suggestions.map((s) => (
                <div key={s.id} className="org-suggest-row">
                  <span className="org-suggest-badge">✨ AI 제안</span>
                  <span className="org-suggest-text">{s.text}</span>
                  <button className="org-btn approve" onClick={() => setRolesOpen(true)}>
                    역할 관리 열기
                  </button>
                </div>
              ))}
            </section>
          )}

          {/* 팀 인사이트는 운영자용 — 멤버에겐 관전 정보라 숨긴다 (홈에선 '내 포커스'를 봄) */}
          {manager && <InsightsPanel orgId={orgId} />}

          {/* 가입 대기 — 관리자 + 승인/거절 권한 중간관리자. 승인은 자기 부서로만 */}
          {(canApprove || canReject) && detail.pending.length > 0 && (
            <section className="orgchart-pending">
              <div className="orgchart-pending-head">
                ✉️ 가입 대기 <b>{detail.pending.length}</b>
              </div>
              {detail.pending.map((p) => (
                <div key={p.userId} className="orgchart-pending-row">
                  <span className="orgchart-pending-id">
                    <Avatar value={p.avatar} className="orgchart-avatar sm" />
                    {p.username}
                  </span>
                  <select
                    className="org-field-select"
                    value={draft[p.userId]?.position ?? ''}
                    onChange={(e) => setDraft_(p.userId, { position: e.target.value })}
                    title="직급 (선택)"
                  >
                    <option value="">직급 미지정</option>
                    {POSITIONS.map((pos) => (
                      <option key={pos} value={pos}>
                        {pos}
                      </option>
                    ))}
                  </select>
                  {manager ? (
                    <input
                      className="org-field-input"
                      value={draft[p.userId]?.department ?? ''}
                      placeholder="부서 (선택)"
                      maxLength={30}
                      onChange={(e) => setDraft_(p.userId, { department: e.target.value })}
                    />
                  ) : (
                    <span className="org-fixed-dept" title="중간관리자는 자기 부서로만 받을 수 있어요">
                      {detail.myDept ?? '부서 미지정'}
                    </span>
                  )}
                  <span className="orgchart-pending-actions">
                    {canApprove && (
                      <button className="org-btn approve" onClick={() => approve(p.userId)}>
                        승인
                      </button>
                    )}
                    {canReject && (
                      <button className="org-btn reject" onClick={() => remove(p.userId)}>
                        거절
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </section>
          )}

          {/* 역할(정책) 관리 모달 — 소유자 전용. IAM식: 액션 조합 = 역할, 스코프 = 자기 부서 */}
          {owner && rolesOpen && (
            <div className="modal-overlay" onClick={() => setRolesOpen(false)}>
              <div className="modal-card org-roles-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">역할 관리</div>
                <div className="org-roles-hint">
                  만든 역할을 멤버에게 주면 중간관리자가 돼요 — 권한은 그 사람의 <b>자기 부서</b>{' '}
                  일반 멤버에게만 적용돼요
                </div>
                {detail.roles.length === 0 && (
                  <div className="org-roles-empty">아직 만든 역할이 없어요 — 아래에서 시작해보세요</div>
                )}
                {detail.roles.map((r) => (
                  <div key={r.id} className="org-roles-block">
                    <div className="org-roles-block-head">
                      <b className="org-roles-name">{r.name}</b>
                      <button className="org-btn reject" onClick={() => void deleteRole(r.id)}>
                        삭제
                      </button>
                    </div>
                    {ACTION_GROUPS.map((g) => (
                      <div key={g.title} className="org-roles-cat">
                        <span className="org-roles-cat-name" title={g.hint}>
                          {g.title}
                        </span>
                        <span className="org-roles-cat-perms">
                          {g.actions.map((a) => (
                            <label key={a} className="org-roles-perm">
                              <input
                                type="checkbox"
                                checked={r.perms.includes(a)}
                                onChange={() => void toggleRolePerm(r, a)}
                              />
                              {ACTION_LABEL[a]}
                            </label>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
                <form className="org-roles-block new" onSubmit={createRole}>
                  <div className="org-roles-block-head">
                    <input
                      className="org-field-input"
                      value={newRoleName}
                      onChange={(e) => setNewRoleName(e.target.value)}
                      placeholder="새 역할 이름 (예: 팀장)"
                      maxLength={20}
                    />
                    <button
                      type="submit"
                      className="org-btn approve"
                      disabled={!newRoleName.trim() || newRolePerms.length === 0}
                    >
                      만들기
                    </button>
                  </div>
                  {ACTION_GROUPS.map((g) => (
                    <div key={g.title} className="org-roles-cat">
                      <span className="org-roles-cat-name" title={g.hint}>
                        {g.title}
                      </span>
                      <span className="org-roles-cat-perms">
                        {g.actions.map((a) => (
                          <label key={a} className="org-roles-perm">
                            <input
                              type="checkbox"
                              checked={newRolePerms.includes(a)}
                              onChange={() =>
                                setNewRolePerms((prev) =>
                                  prev.includes(a) ? prev.filter((p) => p !== a) : [...prev, a],
                                )
                              }
                            />
                            {ACTION_LABEL[a]}
                          </label>
                        ))}
                      </span>
                    </div>
                  ))}
                </form>
                <div className="modal-actions">
                  <button type="button" className="modal-cancel" onClick={() => setRolesOpen(false)}>
                    닫기
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="orgchart-grid">
            {groups.map((g) => (
              <section key={g.dept ?? '__none'} className="orgchart-dept">
                <div className="orgchart-dept-head">
                  {g.dept ?? '부서 미지정'}
                  <span className="orgchart-dept-count">{g.people.length}</span>
                </div>
                <div className="orgchart-members">
                  {g.people.map((m) => (
                    <div key={m.userId} className={`orgchart-card${manager ? ' editable' : ''}`}>
                      <div className="orgchart-card-main">
                        <Avatar value={m.avatar} className="orgchart-avatar" />
                        <div className="orgchart-info">
                          <div className="orgchart-name">
                            {m.username}
                            {m.role !== 'member' && (
                              <span className={`org-role ${m.role}`}>{ROLE_LABEL[m.role]}</span>
                            )}
                            {m.roleName && <span className="org-role custom">{m.roleName}</span>}
                          </div>
                          <div className="orgchart-pos">
                            {m.position ?? '직급 미지정'}
                            {m.department && ` · ${m.department}`}
                          </div>
                        </div>
                      </div>

                      {/* 인라인 편집 — 소유자 카드는 본인만, 중간관리자는 자기 부서 일반 멤버만 */}
                      {(canEditTarget(m) || canRemoveTarget(m)) && (
                        <div className="orgchart-card-edit">
                          {canEditPos(m) && (
                            <select
                              className="org-field-select"
                              value={m.position ?? ''}
                              onChange={(e) => setPosition(m.userId, e.target.value)}
                              title="직급"
                            >
                              <option value="">직급 미지정</option>
                              {POSITIONS.map((pos) => (
                                <option key={pos} value={pos}>
                                  {pos}
                                </option>
                              ))}
                              {m.position &&
                                !POSITIONS.includes(m.position as (typeof POSITIONS)[number]) && (
                                  <option value={m.position}>{m.position}</option>
                                )}
                            </select>
                          )}
                          {canEditDept(m) && (
                            <input
                              key={`dep-${m.userId}-${m.department ?? ''}`}
                              className="org-field-input"
                              defaultValue={m.department ?? ''}
                              placeholder="부서"
                              maxLength={30}
                              title="부서"
                              onBlur={(e) => {
                                if ((e.target.value || '') !== (m.department ?? '')) {
                                  void setDepartment(m.userId, e.target.value);
                                }
                              }}
                            />
                          )}
                          {/* 역할 지정 — 소유자 전용: 멤버/관리자/커스텀 역할(중간관리자) */}
                          {owner && m.role !== 'owner' && (
                            <select
                              className="org-field-select"
                              value={m.role === 'admin' ? 'admin' : m.roleId ? `r${m.roleId}` : 'member'}
                              onChange={(e) => void assignRole(m.userId, e.target.value)}
                              title="역할"
                            >
                              <option value="member">멤버</option>
                              <option value="admin">관리자</option>
                              {detail.roles.map((r) => (
                                <option key={r.id} value={`r${r.id}`}>
                                  {r.name}
                                </option>
                              ))}
                            </select>
                          )}
                          {canRemoveTarget(m) && (
                            <button className="org-btn reject" onClick={() => remove(m.userId)}>
                              제거
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {/* 활동 기록(감사 로그) — 관리자만. 인사·권한 변경의 책임 추적 */}
          {manager && (
            <section className="org-perm">
              <button className="org-perm-head" onClick={() => void toggleAudit()}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ verticalAlign: '-2px', marginRight: 6 }}>
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7.5V12l3 2" />
                </svg>
                활동 기록
                <span className="org-perm-caret">{auditOpen ? '▴' : '▾'}</span>
              </button>
              {auditOpen && (
                <div className="org-perm-body">
                  {auditRows === null ? (
                    <div className="org-audit-empty">불러오는 중…</div>
                  ) : auditRows.length === 0 ? (
                    <div className="org-audit-empty">아직 기록이 없어요</div>
                  ) : (
                    <div className="org-audit-list">
                      {auditRows.map((r) => (
                        <div key={r.id} className="org-audit-row">
                          <span className="org-audit-time">{r.at.slice(5, 16)}</span>
                          <b className="org-audit-actor">{r.actor}</b>
                          <span className="org-audit-text">{r.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* 권한 매트릭스 — 역할별로 할 수 있는 일 가시화 */}
          <section className="org-perm">
            <button className="org-perm-head" onClick={() => setPermOpen((v) => !v)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ verticalAlign: '-2px', marginRight: 6 }}>
                <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
                <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
              </svg>
              역할별 권한 안내
              <span className="org-perm-caret">{permOpen ? '▴' : '▾'}</span>
            </button>
            {permOpen && (
              <div className="org-perm-body">
                <div className="org-perm-scroll">
                  <table className="org-perm-table">
                    <thead>
                      <tr>
                        <th>기능</th>
                        <th>소유자</th>
                        <th>관리자</th>
                        <th>멤버</th>
                        {detail.roles.map((r) => (
                          <th key={r.id} className="org-perm-role" title="커스텀 역할 — 자기 부서 스코프">
                            {r.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {PERM_MATRIX.map((row) =>
                        'section' in row ? (
                          <tr key={row.section} className="org-perm-section">
                            <td colSpan={4 + detail.roles.length}>{row.section}</td>
                          </tr>
                        ) : (
                          <tr key={row.label}>
                            <td>{row.label}</td>
                            {row.allow.map((v, i) => (
                              <td key={i} className={v ? 'yes' : 'no'}>
                                {v ? '✓' : '—'}
                              </td>
                            ))}
                            {detail.roles.map((r) => {
                              const c = roleCell(row, r);
                              return (
                                <td key={r.id} className={c === '—' ? 'no' : 'yes'}>
                                  {c}
                                </td>
                              );
                            })}
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="org-perm-note">
                  호스트는 역할과 무관하게 자기 그룹을, 작성자는 자기가 만든 일정·채널·파일을 관리할 수
                  있어요. 조직에 속하지 않은 개인 그룹은 호스트만 관리해요.
                  {detail.roles.length > 0 &&
                    ' 커스텀 역할(◐=일부 권한)은 자기 부서의 멤버·자기 부서원이 호스트인 그룹에만 적용돼요.'}
                </p>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

/** 권한 매트릭스 데이터 — [소유자, 관리자, 멤버] + 커스텀 역할은 actions로 자동 계산.
 *  actions: 이 행에 해당하는 세분 액션 키들. 'base'는 멤버 기본권(커스텀 역할도 항상 ✓) */
type MatrixRow =
  | { section: string }
  | { label: string; allow: [boolean, boolean, boolean]; actions?: string[] | 'base' };
const PERM_MATRIX: MatrixRow[] = [
  { section: '조직 관리' },
  { label: '가입 신청 승인·거절', allow: [true, true, false], actions: ['member:approve', 'member:reject'] },
  { label: '직급·부서 지정', allow: [true, true, false], actions: ['member:edit-position', 'member:edit-department'] },
  { label: '멤버 제거', allow: [true, true, false], actions: ['member:remove'] },
  { label: '역할 변경 (관리자 ↔ 멤버)', allow: [true, false, false] },
  { label: '가입코드 보기·공유', allow: [true, true, false] },
  { section: '조직 소속 그룹' },
  { label: '입장 잠금·해제', allow: [true, true, false], actions: ['group:lock'] },
  { label: '그룹 설정 (편집 허용·음소거)', allow: [true, true, false], actions: ['group:settings'] },
  { label: '참가자 내보내기·호스트 위임', allow: [true, true, false], actions: ['group:kick', 'group:transfer'] },
  { label: '그룹 정보·기간 수정', allow: [true, true, false], actions: ['group:edit-info', 'group:edit-period'] },
  { label: '그룹 삭제', allow: [true, true, false], actions: ['group:delete'] },
  { label: '회의 정리(recap) 실행', allow: [true, true, false], actions: ['group:recap'] },
  { label: '일정·채널·공동편집 파일 관리', allow: [true, true, false], actions: ['group:schedule', 'group:channels', 'group:files'] },
  { label: '그룹 참여·채팅·통화·문서 편집', allow: [true, true, true], actions: 'base' },
];

/** 커스텀 역할의 행 표시 — ✓ 전부 / ◐ 일부 / — 없음 */
function roleCell(row: { actions?: string[] | 'base' }, role: OrgRole): '✓' | '◐' | '—' {
  if (row.actions === 'base') return '✓';
  if (!row.actions) return '—';
  const n = row.actions.filter((a) => role.perms.includes(a)).length;
  return n === row.actions.length ? '✓' : n > 0 ? '◐' : '—';
}
