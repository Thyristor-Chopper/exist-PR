import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuthStore } from '../store';
import { useOrgStore } from '../orgStore';
import InsightsPanel from './InsightsPanel';
import MyOrgFocus from './MyOrgFocus';
import { type Todo, type Meeting } from './NowBar';
import UnifiedInbox from './UnifiedInbox';
import { dueBadge } from '../lib/due';
import ScheduleWidget from './ScheduleWidget';
import Marquee from './Marquee';
import { ListIcon, SparklesIcon, CalendarIcon, ChatIcon, UsersIcon, CheckMarkIcon, ChartIcon, CheckIcon } from './Icons';

/** 확인 대기 결정 — 홈 카드 (P1: 결정은 전달되고, 확인되어야 한다) */
interface PendingDecision {
  recapId: number;
  idx: number;
  decision: string;
  code: string;
  title: string;
  ts: number;
}

/*
 * 개인 프로필 대시보드 — '홈' 탭(회의 미선택)에서 작업공간을 꽉 채워 표시.
 * 요약 통계 + 빠른 시작(새 회의·팀 인사이트) + 최근 회의(클릭해서 열기).
 */

interface Overview {
  avatar: string;
  meetingCount: number;
  todoUndone: number;
  todoOverdue: number;
  /** 안 읽은 합계 (DM + 그룹 채팅) — 히어로 뱃지 */
  unreadTotal: number;
  /** 수신확인 대기 결정 수 — 히어로 뱃지 */
  pendingAcks: number;
  liveCalls: { title: string; code: string; inCall: number }[];
  recentMeetings: { title: string; code: string; inCall: number }[];
  nextMeeting: { title: string; code: string; startsAt: string | null } | null;
}

/** P2 — 자리 비운 사이 놓친 것 브리핑 */
interface CatchupItem {
  type: 'recap' | 'todo' | 'dm' | 'chat';
  text: string;
  meeting?: { code: string; title: string };
}

interface Catchup {
  headline: string;
  items: CatchupItem[];
}

const CATCHUP_BADGE: Record<CatchupItem['type'], string> = {
  recap: '통화 정리',
  todo: '할 일',
  dm: 'DM',
  chat: '채팅',
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '늦은 시간이네요';
  if (h < 12) return '좋은 아침이에요';
  if (h < 18) return '좋은 오후예요';
  return '오늘 하루도 수고했어요';
}

export default function ProfileDashboard() {
  const user = useAuthStore((s) => s.user);
  const org = useOrgStore((s) => s.current);
  const orgs = useOrgStore((s) => s.orgs);
  const navigate = useNavigate();
  const [ov, setOv] = useState<Overview | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [schedule, setSchedule] = useState<Meeting[]>([]);
  const [daily, setDaily] = useState('');
  const [catchup, setCatchup] = useState<Catchup | null>(null);
  const [pending, setPending] = useState<PendingDecision[] | null>(null);

  /** 홈에서 바로 수신확인 — 회람 사인. 낙관적 제거, 실패 시 원복 */
  async function confirmDecision(item: PendingDecision) {
    setPending((prev) => (prev ? prev.filter((p) => !(p.recapId === item.recapId && p.idx === item.idx)) : prev));
    setOv((prev) => (prev ? { ...prev, pendingAcks: Math.max(0, prev.pendingAcks - 1) } : prev));
    try {
      await api(`/api/meetings/${item.code}/decisions/ack`, {
        method: 'POST',
        body: { recapId: item.recapId, idx: item.idx },
      });
    } catch {
      setPending((prev) => (prev ? [item, ...prev] : prev));
      setOv((prev) => (prev ? { ...prev, pendingAcks: prev.pendingAcks + 1 } : prev));
    }
  }

  /** 홈에서 바로 완료 토글 — 낙관적 갱신, 실패 시 원복 */
  async function toggleTodo(t: Todo) {
    const next = t.done ? 0 : 1;
    setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: next } : x)));
    try {
      await api(`/api/todos/${t.id}`, { method: 'PATCH', body: { done: !!next } });
    } catch {
      setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: t.done } : x)));
    }
  }

  /** 홈에서 삭제 — 개인 할 일 정리 동선 (서버가 관련자 게이트) */
  async function removeTodo(t: Todo) {
    try {
      await api(`/api/todos/${t.id}`, { method: 'DELETE' });
      setTodos((prev) => prev.filter((x) => x.id !== t.id));
    } catch {
      /* 전역 토스트 */
    }
  }

  useEffect(() => {
    let alive = true;
    // AI 콘텐츠는 탭 컨텍스트를 따라간다 — 개인 탭은 개인 그룹만, 조직 탭은 그 조직만
    const orgQ = `org=${org === 'personal' ? 'personal' : org}`;
    // 탭 전환 시 이전 스코프 내용이 잠깐 보이지 않게 비운다
    setOv(null);
    setDaily('');
    setCatchup(null);
    api<Overview>(`/api/agent/overview?${orgQ}`).then((d) => alive && setOv(d)).catch(() => {});
    api<Todo[]>(`/api/todos?${orgQ}`).then((d) => alive && setTodos(d)).catch(() => {});
    // 일정은 현재 컨텍스트(개인/조직) 범위로
    api<Meeting[]>(`/api/meetings/schedule?${orgQ}`)
      .then((d) => alive && setSchedule(d))
      .catch(() => {});
    // 오늘 브리핑 — AI 총무의 하루 세팅 문단
    api<{ text: string }>(`/api/agent/daily?${orgQ}`)
      .then((d) => alive && setDaily(d.text))
      .catch(() => {});
    // P2 — 자리 비운 사이 놓친 것 브리핑
    api<Catchup>(`/api/agent/catchup?${orgQ}`)
      .then((d) => alive && setCatchup(d))
      .catch(() => {});
    // P1 — 확인 대기 결정 (홈에서 바로 회람 사인)
    setPending(null);
    api<{ items: PendingDecision[] }>(`/api/agent/pending-decisions?${orgQ}`)
      .then((d) => alive && setPending(d.items))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [org]);

  const openMeeting = (code: string, title: string) =>
    window.dispatchEvent(new CustomEvent('exist:open-meeting', { detail: { code, title } }));
  const newMeeting = () => window.dispatchEvent(new CustomEvent('exist:new-meeting'));

  const live = ov?.liveCalls[0];
  // 내 지표
  const doneCount = todos.filter((t) => t.done).length;
  const donePct = todos.length ? Math.round((doneCount / todos.length) * 100) : 0;
  const nowMs = Date.now();
  const weekCount = schedule.filter(
    (s) =>
      s.starts_at &&
      new Date(s.starts_at).getTime() >= nowMs &&
      new Date(s.starts_at).getTime() <= nowMs + 7 * 864e5,
  ).length;
  const avatarVal = ov?.avatar ?? user?.avatar ?? '🐧';
  const avatarIsImg =
    avatarVal.startsWith('/api') ||
    avatarVal.startsWith('http') ||
    avatarVal.startsWith('/uploads');
  const nextStr = ov?.nextMeeting?.startsAt
    ? new Date(ov.nextMeeting.startsAt).toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  // 전체 할 일 카드 — 개인/조직 홈 공용 (todos는 이미 탭 스코프로 조회됨)
  const todoCard = (
    <div style={cellCard}>
      <div style={sectionHead}><span style={headIcon}><ListIcon size={16} /></span> 전체 할 일</div>
      {todos.length === 0 ? (
        <div style={emptyRow}>할 일이 없어요</div>
      ) : (
        <div className="hub-todos">
          {/* 회의 대시보드의 할 일과 같은 컴포넌트 언어(.hub-todo) — 체크로 완료 토글 */}
          {[...todos]
            .sort((a, b) => a.done - b.done)
            .slice(0, 8)
            .map((t) => (
              <div key={t.id} className={`hub-todo${t.done ? ' done' : ''}`}>
                <label className="hub-todo-label">
                  <input type="checkbox" checked={!!t.done} onChange={() => void toggleTodo(t)} />
                  <span className="hub-todo-check" aria-hidden>
                    <CheckMarkIcon size={16} />
                  </span>
                  <Marquee className="hub-todo-text">{t.title}</Marquee>
                </label>
                {t.due_at && dueBadge(t.due_at) && (
                  <span className={`nb-todo-due ${dueBadge(t.due_at)!.cls}`}>
                    {dueBadge(t.due_at)!.label}
                  </span>
                )}
                {t.meeting_title && (
                  <span className="hub-todo-meet" title={`"${t.meeting_title}" 회의에서 배정됨`}>
                    {t.meeting_title}
                  </span>
                )}
                <button className="hub-todo-del" title="삭제" onClick={() => void removeTodo(t)}>
                  ×
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );

  // 확인할 결정 카드 — P1의 홈 얼굴. 결정이 전달되고 "확인"되어야 끝난다 — 홈에서 바로 회람 사인
  const ackCard = (
    <div style={cellCard}>
      <div style={sectionHead}>
        <span style={headIcon}><CheckIcon size={16} /></span> 확인할 결정
        {pending && pending.length > 0 && <span className="pd-ack-count">{pending.length}</span>}
      </div>
      {!pending || pending.length === 0 ? (
        <div style={emptyRow}>
          {pending ? '모두 확인했어요 — 새 결정이 기록되면 여기에 떠요' : '불러오는 중…'}
        </div>
      ) : (
        pending.slice(0, 5).map((p) => (
          <div key={`${p.recapId}-${p.idx}`} className="pd-ack-row">
            <div
              className="pd-ack-main"
              onClick={() => openMeeting(p.code, p.title)}
              title={`"${p.title}" 열기`}
            >
              <Marquee className="pd-ack-text">{p.decision}</Marquee>
              <span className="pd-ack-meta">
                {p.title} ·{' '}
                {new Date(p.ts).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
              </span>
            </div>
            <button
              className="pd-ack-btn"
              onClick={() => void confirmDecision(p)}
              title="수신확인 — 회람 사인"
            >
              확인
            </button>
          </div>
        ))
      )}
    </div>
  );

  // ── 조직 홈 — 관리자는 팀 인사이트, 멤버는 "내 포커스" (내가 지금 챙길 것) ──
  if (org !== 'personal') {
    const orgInfo = orgs.find((o) => o.id === org);
    const orgName = orgInfo?.name ?? '조직';
    const orgManager = !!orgInfo?.isManager;
    return (
      <div className="pd-wrap" style={wrap}>
        <div className="pd-hero org">
          <div className="pd-hero-avatar">👥</div>
          <div>
            <div style={heroGreeting}>
              <span className="pd-ws-tag">🏢 {orgName} · </span>
              {greeting()}
            </div>
            <div className="pd-hero-name">{orgName} 팀</div>
            <div style={heroChips}>
              <span style={heroChip}>
                {orgManager ? '📊 팀 협업 현황을 아래에서 한눈에' : '📌 지금 챙길 것부터 아래에 모아뒀어요'}
              </span>
            </div>
          </div>
        </div>

        <div style={section}>
          <div style={sectionHead}>⚡ 빠른 시작</div>
          <div className="pd-actions" style={actionRow}>
            {/* 조직 그룹 생성은 권한제 — owner/admin 또는 group:create 역할만 */}
            {(orgInfo?.canCreateGroup ?? true) && (
              <button style={actionBtn} onClick={newMeeting}>
                <span style={{ fontSize: 20 }}>＋</span> 새 그룹 만들기
              </button>
            )}
            <button style={actionBtn} onClick={() => navigate(`/org/${org}`)}>
              <span style={{ fontSize: 18 }}>👥</span> 조직도 보기
            </button>
          </div>
        </div>

        {/* 2컬럼: 왼쪽 = (관리자: 인사이트 / 멤버: 내 포커스) + 오늘 브리핑 + 전체 일정, 오른쪽 = 통합 메시지 */}
        <div className="pd-quad">
          <div className="pd-quad-col">
            {ackCard}
            {orgManager ? <InsightsPanel orgId={org} /> : <MyOrgFocus orgId={org} />}

            <div style={cellCard}>
              <div style={sectionHead}><span style={headIcon}><SparklesIcon size={16} /></span> 오늘 브리핑</div>
              {daily ? (
                <div className="pd-daily-text">{daily}</div>
              ) : (
                <div className="pd-daily-text" style={{ color: 'var(--text-sub)' }}>
                  오늘 하루를 정리하는 중…
                </div>
              )}
            </div>

            <div style={cellCard}>
              <div style={sectionHead}><span style={headIcon}><CalendarIcon size={16} /></span> 전체 일정</div>
              <ScheduleWidget schedule={schedule} onOpen={openMeeting} />
            </div>
          </div>

          <div className="pd-quad-col">
            {/* 개인 홈과 동일한 전체 할 일 — 이 조직 스코프의 할 일만 */}
            {todoCard}
            <div className="pd-org-inbox" style={{ ...cellCard, minHeight: 420 }}>
              <div style={sectionHead}><span style={headIcon}><ChatIcon size={16} /></span> 통합 메시지</div>
              <UnifiedInbox scope={org} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── 개인 홈 (내 중심) ──
  return (
    <div className="pd-wrap" style={wrap}>
      <div className="pd-hero personal">
        {/* 모바일: 헤더에 프로필이 없어서 여기가 프로필 수정 진입점 (✎ 뱃지는 모바일만 표시) */}
        <button
          className="pd-hero-avatar pd-hero-edit"
          onClick={() => window.dispatchEvent(new Event('exist:open-settings'))}
          title="프로필 수정"
        >
          {avatarIsImg ? (
            <img
              src={avatarVal}
              alt=""
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            avatarVal
          )}
          <span className="pd-hero-edit-badge" aria-hidden>
            ✎
          </span>
        </button>
        <div>
          <div style={heroGreeting}>
            {/* 워크스페이스 표기는 모바일에선 숨김 — 상단 조직 바가 이미 보여줌 */}
            <span className="pd-ws-tag">👤 개인 워크스페이스 · </span>
            {greeting()}
          </div>
          <div className="pd-hero-name">{user?.name || user?.username || '게스트'}님 👋</div>
          <div style={heroChips}>
            {/* 정사각 타일 — 지금 반응할 것 중심 (누적 통계는 내 지표 카드가 담당) */}
            <span className="pd-chip">
              <span className="pd-chip-label">확인할 결정</span>
              <b className="pd-chip-val">{ov?.pendingAcks ?? '–'}</b>
            </span>
            <span className="pd-chip">
              <span className="pd-chip-label">안 읽은 메시지</span>
              <b className="pd-chip-val">{ov?.unreadTotal ?? '–'}</b>
            </span>
            {!!ov?.todoOverdue && (
              <span className="pd-chip">
                <span className="pd-chip-label">마감 지남</span>
                <b className="pd-chip-val">{ov.todoOverdue}</b>
              </span>
            )}
            <span className="pd-chip">
              <span className="pd-chip-label">다음 일정</span>
              <b className="pd-chip-val text">
                {ov?.nextMeeting
                  ? `${ov.nextMeeting.title}${nextStr ? ` · ${nextStr}` : ''}`
                  : '없음'}
              </b>
            </span>
          </div>
        </div>
      </div>

      {live && (
        <div style={liveBox}>
          🔴 지금 <b>{live.title}</b>에서 {live.inCall}명 통화 중 — 아래 최근 그룹에서 참여하세요
        </div>
      )}

      <div style={section}>
        <div style={sectionHead}><span style={headIcon}><ChartIcon size={16} /></span> 내 지표</div>
        <div className="pd-stats">
          <div className="pd-stat">
            <div className="pd-stat-icon"><UsersIcon size={19} /></div>
            <div>
              <div className="pd-stat-num">{ov?.meetingCount ?? 0}</div>
              <div className="pd-stat-label">참여 그룹</div>
            </div>
          </div>
          <div className="pd-stat">
            <div className="pd-stat-icon"><CheckMarkIcon size={19} /></div>
            <div>
              <div className="pd-stat-num">{donePct}%</div>
              <div className="pd-stat-label">할 일 완료율</div>
            </div>
          </div>
          <div className="pd-stat">
            <div className="pd-stat-icon"><ListIcon size={19} /></div>
            <div>
              <div className="pd-stat-num">{doneCount}/{todos.length}</div>
              <div className="pd-stat-label">완료한 할 일</div>
            </div>
          </div>
          <div className="pd-stat">
            <div className="pd-stat-icon"><CalendarIcon size={19} /></div>
            <div>
              <div className="pd-stat-num">{weekCount}</div>
              <div className="pd-stat-label">이번 주 일정</div>
            </div>
          </div>
        </div>
      </div>

      <div className="pd-quad">
        {/* 좌우 컬럼을 분리 — 한쪽 카드가 길어져도 반대쪽 높이에 영향 없음 */}
        <div className="pd-quad-col">
        {ackCard}
        <div style={cellCard}>
          <div style={sectionHead}><span style={headIcon}><SparklesIcon size={16} /></span> 오늘 브리핑</div>
          {/* AI 총무의 하루 세팅 문단 — 오늘 일정 + 놓친 것 + 급한 할 일 */}
          {daily ? (
            <div className="pd-daily-text">{daily}</div>
          ) : (
            <div className="pd-daily-text" style={{ color: 'var(--text-sub)' }}>
              오늘 하루를 정리하는 중…
            </div>
          )}
          {catchup && catchup.items.length > 0 && (
            <>
              {catchup.items.slice(0, 5).map((it, i) => (
                <div
                  key={i}
                  style={{ ...listRow, cursor: it.meeting ? 'pointer' : 'default' }}
                  onClick={() => it.meeting && openMeeting(it.meeting.code, it.meeting.title)}
                  title={it.meeting ? `"${it.meeting.title}" 열기` : undefined}
                >
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 6,
                      background: it.type === 'recap' ? 'var(--green-soft)' : 'var(--surface-2)',
                      color: it.type === 'recap' ? 'var(--green)' : 'var(--text-sub)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {CATCHUP_BADGE[it.type]}
                  </span>
                  <Marquee className="pd-catchup-text">{it.text}</Marquee>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={cellCard}>
          <div style={sectionHead}><span style={headIcon}><CalendarIcon size={16} /></span> 전체 일정</div>
          <ScheduleWidget schedule={schedule} onOpen={openMeeting} />
        </div>
        </div>

        <div className="pd-quad-col">
        {todoCard}

        <div style={cellCard}>
          <div style={sectionHead}><span style={headIcon}><ChatIcon size={16} /></span> 통합 메시지</div>
          <UnifiedInbox scope={org} />
        </div>
        </div>
      </div>

    </div>
  );
}

// 패딩은 index.css의 .pd-wrap — 인라인이면 모바일 미디어쿼리가 못 줄임
const wrap: CSSProperties = {
  height: '100%',
  overflow: 'auto',
  boxSizing: 'border-box',
  background: 'var(--surface-2)',
};
const liveBox: CSSProperties = {
  background: 'rgba(229,72,77,0.08)',
  color: '#c0392b',
  borderRadius: 12,
  padding: '14px 18px',
  fontSize: 14.5,
  marginBottom: 24,
};
const actionRow: CSSProperties = { display: 'flex', gap: 12, marginBottom: 4, flexWrap: 'wrap' };
const actionBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  padding: '12px 20px',
  borderRadius: 12,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
};

/* ── 히어로 배너 — 레이아웃은 index.css의 .pd-hero* (모바일 축소 때문에 클래스) ── */
const heroGreeting: CSSProperties = { fontSize: 14, opacity: 0.85 };
const heroChips: CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap' };
const heroChip: CSSProperties = {
  background: 'rgba(255,255,255,0.16)',
  borderRadius: 11,
  padding: '7px 14px',
  fontSize: 13,
  display: 'flex',
  alignItems: 'baseline',
  gap: 7,
  whiteSpace: 'nowrap',
};
const section: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  boxShadow: 'var(--shadow-sm)',
  padding: '16px 20px',
  marginBottom: 14,
};
const sectionHead: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--text)',
  margin: '0 0 16px',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};
// 섹션 제목 아이콘 — 텍스트보다 한 톤 낮춘 회색
const headIcon: CSSProperties = { color: 'var(--text-sub)', display: 'inline-flex', alignItems: 'center' };
// 그리드 컨테이너(.pd-quad, .pd-stats)는 index.css — 인라인이면 미디어쿼리가 못 건드림
// grid 셀 카드 — section의 marginBottom을 없애 gap(14)만 세로 간격으로 적용
const cellCard: CSSProperties = { ...section, marginBottom: 0 };
// 내 지표 카드(.pd-stat*)는 index.css — 모바일에서 아이콘·글자 축소
const listRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 2px',
  fontSize: 14,
  borderBottom: '1px solid var(--border)',
};
const emptyRow: CSSProperties = { fontSize: 13, color: 'var(--text-sub)', padding: '8px 2px' };
