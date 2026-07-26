import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useOrgStore } from '../orgStore';
import Logo from '../components/Logo';
import Avatar from '../components/Avatar';
import { BuildingIcon, UsersIcon, ShareIcon, CheckMarkIcon } from '../components/Icons';
import { POSITIONS } from '../lib/positions';
import InsightsPanel from '../components/InsightsPanel';

interface Member {
  userId: number;
  username: string;
  avatar: string;
  role: 'owner' | 'admin' | 'member';
  position: string | null;
  department: string | null;
}
interface Pending {
  userId: number;
  username: string;
  avatar: string;
}
interface OrgDetail {
  id: number;
  name: string;
  joinCode?: string;
  ownerId: number;
  myRole: 'owner' | 'admin' | 'member';
  isManager: boolean;
  members: Member[];
  pending: Pending[];
}

const ROLE_LABEL: Record<string, string> = { owner: '소유자', admin: '관리자', member: '멤버' };

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
  async function setRole(userId: number, role: 'admin' | 'member') {
    await api(`/api/orgs/${orgId}/members/${userId}`, { method: 'PATCH', body: { role } });
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
              </span>
            )}
          </div>

          {/* 팀 인사이트는 운영자용 — 멤버에겐 관전 정보라 숨긴다 (홈에선 '내 포커스'를 봄) */}
          {manager && <InsightsPanel orgId={orgId} />}

          {/* 가입 대기 — 관리자만, 직급·부서 미리 정하며 승인 */}
          {manager && detail.pending.length > 0 && (
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
                  <input
                    className="org-field-input"
                    value={draft[p.userId]?.department ?? ''}
                    placeholder="부서 (선택)"
                    maxLength={30}
                    onChange={(e) => setDraft_(p.userId, { department: e.target.value })}
                  />
                  <span className="orgchart-pending-actions">
                    <button className="org-btn approve" onClick={() => approve(p.userId)}>
                      승인
                    </button>
                    <button className="org-btn reject" onClick={() => remove(p.userId)}>
                      거절
                    </button>
                  </span>
                </div>
              ))}
            </section>
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
                          </div>
                          <div className="orgchart-pos">
                            {m.position ?? '직급 미지정'}
                            {m.department && ` · ${m.department}`}
                          </div>
                        </div>
                      </div>

                      {/* 관리자 인라인 편집 (소유자 대상 제외) */}
                      {manager && m.role !== 'owner' && (
                        <div className="orgchart-card-edit">
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
                          {owner &&
                            (m.role === 'member' ? (
                              <button className="org-btn" onClick={() => setRole(m.userId, 'admin')}>
                                관리자로
                              </button>
                            ) : (
                              <button className="org-btn" onClick={() => setRole(m.userId, 'member')}>
                                멤버로
                              </button>
                            ))}
                          <button className="org-btn reject" onClick={() => remove(m.userId)}>
                            제거
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

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
                      </tr>
                    </thead>
                    <tbody>
                      {PERM_MATRIX.map((row) =>
                        'section' in row ? (
                          <tr key={row.section} className="org-perm-section">
                            <td colSpan={4}>{row.section}</td>
                          </tr>
                        ) : (
                          <tr key={row.label}>
                            <td>{row.label}</td>
                            {row.allow.map((v, i) => (
                              <td key={i} className={v ? 'yes' : 'no'}>
                                {v ? '✓' : '—'}
                              </td>
                            ))}
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="org-perm-note">
                  호스트는 역할과 무관하게 자기 그룹을, 작성자는 자기가 만든 일정·채널·파일을 관리할 수
                  있어요. 조직에 속하지 않은 개인 그룹은 호스트만 관리해요.
                </p>
              </div>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

/** 권한 매트릭스 데이터 — [소유자, 관리자, 멤버] */
const PERM_MATRIX: ({ section: string } | { label: string; allow: [boolean, boolean, boolean] })[] = [
  { section: '조직 관리' },
  { label: '가입 신청 승인·거절', allow: [true, true, false] },
  { label: '직급·부서 지정', allow: [true, true, false] },
  { label: '멤버 제거', allow: [true, true, false] },
  { label: '역할 변경 (관리자 ↔ 멤버)', allow: [true, false, false] },
  { label: '가입코드 보기·공유', allow: [true, true, false] },
  { section: '조직 소속 그룹' },
  { label: '그룹 설정 (잠금·편집 허용·음소거)', allow: [true, true, false] },
  { label: '참가자 내보내기·호스트 위임', allow: [true, true, false] },
  { label: '그룹 정보 수정·삭제', allow: [true, true, false] },
  { label: '회의 정리(recap) 실행', allow: [true, true, false] },
  { label: '일정·채널·공동편집 파일 관리', allow: [true, true, false] },
  { label: '그룹 참여·채팅·통화·문서 편집', allow: [true, true, true] },
];
