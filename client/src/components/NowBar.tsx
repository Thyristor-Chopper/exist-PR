import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useAuthStore } from '../store';
import Logo from './Logo';
import SettingsModal from './SettingsModal';
import NotificationCenter from './NotificationCenter';
import Avatar from './Avatar';
import MeetingThumb from './MeetingThumb';
import Marquee from './Marquee';
import {
  PanelLeftIcon,
  CheckMarkIcon,
  SunIcon,
  MoonIcon,
  SparklesIcon,
  BellIcon,
  PhoneIcon,
  GearIcon,
  LogOutIcon,
} from './Icons';
import { getSocket } from '../lib/socket';
import { useOrgStore } from '../orgStore';
import { useDisplayName } from '../names';

function ThemeToggle() {
  const [dark, setDark] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
  );
  function toggle() {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('exist:theme', next ? 'dark' : 'light');
    setDark(next);
  }
  return (
    <button className="nowbar-theme" onClick={toggle} title={dark ? '라이트 모드' : '다크 모드'}>
      {dark ? <SunIcon size={18} /> : <MoonIcon size={17} />}
    </button>
  );
}

export interface Todo {
  id: number;
  title: string;
  done: number;
  due_at: string | null;
  /** 회의에서 배정된 할 일이면 그 회의 (recap 자동 배정 표시용) */
  meeting_code?: string | null;
  meeting_title?: string | null;
  /** 담당자 프로필 (회의 할 일 — 표시용, 이름∥아이디·아바타) */
  assigneeProfiles?: { username: string; name: string | null; avatar: string | null }[];
}

/** 할 일 담당자 미니 아바타 스택 + hover 전체 프로필 리스트 (허브·공동편집과 동일 톤).
 *  nowbar 카드는 overflow:hidden + transform이라 팝업이 잘림 → portal로 body에 띄우고 fixed 좌표 */
function TodoAssignees({ profiles }: { profiles?: Todo['assigneeProfiles'] }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  // up: 앵커가 화면 아래쪽(모바일 하단 바)이면 위로, 위쪽(데스크톱 상단 바)이면 아래로 연다
  const [tip, setTip] = useState<{ x: number; y: number; up: boolean } | null>(null);
  if (!profiles?.length) return null;
  return (
    <span
      className="nb-todo-assign"
      ref={anchorRef}
      onMouseEnter={() => {
        const r = anchorRef.current?.getBoundingClientRect();
        if (r) {
          const up = r.top > window.innerHeight / 2;
          setTip({ x: r.right, y: up ? r.top : r.bottom, up });
        }
      }}
      onMouseLeave={() => setTip(null)}
    >
      {profiles.slice(0, 3).map((p) => (
        <Avatar key={p.username} value={p.avatar} className="nb-todo-assign-avatar" />
      ))}
      {profiles.length > 3 && <span className="nb-todo-assign-more">+{profiles.length - 3}</span>}
      {tip &&
        createPortal(
          <span
            className={`hub-assign-tip nb-tip-portal ${tip.up ? 'dir-up' : 'dir-down'}`}
            style={{ left: tip.x, top: tip.y }}
            aria-hidden
          >
            {profiles.map((p) => (
              <span key={p.username} className="hub-assign-tip-row">
                <Avatar value={p.avatar} className="hub-assign-avatar" />
                <span>{p.name || p.username}</span>
              </span>
            ))}
          </span>,
          document.body,
        )}
    </span>
  );
}

export interface Meeting {
  id: number;
  code: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  allDay?: boolean; // 종일 일정 (time 없음)
  thumbnail?: string | null;
  /** 반복 회의를 펼친 occurrence 고유키 (일정 목록용) */
  occId?: string;
  recur?: string;
  /** 일정 항목이 속한 회의(그룹) 이름 — nowbar 그룹 구성용 */
  meetingTitle?: string;
  kind?: string;
}

const RECUR_LABEL: Record<string, string> = {
  daily: '매일',
  weekly: '매주',
  biweekly: '격주',
  monthly: '매월',
};

const mkey = (m: Meeting) => m.occId ?? String(m.id);

interface NotifItem {
  id: number;
  from: string;
  text: string;
  ts: number;
  kind?: string | null;
  /** 이 알림이 발생한 회의 — 있으면 종 대신 회의 썸네일 표시 + 클릭해 열기 */
  meeting?: { id: number; code?: string | null; title: string; thumbnail: string | null };
}

/** 알림음 (Web Audio, 에셋 없이) — 통화는 또렷한 3톤, 일반은 부드러운 2톤 */
let nbAudioCtx: AudioContext | null = null;
function playNotifSound(kind?: string | null) {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    nbAudioCtx = nbAudioCtx || new AC();
    const ctx = nbAudioCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    const tone = (freq: number, at: number, dur: number, vol: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'triangle'; // sine보다 부드럽고 풍부한 차임
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(vol, at + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0008, at + dur);
      o.start(at);
      o.stop(at + dur + 0.03);
    };
    if (kind === 'call') {
      // 통화: 맑은 상승 3음 (들어오라는 느낌)
      tone(659, t0, 0.5, 0.14); // E5
      tone(880, t0 + 0.13, 0.5, 0.14); // A5
      tone(1109, t0 + 0.26, 0.6, 0.15); // C#6
    } else {
      // 일반: 부드러운 '딩-동' 2음 차임
      tone(784, t0, 0.45, 0.12); // G5
      tone(523, t0 + 0.14, 0.6, 0.12); // C5
    }
  } catch {
    /* 무시 */
  }
}

/** 통화 알림 → 그 회의 통화 탭 열기 */
function openMeetingCall(code: string) {
  window.dispatchEvent(new CustomEvent('exist:open-meeting', { detail: { code, tab: 'call' } }));
}

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

const NOTIF_FLASH_MS = 8000;

/** "7월 8일 (오후) 4시 40분" 형식 — 확장 패널 등 문자열이 필요한 곳용 */
function formatNow(d: Date): string {
  const ampm = d.getHours() < 12 ? '오전' : '오후';
  const h12 = d.getHours() % 12 || 12;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${ampm}) ${h12}시 ${d.getMinutes()}분`;
}

/** 헤더 시계 — 좁은 데스크톱에선 "7월 18일" / "(오후) 9시 19분" 2줄로 접힘 (줄바꿈은 CSS) */
function NowClock({ now }: { now: Date }) {
  const ampm = now.getHours() < 12 ? '오전' : '오후';
  const h12 = now.getHours() % 12 || 12;
  return (
    <span className="nowbar-clock">
      <span className="nowbar-clock-date">
        {now.getMonth() + 1}월 {now.getDate()}일
      </span>{' '}
      <span className="nowbar-clock-time">
        ({ampm}) {h12}시 {now.getMinutes()}분
      </span>
    </span>
  );
}

/** "3시간 30분 뒤" */
function formatDiff(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}분 뒤`;
  if (m === 0) return `${h}시간 뒤`;
  return `${h}시간 ${m}분 뒤`;
}

/** 다음 일정 시작 표기 — 당일: "5시간 30분 뒤" / 내일: "내일 오전 8시" / 그 외: "6/12 오후 2시" */
function formatStart(start: Date, now: Date): string {
  const sameDay = start.toDateString() === now.toDateString();
  if (sameDay) return formatDiff(start.getTime() - now.getTime());
  const ampm = start.getHours() < 12 ? '오전' : '오후';
  const h12 = start.getHours() % 12 || 12;
  const min = start.getMinutes();
  const time = `${ampm} ${h12}시${min ? ` ${min}분` : ''}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (start.toDateString() === tomorrow.toDateString()) return `내일 ${time}`;
  return `${start.getMonth() + 1}/${start.getDate()} ${time}`;
}

interface CurrentCtx {
  meeting: Meeting;
  ongoing: boolean;
  label: string; // "종료 3시간 30분 뒤" / "시작 5분 뒤"
}

/** 선택된 회의 그룹 기준으로 보여줄 카드 추천. 0: 일정  1: 할 일  2: 진행 타임라인 */
function suggestCard(
  ctx: CurrentCtx | null,
  groupTodos: Todo[],
  now: Date,
  nextStartMs: number,
): { card: number; reason: string } {
  const t = now.getTime();

  if (ctx?.ongoing) return { card: 2, reason: '회의가 진행 중이에요' };

  // 30분 내 시작하는 일정 → 일정
  if (nextStartMs !== Infinity && (nextStartMs - t) / 60_000 <= 30) {
    return { card: 0, reason: '곧 시작하는 일정이 있어요' };
  }

  const pending = groupTodos.filter((td) => !td.done);
  if (nextStartMs !== Infinity) return { card: 0, reason: '다가오는 일정이 있어요' };
  if (pending.length > 0) return { card: 1, reason: '할 일이 남아 있어요' };
  return { card: 0, reason: '이 회의의 일정' };
}

/** 모드 카드 공통 — 왼쪽 현재 회의 블록 */
function CurrentBlock({
  ctx,
  onOpen,
}: {
  ctx: CurrentCtx | null;
  onOpen?: (m: Meeting) => void;
}) {
  if (!ctx) {
    return (
      <div className="nb-current">
        <div className="nb-thumb none" />
        <div className="nb-current-text">
          <div className="title">회의 없음</div>
          <div className="countdown tag">예정된 회의가 없습니다</div>
        </div>
      </div>
    );
  }
  return (
    <div
      className={`nb-current${onOpen ? ' clickable' : ''}`}
      onClick={onOpen ? () => onOpen(ctx.meeting) : undefined}
      title={onOpen ? '클릭하면 회의 공간이 열려요' : undefined}
    >
      <MeetingThumb
        id={ctx.meeting.id}
        title={ctx.meeting.title}
        thumbnail={ctx.meeting.thumbnail}
        className="nb-thumb"
      />
      <div className="nb-current-text">
        <Marquee className="title">{ctx.meeting.title}</Marquee>
        <Marquee className="countdown">
          <b>{ctx.ongoing ? '종료' : '시작'}</b> {ctx.label}
        </Marquee>
      </div>
    </div>
  );
}

/** 확장 패널 — 월 캘린더 (nowbar.png 첫 번째 모드) */
function MonthCalendar({ meetings, now }: { meetings: Meeting[]; now: Date }) {
  const [offset, setOffset] = useState(0);
  const base = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const year = base.getFullYear();
  const month = base.getMonth();
  const startDow = base.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();

  const meetingDays = new Set(
    meetings
      .filter((m) => {
        if (!m.starts_at) return false;
        const d = new Date(m.starts_at);
        return d.getFullYear() === year && d.getMonth() === month;
      })
      .map((m) => new Date(m.starts_at!).getDate()),
  );

  const cells: { day: number; cur: boolean }[] = [];
  for (let i = startDow - 1; i >= 0; i--) cells.push({ day: prevDays - i, cur: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, cur: true });
  while (cells.length % 7 !== 0) cells.push({ day: cells.length - startDow - daysInMonth + 1, cur: false });

  const isToday = (d: number, cur: boolean) =>
    cur && offset === 0 && d === now.getDate();

  return (
    <div className="nb-cal">
      <div className="nb-cal-head">
        <button onClick={() => setOffset((o) => o - 1)}>‹</button>
        <span>
          {year}년 {month + 1}월
        </span>
        <button onClick={() => setOffset((o) => o + 1)}>›</button>
      </div>
      <div className="nb-cal-grid">
        {['일', '월', '화', '수', '목', '금', '토'].map((w) => (
          <span key={w} className="nb-cal-dow">
            {w}
          </span>
        ))}
        {cells.map((c, i) => (
          <span
            key={i}
            className={`nb-cal-day${c.cur ? '' : ' out'}${isToday(c.day, c.cur) ? ' today' : ''}`}
          >
            {c.day}
            {c.cur && meetingDays.has(c.day) && <i className="nb-cal-mark" />}
          </span>
        ))}
      </div>
    </div>
  );
}

interface Props {
  todos?: Todo[];
  meetings?: Meeting[];
  /** 회의 그룹들(최근 회의) — 왼쪽에 하나를 띄우고 오른쪽은 그 그룹의 일정/할일/진행도 */
  groups?: Meeting[];
  /** 사이드바에서 클릭해 띄울 회의 그룹 코드 (있으면 자동선택보다 우선) */
  focusedCode?: string | null;
  onToggleTodo?: (todo: Todo) => void;
  onAddTodo?: (title: string) => void;
  /** 일정 클릭 → 회의 탭 열기 */
  onOpenMeeting?: (m: Meeting) => void;
  /** "+ 일정 추가" — 보고 있는 그룹(fg)이 있으면 그 그룹을 넘김(그 그룹 일정 탭으로), 없으면 새 그룹 일정 잡기 */
  onSchedule?: (m?: Meeting) => void;
  /** 사이드바 열고 닫기 */
  onToggleSidebar?: () => void;
}

function SidebarToggle({ onToggle }: { onToggle?: () => void }) {
  if (!onToggle) return null;
  return (
    <button className="nowbar-sidebar-toggle" onClick={onToggle} title="사이드바 열기/닫기">
      <PanelLeftIcon size={20} />
    </button>
  );
}

const CARD_COUNT = 3; // 점·휠 대상: 0 일정 · 1 할 일 · 2 진행 타임라인
const NOTIF_CARD = 3; // 알림은 AI가 잠깐 띄우는 오버레이 (점 없음)

function ProfileMenu({
  avatar,
  onOpenSettings,
}: {
  avatar: string;
  onOpenSettings: () => void;
}) {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const dn = useDisplayName();
  return (
    <div className="nowbar-profile">
      <Avatar value={avatar} className="nowbar-avatar" />
      <div className="profile-menu">
        <div className="profile-menu-box">
          <div className="profile-name">
            <Avatar value={avatar} className="profile-name-avatar" /> <b>{dn(user?.username)}</b>
          </div>
          <button className="profile-item" onClick={onOpenSettings}>
            <GearIcon size={16} /> 설정
          </button>
          <button className="profile-item danger" onClick={logout}>
            <LogOutIcon size={16} /> 로그아웃
          </button>
        </div>
      </div>
    </div>
  );
}

function NowBar({
  meetings = [],
  groups = [],
  focusedCode,
  onOpenMeeting,
  onSchedule,
  onToggleSidebar,
}: Props) {
  const dn = useDisplayName();
  const me = useAuthStore((s) => s.user);
  const [newTodo, setNewTodo] = useState('');
  const [groupTodos, setGroupTodos] = useState<Todo[]>([]);
  // nowbar는 "지금 내가 챙길 것" — 그룹 할 일 중 내 담당(또는 담당자 없는 공용)만.
  // 그룹 전체 목록은 허브 할 일 섹션이 담당.
  const myTodos = (list: Todo[]) =>
    list.filter(
      (t) =>
        !t.assigneeProfiles ||
        t.assigneeProfiles.length === 0 ||
        t.assigneeProfiles.some((p) => p.username === me?.username),
    );
  const [now, setNow] = useState(() => new Date());
  const [brief, setBrief] = useState('');
  const [aiCard, setAiCard] = useState<number | null>(null);
  const [aiReason, setAiReason] = useState('');
  const [aiSource, setAiSource] = useState<'ai' | 'rule' | null>(null);
  const [card, setCard] = useState(0);
  const [auto, setAuto] = useState(true);
  const [rotateIdx, setRotateIdx] = useState(0); // AI 모드에서 회의 그룹 번갈아 띄우기
  const [avatar, setAvatar] = useState('🐧');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 모바일 — 헤더에 프로필이 없어서 홈 대시보드 히어로가 이 이벤트로 설정을 연다
  useEffect(() => {
    const onOpen = () => setSettingsOpen(true);
    const onCloseShade = () => setShadeOpen(false);
    window.addEventListener('exist:open-settings', onOpen);
    window.addEventListener('exist:close-shade', onCloseShade);
    return () => {
      window.removeEventListener('exist:open-settings', onOpen);
      window.removeEventListener('exist:close-shade', onCloseShade);
    };
  }, []);
  // 모바일 — 폰 알림바처럼: 접힌 한 줄 바(.nb-mini), 탭하면 카드가 아래로 펼쳐짐(shade)
  const [shadeOpen, setShadeOpen] = useState(false);
  // 모바일 통합 알림 — 미니바 벨 뱃지용 미읽음 수 (벨 탭 → shade 알림 카드 + 읽음 처리)
  const [notifUnread, setNotifUnread] = useState(0);

  /** 모바일 — 카드(pill) 탭으로 shade 토글. 내부 버튼(점·AI 토글·참여 등) 클릭은 제외.
   *  미읽음 알림이 있으면 알림 카드로 열면서 읽음 처리 (별도 벨 없이 카드에 통합) */
  function onPillTap(e: React.MouseEvent) {
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    if ((e.target as Element).closest?.('button')) return;
    const opening = !shadeOpen;
    if (opening && notifUnread > 0) {
      pauseAuto(); // auto 모드가 카드를 되돌리지 않게 잠깐 수동
      setCard(NOTIF_CARD);
      setNotifUnread(0);
      void api('/api/notifications/read', { method: 'POST' }).catch(() => {});
    }
    setShadeOpen(opening);
  }
  const [notifs, setNotifs] = useState<NotifItem[]>([]);
  const [notifFlash, setNotifFlash] = useState(false);
  const wheelLock = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 프로필 아바타 로드
  useEffect(() => {
    api<{ avatar: string }>('/api/auth/me')
      .then((m) => setAvatar(m.avatar || '🐧'))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  // 알림 — 초기 로드 + 실시간 수신(새 알림 오면 알림 카드로 잠깐 플래시)
  useEffect(() => {
    void api<{ unread: number; items: NotifItem[] }>('/api/notifications')
      .then((d) => {
        setNotifs(d.items.slice(0, 10));
        setNotifUnread(d.unread ?? 0);
      })
      .catch(() => {});

    const socket = getSocket();
    function onNotify(n: NotifItem & { created_at?: string; kind?: string }) {
      if (typeof n.id !== 'number') return;
      const ts =
        typeof n.ts === 'number' ? n.ts : n.created_at ? Date.parse(n.created_at) : Date.now();
      setNotifs((prev) =>
        prev.some((x) => x.id === n.id) ? prev : [{ ...n, ts }, ...prev].slice(0, 10),
      );
      setNotifUnread((u) => u + 1);
      playNotifSound(n.kind); // 알림음 (통화/일반 구분)
      setNotifFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setNotifFlash(false), NOTIF_FLASH_MS);
      // 조직 가입/승인 알림이면 조직 목록·대기수 갱신
      if (n.kind === 'org-approved' || n.kind === 'org-request') {
        void useOrgStore.getState().load();
      }
    }
    socket.on('agent:notify', onNotify);
    return () => {
      socket.off('agent:notify', onNotify);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  // AI 브리핑 — 2분마다 갱신. 카드(그룹·일정)가 현재 탭 스코프라 브리핑도 같은 범위로
  const orgCurrent = useOrgStore((s) => s.current);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const b = await api<{ text: string; card?: number; reason?: string; source?: 'ai' | 'rule' }>(
          `/api/agent/brief?org=${useOrgStore.getState().contextParam()}`,
        );
        if (!alive) return;
        setBrief(b.text);
        if (typeof b.card === 'number') setAiCard(b.card);
        if (b.reason) setAiReason(b.reason);
        setAiSource(b.source ?? null);
      } catch {
        /* 무시 */
      }
    }
    void load();
    const t = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [meetings, groups, orgCurrent]);

  // 알림 플래시 즉시 해제 (사용자가 직접 조작하면)
  function dismissFlash() {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setNotifFlash(false);
  }

  // 사용자가 직접 카드를 넘기면 잠깐 수동 모드 — 30초 쉬면 다시 AI가 맡는다
  function pauseAuto() {
    setAuto(false);
    dismissFlash();
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setAuto(true), 30_000);
  }

  function onWheel(e: React.WheelEvent) {
    const nowMs = Date.now();
    if (nowMs - wheelLock.current < 450) return;
    if (Math.abs(e.deltaY) < 8) return;
    wheelLock.current = nowMs;
    pauseAuto();
    setCard((c) => (c + (e.deltaY > 0 ? 1 : -1) + CARD_COUNT) % CARD_COUNT);
  }

  // AI 자동/수동 토글 버튼
  function toggleAuto() {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    setAuto((a) => !a);
  }

  // ── 왼쪽: 가장 관련있는 회의 그룹 1개 / 오른쪽(스크롤): 그 그룹의 일정·할일·진행도 ──
  const ranked = groups.map((g) => {
    const evs = meetings.filter((m) => m.id === g.id && m.starts_at);
    const ongoing = evs.find(
      (m) => m.ends_at && new Date(m.starts_at!) <= now && now < new Date(m.ends_at),
    );
    const future = evs
      .filter((m) => new Date(m.starts_at!).getTime() > now.getTime())
      .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime());
    return {
      g,
      ongoing,
      future,
      nextT: future[0] ? new Date(future[0].starts_at!).getTime() : Infinity,
    };
  });
  // 새 알림이 오면 그 위에 알림 카드를 잠깐 오버레이 (점 없이)
  const notifFresh = notifFlash && notifs.length > 0;
  // 수동: 내가 클릭한 회의(focusedCode) / AI: 상황(진행 중·새 알림)·시간에 따라 번갈아
  const ongoingGroup = ranked.find((r) => r.ongoing);
  const notifMid = notifFresh ? notifs[0]?.meeting?.id : undefined;
  const notifGroup = notifMid != null ? ranked.find((r) => r.g.id === notifMid) : null;
  const autoCands = ranked.filter((r) => r.ongoing || r.future.length > 0);
  const rotating = autoCands.length ? autoCands[rotateIdx % autoCands.length] : null;

  const best = auto
    ? ongoingGroup || notifGroup || rotating || ranked[0] || null
    : (focusedCode ? ranked.find((r) => r.g.code === focusedCode) : null) || ranked[0] || null;
  const fg = best?.g ?? null;

  // 선택 그룹을 occurrence 컨텍스트로 (왼쪽 블록은 그룹 자체를 표시)
  const ctx: CurrentCtx | null = fg
    ? {
        meeting: fg,
        ongoing: !!best!.ongoing,
        label: best!.ongoing
          ? formatDiff(new Date(best!.ongoing.ends_at!).getTime() - now.getTime())
          : best!.future[0]
            ? formatStart(new Date(best!.future[0].starts_at!), now)
            : '예정된 일정 없음',
      }
    : null;

  // 선택 그룹의 공유 할 일 로드
  useEffect(() => {
    const code = fg?.code;
    if (!code) {
      setGroupTodos([]);
      return;
    }
    let alive = true;
    void api<Todo[]>(`/api/todos?meeting=${code}`)
      .then((t) => {
        if (alive) setGroupTodos(myTodos(t));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [fg?.code]);

  async function refetchGroupTodos() {
    if (!fg?.code) return;
    try {
      setGroupTodos(myTodos(await api<Todo[]>(`/api/todos?meeting=${fg.code}`)));
    } catch {
      /* 무시 */
    }
  }

  // 회의 안에서 할 일이 바뀌면(그 회의가 지금 nowbar에 떠 있으면) 같이 갱신
  useEffect(() => {
    function onTodos(e: Event) {
      const c = (e as CustomEvent<{ code?: string }>).detail?.code;
      if (fg?.code && (!c || c === fg.code)) void refetchGroupTodos();
    }
    window.addEventListener('exist:todos-changed', onTodos);
    return () => window.removeEventListener('exist:todos-changed', onTodos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fg?.code]);
  async function toggleGroupTodo(td: Todo) {
    await api(`/api/todos/${td.id}`, { method: 'PATCH', body: { done: !td.done } }).catch(() => {});
    void refetchGroupTodos();
  }
  async function addGroupTodo(title: string) {
    if (!fg?.code || !title.trim()) return;
    await api('/api/todos', { method: 'POST', body: { title, meeting: fg.code } }).catch(() => {});
    void refetchGroupTodos();
  }

  const localSug = suggestCard(ctx, groupTodos, now, best?.nextT ?? Infinity);
  const targetCard = ctx?.ongoing ? 2 : aiCard ?? localSug.card;
  const viewCard = notifFresh ? NOTIF_CARD : card;
  const reasonText = notifFresh
    ? '새 알림이 왔어요'
    : aiSource === 'ai' && aiReason
      ? aiReason
      : localSug.reason;

  useEffect(() => {
    if (auto && targetCard !== card) setCard(targetCard);
  }, [auto, targetCard, card]);

  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  // AI 모드: 회의 그룹을 주기적으로 번갈아 (진행 중·새 알림이 있으면 그게 우선)
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => setRotateIdx((i) => i + 1), 13_000);
    return () => clearInterval(t);
  }, [auto]);

  // 사이드바에서 회의를 직접 고르면 수동 모드로 전환 (그 회의를 따라감).
  // 모바일은 풀 AI 모드 — 토글·점이 없으니 수동으로 빠지면 복귀 수단이 없다
  useEffect(() => {
    if (focusedCode && !window.matchMedia('(max-width: 767px)').matches) setAuto(false);
  }, [focusedCode]);

  // 선택 그룹의 다가오는 일정 (최대 4개 = 2×2)
  const nexts = best?.future.slice(0, 4) ?? [];
  const shownTodos = [...groupTodos].sort((a, b) => a.done - b.done).slice(0, 2);

  // 진행도 — 선택 그룹의 진행 중 회의 타임라인
  let timeline: { pct: number; ticks: { pct: number; label: string }[] } | null = null;
  const og = best?.ongoing;
  if (og && og.starts_at && og.ends_at) {
    const s = new Date(og.starts_at).getTime();
    const e = new Date(og.ends_at).getTime();
    const pct = Math.min(100, Math.max(0, ((now.getTime() - s) / (e - s)) * 100));
    const ticks: { pct: number; label: string }[] = [];
    const first = new Date(og.starts_at);
    first.setMinutes(0, 0, 0);
    first.setHours(first.getHours() + 1);
    for (let t = first.getTime(); t < e; t += 3600_000) {
      const h = new Date(t).getHours();
      ticks.push({ pct: ((t - s) / (e - s)) * 100, label: `${h % 12 || 12}시` });
    }
    timeline = { pct, ticks };
  }

  /** 스택 내 상대 위치: front / next(오른쪽 아래 겹침) / hidden */
  const stackCls = (i: number) => {
    const rel = (i - card + CARD_COUNT) % CARD_COUNT;
    return rel === 0 ? ' front' : rel === 1 ? ' next' : ' hidden';
  };

  // 아무 데이터도 없으면 온보딩 카드만
  const isEmpty = groups.length === 0 && notifs.length === 0;

  if (isEmpty) {
    return (
      <header className={`nowbar${shadeOpen ? ' shade-open' : ''}`}>
        <Logo />
        <SidebarToggle onToggle={onToggleSidebar} />
        <div className="nowbar-pill" onClick={onPillTap}>
          <div className="nowbar-card front nb-onboard">
            <SparklesIcon size={13} /> 일정이나 할 일을 추가해 <b>nowbar</b>를 사용해보세요
          </div>
        </div>
        {shadeOpen && <button className="nb-shade-scrim" onClick={() => setShadeOpen(false)} />}
        <NowClock now={now} />
        <ThemeToggle />
        <NotificationCenter />
        <ProfileMenu avatar={avatar} onOpenSettings={() => setSettingsOpen(true)} />
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          avatar={avatar}
          onAvatarChange={setAvatar}
        />
      </header>
    );
  }

  return (
    <header className={`nowbar${shadeOpen ? ' shade-open' : ''}`}>
      <Logo />
      <SidebarToggle onToggle={onToggleSidebar} />

      {shadeOpen && <button className="nb-shade-scrim" onClick={() => setShadeOpen(false)} />}

      <div className="nowbar-pill" onWheel={onWheel} onClick={onPillTap} title="스크롤로 카드 전환">
        {/* 모바일 통합 알림 뱃지 — 탭하면 shade가 알림 카드로 열리며 읽음 처리 */}
        {notifUnread > 0 && (
          <span className="nb-pill-count" aria-label={`안 읽은 알림 ${notifUnread}개`}>
            {notifUnread > 9 ? '9+' : notifUnread}
          </span>
        )}
        {/* 카드 1 — 다음/이전 일정 모드 (최대 2×2) */}
        <div className={`nowbar-card${stackCls(0)}`}>
          <CurrentBlock ctx={ctx} onOpen={onOpenMeeting} />
          <div className="nowbar-divider" />
          <div className="nb-next-list nb-next-grid">
            {nexts.map((m) => (
              <div
                key={mkey(m)}
                className={`nb-next-row${onOpenMeeting ? ' clickable' : ''}`}
                onClick={onOpenMeeting ? () => onOpenMeeting(m) : undefined}
                title={onOpenMeeting ? '클릭하면 회의 공간이 열려요' : undefined}
              >
                <MeetingThumb id={m.id} title={m.title} thumbnail={m.thumbnail} className="nb-mini-thumb" />
                <Marquee className="nb-next-title">{m.title}</Marquee>
                {m.recur && m.recur !== 'none' && (
                  <span className="nb-recur-tag">{RECUR_LABEL[m.recur] ?? '반복'}</span>
                )}
                <span className="nb-next-start">
                  <b>시작</b> {m.allDay ? '종일' : formatStart(new Date(m.starts_at!), now)}
                </span>
              </div>
            ))}
            {nexts.length === 0 && <div className="nb-next-empty">다음 일정이 없어요</div>}
          </div>
        </div>

        {/* 카드 2 — todo list 모드 */}
        <div className={`nowbar-card${stackCls(1)}`}>
          <CurrentBlock ctx={ctx} onOpen={onOpenMeeting} />
          <div className="nowbar-divider" />
          <div className="nowbar-todos">
            {shownTodos.map((todo) => (
              <div key={todo.id} className={`nowbar-todo${todo.done ? ' done' : ''}`}>
                <span className="nowbar-todo-check" aria-hidden>
                  <CheckMarkIcon size={14} />
                </span>
                <Marquee className="nowbar-todo-text">{todo.title}</Marquee>
                <TodoAssignees profiles={todo.assigneeProfiles} />
              </div>
            ))}
            {groupTodos.length === 0 && (
              <div className="nowbar-todo">이 회의에 내 할 일이 없어요</div>
            )}
          </div>
        </div>

        {/* 카드 3 — 시간 보는 모드 (타임라인) */}
        <div className={`nowbar-card${stackCls(2)}`}>
          <CurrentBlock ctx={ctx} onOpen={onOpenMeeting} />
          <div className="nowbar-divider" />
          {timeline ? (
            <div className="nb-timeline">
              <div className="nb-timeline-fill" style={{ width: `${timeline.pct}%` }} />
              {timeline.ticks.map((t, i) => (
                <span key={i} className="nb-tick" style={{ left: `${t.pct}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
          ) : (
            <div className="nb-next-empty">진행 중인 그룹이 없어요</div>
          )}
        </div>

        {/* 알림 오버레이 — 새 알림 올 때만 front (점·휠 대상 아님) */}
        <div className={`nowbar-card nowbar-card-notif${viewCard === NOTIF_CARD ? ' front' : ' hidden'}`}>
          <div className={`nb-notif-lead${notifFresh ? ' fresh' : ''}`}>
            {notifs[0]?.meeting ? (
              <MeetingThumb
                id={notifs[0].meeting.id}
                title={notifs[0].meeting.title}
                thumbnail={notifs[0].meeting.thumbnail}
                className="nb-notif-thumb"
              />
            ) : (
              <span className="nb-notif-bell">
                <BellIcon size={20} />
              </span>
            )}
            <div className="nb-current-text">
              {notifs.length > 0 ? (
                <>
                  <Marquee className="title">{dn(notifs[0].from)}</Marquee>
                  <Marquee className="countdown">{notifs[0].text}</Marquee>
                </>
              ) : (
                <>
                  <div className="title">알림</div>
                  <div className="countdown tag">새 알림이 없어요</div>
                </>
              )}
            </div>
            {notifs[0]?.kind === 'call' && notifs[0]?.meeting?.code ? (
              <button
                className="nb-notif-join"
                onClick={() => openMeetingCall(notifs[0].meeting!.code!)}
              >
                <PhoneIcon size={14} /> 지금 들어가기
              </button>
            ) : (
              notifs.length > 0 && <span className="nb-notif-time">{relTime(notifs[0].ts)}</span>
            )}
          </div>
          <div className="nowbar-divider" />
          <div className="nb-next-list">
            {notifs.slice(1, 3).map((n) => (
              <div key={n.id} className="nb-next-row">
                {n.meeting ? (
                  <MeetingThumb
                    id={n.meeting.id}
                    title={n.meeting.title}
                    thumbnail={n.meeting.thumbnail}
                    className="nb-mini-thumb"
                  />
                ) : (
                  <span className="nb-notif-bell mini">
                    <BellIcon size={11} />
                  </span>
                )}
                <Marquee className="nb-next-title">{n.text}</Marquee>
                <span className="nb-next-start">{relTime(n.ts)}</span>
              </div>
            ))}
            {notifs.length <= 1 && (
              <div className="nb-next-empty">최근 알림이 여기 표시돼요</div>
            )}
          </div>
        </div>

        {/* AI 자동 관리 토글 */}
        <button
          className={`nowbar-auto${auto ? ' on' : ''}`}
          onClick={toggleAuto}
          title={
            auto
              ? `${aiSource === 'ai' ? 'exist AI' : 'AI'}가 관리 중 · ${reasonText}`
              : 'AI 자동 관리 켜기'
          }
        >
          <SparklesIcon size={12} />
          {auto ? 'AI' : '수동'}
        </button>

        {/* 카드 위치 점 */}
        <div className="nowbar-dots">
          {Array.from({ length: CARD_COUNT }, (_, i) => (
            <button
              key={i}
              className={`nowbar-dot${i === card ? ' active' : ''}`}
              onClick={() => {
                pauseAuto();
                setCard(i);
              }}
              aria-label={`카드 ${i + 1}`}
            />
          ))}
        </div>

        {/* hover 확장 패널 — 현재 카드 모드의 상세 */}
        <div className="nowbar-expand">
          <div className="nowbar-expand-box">
            {/* key=viewCard → 카드 전환 시 내용도 끌려나오는 애니메이션 재생 */}
            <div className="nb-expand-content" key={viewCard}>
            {viewCard === 0 && (
              <div className="nb-expand-schedule">
                <MonthCalendar
                  meetings={fg ? meetings.filter((m) => m.id === fg.id) : []}
                  now={now}
                />
                <div className="nb-upcoming">
                  <div className="nb-expand-title">
                    {fg ? `${fg.title} · 다가오는 일정` : '다가오는 일정'}
                    {onSchedule && (
                      <button type="button" className="nb-sched-add" onClick={() => onSchedule(fg ?? undefined)}>
                        + 일정 추가
                      </button>
                    )}
                  </div>
                  {nexts.map((m) => (
                    <div
                      key={mkey(m)}
                      className={`nb-next-row${onOpenMeeting ? ' clickable' : ''}`}
                      onClick={onOpenMeeting ? () => onOpenMeeting(m) : undefined}
                      title={onOpenMeeting ? '클릭하면 회의 공간이 열려요' : undefined}
                    >
                      <MeetingThumb id={m.id} title={m.title} thumbnail={m.thumbnail} className="nb-mini-thumb" />
                      <Marquee className="nb-next-title">{m.title}</Marquee>
                      {m.recur && m.recur !== 'none' && (
                        <span className="nb-recur-tag">{RECUR_LABEL[m.recur] ?? '반복'}</span>
                      )}
                      <span className="nb-next-start">
                        <b>시작</b> {m.allDay ? '종일' : formatStart(new Date(m.starts_at!), now)}
                      </span>
                    </div>
                  ))}
                  {nexts.length === 0 && (
                    <div className="nb-next-empty">예정된 일정이 없어요</div>
                  )}
                </div>
              </div>
            )}

            {viewCard === 1 && (
              <div className="nb-expand-todos">
                <div className="nb-expand-title">{fg ? `${fg.title} · 할 일` : '할 일'}</div>
                {[...groupTodos].sort((a, b) => a.done - b.done).map((todo) => (
                  <label key={todo.id} className={`nowbar-todo${todo.done ? ' done' : ''}`}>
                    <input
                      type="checkbox"
                      checked={!!todo.done}
                      onChange={() => void toggleGroupTodo(todo)}
                    />
                    <span className="nowbar-todo-check" aria-hidden>
                      <CheckMarkIcon size={14} />
                    </span>
                    <Marquee className="nowbar-todo-text">{todo.title}</Marquee>
                    <TodoAssignees profiles={todo.assigneeProfiles} />
                  </label>
                ))}
                {groupTodos.length === 0 && <div className="nb-next-empty">이 회의에 내 할 일이 없어요</div>}
                {fg && (
                  <form
                    className="nb-todo-add"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!newTodo.trim()) return;
                      void addGroupTodo(newTodo);
                      setNewTodo('');
                    }}
                  >
                    <input
                      placeholder="할 일 추가"
                      value={newTodo}
                      onChange={(e) => setNewTodo(e.target.value)}
                    />
                    <button type="submit">+</button>
                  </form>
                )}
              </div>
            )}

            {viewCard === 2 && (
              <div className="nb-expand-time">
                <div className="nb-expand-title">진행 상황</div>
                {og && og.starts_at && og.ends_at ? (
                  <>
                    <div className="nb-time-range">
                      <span>{formatNow(new Date(og.starts_at))} 시작</span>
                      <span>{formatNow(new Date(og.ends_at))} 종료</span>
                    </div>
                    {timeline && (
                      <div className="nb-timeline big">
                        <div
                          className="nb-timeline-fill"
                          style={{ width: `${timeline.pct}%` }}
                        />
                        {timeline.ticks.map((t, i) => (
                          <span key={i} className="nb-tick" style={{ left: `${t.pct}%` }}>
                            {t.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="nb-next-empty">진행 중인 그룹이 없어요</div>
                )}
              </div>
            )}

            {viewCard === NOTIF_CARD && (
              <div className="nb-expand-notifs">
                <div className="nb-expand-title">알림</div>
                {notifs.length === 0 ? (
                  <div className="nb-next-empty">새 알림이 없어요</div>
                ) : (
                  notifs.slice(0, 6).map((n) => (
                    <div key={n.id} className="nb-notif-erow">
                      {n.meeting ? (
                        <MeetingThumb
                          id={n.meeting.id}
                          title={n.meeting.title}
                          thumbnail={n.meeting.thumbnail}
                          className="nb-notif-ethumb"
                        />
                      ) : (
                        <span className="nb-notif-bell sm">
                          <BellIcon size={14} />
                        </span>
                      )}
                      <div className="nb-notif-erow-body">
                        <div className="nb-notif-erow-top">
                          <span className="nb-notif-from">{dn(n.from)}</span>
                          <span className="nb-notif-etime">{relTime(n.ts)}</span>
                        </div>
                        <div className="nb-notif-etext">{n.text}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
            </div>

            {/* 공통 푸터 — exist AI 브리핑 */}
            <div className="nb-expand-footer">
              <span className="nb-ai-mark">
                <SparklesIcon size={13} />
              </span>
              <Marquee className="ai-text">{brief || '상황을 분석하는 중이에요…'}</Marquee>
              <span className="nb-ai-by">exist AI</span>
            </div>
          </div>
        </div>
      </div>

      <NowClock now={now} />

      <ThemeToggle />
      <NotificationCenter />
      <ProfileMenu avatar={avatar} onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        avatar={avatar}
        onAvatarChange={setAvatar}
      />
    </header>
  );
}

// 사이드바 고정 토글 등 대시보드 리렌더에서 nowbar 전체가 다시 그려지지 않게
export default memo(NowBar);
