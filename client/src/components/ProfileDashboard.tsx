import { useEffect, useState, type CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuthStore } from '../store';
import { useOrgStore } from '../orgStore';
import InsightsPanel from './InsightsPanel';
import MyOrgFocus from './MyOrgFocus';
import { type Todo, type Meeting } from './NowBar';
import UnifiedInbox from './UnifiedInbox';
import { DmWindow, type Thread, type DmScope } from './DirectMessages';
import { dueBadge } from '../lib/due';
import ScheduleWidget from './ScheduleWidget';
import Marquee from './Marquee';
import { ListIcon, SparklesIcon, CalendarIcon, ChatIcon, UsersIcon, CheckMarkIcon, ChartIcon, CheckIcon, PenIcon, UserIcon, BoltIcon, BuildingIcon, CloseIcon } from './Icons';

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
  /** 이번 주(최근 7일) 내 그룹에서 나온 결정 수 — 스탯 카드 */
  weekDecisions: number;
  liveCalls: { title: string; code: string; inCall: number }[];
  recentMeetings: { title: string; code: string; inCall: number }[];
  nextMeeting: { title: string; code: string; startsAt: string | null } | null;
}

/** 지금 처리할 것 — 미확인 결정 + 기한 할 일 + 안읽은 DM (7/29 개편: "전달보다 확인"의 홈) */
interface Actions {
  decisions: PendingDecision[];
  todos: { id: number; title: string; due_at: string; code: string | null; mtitle: string | null }[];
  dms: {
    userId: number;
    username: string;
    name: string | null;
    avatar: string | null;
    unread: number;
    lastText: string;
    ts: number;
  }[];
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
  const [actions, setActions] = useState<Actions | null>(null);
  // 인박스 DM 답장 — 우하단 플로팅 창 (허브·홈 통합 메시지와 같은 창)
  const [dmPeer, setDmPeer] = useState<Thread | null>(null);
  const [statsOpen, setStatsOpen] = useState(false); // 지표·인사이트 한 줄 접힘

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
    // 지금 처리할 것 — 결정·기한 할 일·안읽은 DM 집계
    setActions(null);
    api<Actions>(`/api/agent/actions?${orgQ}`)
      .then((d) => alive && setActions(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [org]);

  /** 인박스 갱신 — 확인·답장·완료 후 재조회 */
  const reloadActions = () => {
    const orgQ = `org=${org === 'personal' ? 'personal' : org}`;
    void api<Actions>(`/api/agent/actions?${orgQ}`).then(setActions).catch(() => {});
  };

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
                  <CloseIcon size={12} />
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );

  // ── 7/29 개편 공용 조각 — "전달보다 확인": 히어로 카운트 + 지금 처리할 것 인박스 + 오늘 일정 ──
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const todayEvents = schedule
    .filter((s) => {
      if (!s.starts_at) return false;
      const t = new Date(s.starts_at).getTime();
      return t >= today0.getTime() && t < today0.getTime() + 864e5;
    })
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime());
  const overdueCount = actions
    ? actions.todos.filter((t) => new Date(t.due_at).getTime() < today0.getTime()).length
    : (ov?.todoOverdue ?? 0);
  const pendingCount = actions?.decisions.length ?? pending?.length ?? ov?.pendingAcks ?? 0;
  const inboxTotal = actions
    ? actions.decisions.length + actions.todos.length + actions.dms.length
    : 0;

  const heroLine = (
    <div className="pd-hero2-line">
      오늘 회의 <b>{todayEvents.length}건</b> <i>·</i> 마감 지난 할 일 <b>{overdueCount}건</b>{' '}
      <i>·</i> 확인 안 한 결정 <b>{pendingCount}건</b>
    </div>
  );
  const heroDaily = daily ? <div className="pd-hero2-daily">{daily}</div> : null;

  const dmThread = (d: Actions['dms'][number]): Thread => ({
    userId: d.userId,
    username: d.username,
    avatar: d.avatar,
    position: null,
    department: null,
    lastText: d.lastText,
    lastTs: d.ts,
    lastMine: false,
    unread: d.unread,
  });

  /** 인박스에서 결정 확인 — 낙관 제거 + 서버 기록 (회람 사인) */
  async function ackFromInbox(p: PendingDecision) {
    setActions((prev) =>
      prev
        ? {
            ...prev,
            decisions: prev.decisions.filter(
              (d) => !(d.recapId === p.recapId && d.idx === p.idx),
            ),
          }
        : prev,
    );
    setOv((prev) => (prev ? { ...prev, pendingAcks: Math.max(0, prev.pendingAcks - 1) } : prev));
    try {
      await api(`/api/meetings/${p.code}/decisions/ack`, {
        method: 'POST',
        body: { recapId: p.recapId, idx: p.idx },
      });
    } catch {
      reloadActions();
    }
  }

  /** 인박스에서 개인 할 일 완료 — 그룹 할 일은 [열기]로 그룹에서 처리 */
  async function doneFromInbox(id: number) {
    try {
      await api(`/api/todos/${id}`, { method: 'PATCH', body: { done: true } });
      setTodos((prev) => prev.map((x) => (x.id === id ? { ...x, done: 1 } : x)));
      reloadActions();
    } catch {
      /* 전역 토스트 */
    }
  }

  const inboxCard = (
    <div style={cellCard} className="pd-inbox">
      <div style={sectionHead}>
        <span style={headIcon}><CheckIcon size={16} /></span> 지금 처리할 것
        {inboxTotal > 0 && <span className="pd-ack-count">{inboxTotal}</span>}
        <span className="pd-inbox-hint">비우면 오늘 준비 끝</span>
      </div>
      {!actions ? (
        <div style={emptyRow}>불러오는 중…</div>
      ) : inboxTotal === 0 ? (
        <div className="pd-inbox-empty">
          <span className="pd-inbox-empty-ic"><CheckMarkIcon size={18} /></span>
          모두 처리했어요 — 오늘 준비 끝
          {(ov?.meetingCount ?? 1) === 0 && (
            <div className="pd-onboard">
              처음이신가요? <b>① 그룹 만들기</b> → <b>② 통화 시작</b> → <b>③ 통화가 끝나면 AI가
              결정·할 일을 자동 정리</b>해요. 왼쪽의 "새 그룹 만들기"부터 시작해보세요.
            </div>
          )}
        </div>
      ) : (
        <>
          {actions.decisions.map((p) => (
            <div key={`d-${p.recapId}-${p.idx}`} className="pd-act-row">
              <span className="pd-act-badge">결정</span>
              <div
                className="pd-act-main"
                onClick={() => openMeeting(p.code, p.title)}
                title={`"${p.title}" 열기`}
              >
                <Marquee className="pd-act-title">{p.decision}</Marquee>
                <span className="pd-act-sub">
                  {p.title} ·{' '}
                  {new Date(p.ts).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}{' '}
                  회의
                </span>
              </div>
              <button
                className="pd-ack-btn"
                onClick={() => void ackFromInbox(p)}
                title="수신확인 — 회람 사인"
              >
                확인
              </button>
            </div>
          ))}
          {actions.todos.map((t) => {
            const b = dueBadge(t.due_at);
            return (
              <div key={`t-${t.id}`} className="pd-act-row">
                <span className="pd-act-badge todo">할일</span>
                <div
                  className="pd-act-main"
                  onClick={() => t.code && openMeeting(t.code, t.mtitle ?? t.code)}
                >
                  <span className="pd-act-title">
                    {t.title}
                    {b && <span className={`nb-todo-due ${b.cls}`}>{b.label}</span>}
                  </span>
                  <span className="pd-act-sub">{t.mtitle ?? '개인 할 일'} · 담당 나</span>
                </div>
                {t.code ? (
                  <button
                    className="pd-ack-btn solid"
                    onClick={() => openMeeting(t.code!, t.mtitle ?? t.code!)}
                  >
                    열기
                  </button>
                ) : (
                  <button className="pd-ack-btn" onClick={() => void doneFromInbox(t.id)}>
                    완료
                  </button>
                )}
              </div>
            );
          })}
          {actions.dms.map((d) => (
            <div key={`m-${d.userId}`} className="pd-act-row">
              <span className="pd-act-badge dm">DM</span>
              <div className="pd-act-main" onClick={() => setDmPeer(dmThread(d))}>
                <span className="pd-act-title">
                  {d.name || d.username} · {d.lastText}
                </span>
                <span className="pd-act-sub">안 읽은 메시지 {d.unread}건</span>
              </div>
              <button className="pd-ack-btn" onClick={() => setDmPeer(dmThread(d))}>
                답장
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );

  const todayCard = (
    <div style={cellCard}>
      <div style={sectionHead}><span style={headIcon}><CalendarIcon size={16} /></span> 오늘 일정</div>
      {todayEvents.length === 0 ? (
        <div style={emptyRow}>오늘 일정이 없어요</div>
      ) : (
        todayEvents.map((s, i) => (
          <div
            key={`${s.code}-${i}`}
            className="pd-today-row"
            onClick={() => openMeeting(s.code, s.title)}
          >
            <b className="pd-today-time">
              {s.allDay
                ? '종일'
                : new Date(s.starts_at!).toLocaleTimeString('ko-KR', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
            </b>
            <span className="pd-today-title">{s.title}</span>
          </div>
        ))
      )}
    </div>
  );

  const dmScope: DmScope = org === 'personal' ? 'personal' : org;
  const dmWin = dmPeer ? (
    <DmWindow
      scope={dmScope}
      peer={dmPeer}
      onClose={() => {
        setDmPeer(null);
        reloadActions();
      }}
      onActivity={() => {}}
    />
  ) : null;

  // ── 조직 홈 — 관리자는 팀 인사이트, 멤버는 "내 포커스" (내가 지금 챙길 것) ──
  if (org !== 'personal') {
    const orgInfo = orgs.find((o) => o.id === org);
    const orgName = orgInfo?.name ?? '조직';
    const orgManager = !!orgInfo?.isManager;
    return (
      <div className="pd-wrap" style={wrap}>
        {/* 히어로 — 카운트 한 줄 + AI 브리핑 문장 (시안1: 오늘 회의 N · 마감 지남 N · 미확인 결정 N) */}
        <div className="pd-hero org pd-hero2">
          <div className="pd-hero2-body">
            <div className="pd-hero2-meta">
              <BuildingIcon size={12} /> {orgName} ·{' '}
              {new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} ·{' '}
              {greeting()}, {user?.name || user?.username}
            </div>
            {heroLine}
            {heroDaily}
          </div>
        </div>

        {live && (
          <div
            style={liveBox}
            className="pd-live-banner"
            role="button"
            tabIndex={0}
            onClick={() => openMeeting(live.code, live.title)}
            onKeyDown={(e) => e.key === 'Enter' && openMeeting(live.code, live.title)}
          >
            <span className="pd-live-dot" aria-hidden /> 지금 <b>{live.title}</b>에서 {live.inCall}명
            통화 중 — 눌러서 바로 참여
          </div>
        )}

        {inboxCard}

        <div className="pd-quad">
          <div className="pd-quad-col">
            {todayCard}
            <div style={cellCard}>
              <div style={sectionHead}><span style={headIcon}><CalendarIcon size={16} /></span> 전체 일정</div>
              <ScheduleWidget schedule={schedule} onOpen={openMeeting} />
            </div>
            {/* 빠른 시작 — 권한제 그룹 생성 + 조직도 */}
            <div style={cellCard}>
              <div style={sectionHead}><span style={headIcon}><BoltIcon size={16} /></span> 빠른 시작</div>
              <div className="pd-actions" style={actionRow}>
                {(orgInfo?.canCreateGroup ?? true) && (
                  <button style={actionBtn} onClick={newMeeting}>
                    <span style={{ fontSize: 20 }}>＋</span> 새 그룹 만들기
                  </button>
                )}
                <button style={actionBtn} onClick={() => navigate(`/org/${org}`)}>
                  <UsersIcon size={17} /> 조직도 보기
                </button>
              </div>
            </div>
          </div>

          <div className="pd-quad-col">
            {todoCard}
            <div className="pd-org-inbox" style={{ ...cellCard, minHeight: 420 }}>
              <div style={sectionHead}><span style={headIcon}><ChatIcon size={16} /></span> 통합 메시지</div>
              <UnifiedInbox scope={org} />
            </div>
          </div>
        </div>

        {/* 팀 인사이트 — 한 줄 접힘 (시안: "✦ 팀 인사이트 · 자세히") */}
        <div style={cellCard} className="pd-insight-line-card">
          <button className="pd-insight-line" onClick={() => setStatsOpen((v) => !v)}>
            <SparklesIcon size={14} /> {orgManager ? '팀 인사이트' : '내 포커스'}
            <span className="pd-insight-line-more">{statsOpen ? '접기 ▴' : '자세히 ▾'}</span>
          </button>
          {statsOpen && (
            <div className="pd-insight-body">
              {orgManager ? <InsightsPanel orgId={org} /> : <MyOrgFocus orgId={org} />}
            </div>
          )}
        </div>

        {dmWin}
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
            <PenIcon size={11} />
          </span>
        </button>
        <div className="pd-hero2-body">
          <div className="pd-hero2-meta">
            {/* 워크스페이스 표기는 모바일에선 숨김 — 상단 조직 바가 이미 보여줌 */}
            <span className="pd-ws-tag"><UserIcon size={12} /> 개인 워크스페이스 · </span>
            {new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} ·{' '}
            {greeting()}, {user?.name || user?.username || '게스트'}
            {ov?.nextMeeting && nextStr && (
              <span className="pd-hero2-next"> · 다음 일정 {ov.nextMeeting.title} {nextStr}</span>
            )}
          </div>
          {heroLine}
          {heroDaily}
        </div>
      </div>

      {live && (
        <div
          style={liveBox}
          className="pd-live-banner"
          role="button"
          tabIndex={0}
          onClick={() => openMeeting(live.code, live.title)}
          onKeyDown={(e) => e.key === 'Enter' && openMeeting(live.code, live.title)}
        >
          <span className="pd-live-dot" aria-hidden /> 지금 <b>{live.title}</b>에서 {live.inCall}명 통화 중 — 눌러서 바로 참여
        </div>
      )}

      {inboxCard}

      <div className="pd-quad">
        {/* 좌 = 오늘·못 본 사이·달력, 우 = 할 일·메시지 */}
        <div className="pd-quad-col">
        {todayCard}
        {catchup && catchup.items.length > 0 && (
          <div style={cellCard}>
            <div style={sectionHead}><span style={headIcon}><SparklesIcon size={16} /></span> 못 본 사이</div>
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
          </div>
        )}
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

      {/* 내 지표 — 한 줄 접힘 (시안: 인사이트 라인) */}
      <div style={cellCard} className="pd-insight-line-card">
        <button className="pd-insight-line" onClick={() => setStatsOpen((v) => !v)}>
          <ChartIcon size={14} /> 내 지표 · 참여 그룹 <b>{ov?.meetingCount ?? 0}</b> · 할 일{' '}
          <b>{doneCount}/{todos.length}</b>{todos.length > 0 && <> ({donePct}%)</>} · 이번 주 결정{' '}
          <b>{ov?.weekDecisions ?? 0}</b> · 이번 주 일정 <b>{weekCount}</b>
          <span className="pd-insight-line-more">{statsOpen ? '접기 ▴' : '자세히 ▾'}</span>
        </button>
        {statsOpen && (
          <div className="pd-stats" style={{ marginTop: 14 }}>
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
                <div className="pd-stat-num">
                  {doneCount}/{todos.length}
                  {todos.length > 0 && <span className="pd-stat-sub"> · {donePct}%</span>}
                </div>
                <div className="pd-stat-label">할 일 완료</div>
              </div>
            </div>
            {/* 이번 주 결정 — "결정이 조직에 남는다"의 홈 지표 (P1) */}
            <div className="pd-stat">
              <div className="pd-stat-icon"><BoltIcon size={19} /></div>
              <div>
                <div className="pd-stat-num">{ov?.weekDecisions ?? 0}</div>
                <div className="pd-stat-label">이번 주 결정</div>
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
        )}
      </div>

      {dmWin}
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

/* 히어로 배너 레이아웃은 index.css의 .pd-hero*·.pd-hero2* (모바일 축소 때문에 클래스) */
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
