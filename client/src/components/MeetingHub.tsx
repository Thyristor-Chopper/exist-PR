import { Fragment, memo, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { getSocket, request } from '../lib/socket';
import { usePresence } from '../lib/usePresence';
import { useAuthStore } from '../store';
import MeetingView, { type ChatMessage } from './MeetingView';
import CollabFiles from './CollabFiles';
import DecisionLedger from './DecisionLedger';
import Avatar from './Avatar';
import MeetingThumb from './MeetingThumb';
import Marquee from './Marquee';
import MeetingSchedule from './MeetingSchedule';
import RecapPanel from './RecapPanel';
import { DmWindow, type DmScope, type Thread } from './DirectMessages';
import MentionInput, { type MentionCandidate } from './MentionInput';
import { togglePin, isPinned, PINS_EVENT } from '../lib/pins';
import { dueBadge } from '../lib/due';
import { useDisplayName } from '../names';
import {
  PhoneIcon,
  CalendarIcon,
  ChatIcon,
  GridIcon,
  FolderIcon,
  UsersIcon,
  GearIcon,
  CopyIcon,
  ListIcon,
  CheckMarkIcon,
  PinIcon,
  ChevronIcon,
  ShareIcon,
  BellIcon,
  BellOffIcon,
  AtSignIcon,
  PenIcon,
  CloseIcon,
  ChevronRightIcon,
} from './Icons';

interface Participant {
  userId: number;
  username: string;
  avatar: string | null;
  role: 'owner' | 'admin' | 'member' | null;
  position: string | null;
  department: string | null;
  isHost?: boolean;
}

interface MeetingSettings {
  locked: boolean;
  guestEdit: boolean;
  muteOnJoin: boolean;
}

type ChannelNotifyMode = 'all' | 'mention' | 'off';

interface ChatChannel {
  id: number;
  name: string;
  isDefault: boolean;
  /** 'call' = 통화 전용 채널 — 삭제 버튼 미노출 (서버도 삭제 보호) */
  kind?: string | null;
  /** 만든 사람 — 이름 수정 버튼 노출 판단 (수정 권한: 만든 사람·호스트·조직 관리자) */
  createdBy?: number;
  /** 내 알림 설정 (all=다 받기 / mention=@멘션만, 기본 / off=끄기) */
  notifyMode?: ChannelNotifyMode;
}

const NOTIFY_CYCLE: Record<ChannelNotifyMode, ChannelNotifyMode> = {
  all: 'mention',
  mention: 'off',
  off: 'all',
};
const NOTIFY_LABEL: Record<ChannelNotifyMode, string> = {
  all: '알림 다 받기',
  mention: '@멘션만 알림',
  off: '알림 끔',
};

/** 알림 모드 단색 아이콘 (종/@/종+슬래시) */
function NotifyModeIcon({ mode, size = 13 }: { mode: ChannelNotifyMode; size?: number }) {
  if (mode === 'all') return <BellIcon size={size} />;
  if (mode === 'off') return <BellOffIcon size={size} />;
  return <AtSignIcon size={size} />;
}

interface MeetingDetail {
  id: number;
  code: string;
  title: string;
  starts_at: string | null;
  ends_at: string | null;
  recur?: string | null;
  recur_until?: string | null;
  recur_except?: string[];
  host: string;
  isHost: boolean;
  /** 관리 권한 — 호스트 또는 소속 조직 owner/admin */
  canManage?: boolean;
  orgId: number | null;
  orgName: string | null;
  thumbnail: string | null;
  online: number;
  settings?: MeetingSettings;
  period?: { start: string | null; end: string | null } | null;
  participants: Participant[];
  callPeers: string[];
}

function formatRange(starts: string | null, ends: string | null): string | null {
  if (!starts) return null;
  const s = new Date(starts);
  const fmt = (d: Date) => {
    const ampm = d.getHours() < 12 ? '오전' : '오후';
    const h = d.getHours() % 12 || 12;
    return `${d.getMonth() + 1}/${d.getDate()} ${ampm} ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  if (!ends) return fmt(s);
  const e = new Date(ends);
  return `${fmt(s)} ~ ${fmt(e)}`;
}

/** 참가자를 부서별로 묶기 — 부서 있는 그룹 먼저(가나다), 미지정은 마지막 */
function groupByDept(people: Participant[]): { dept: string | null; people: Participant[] }[] {
  const map = new Map<string | null, Participant[]>();
  for (const p of people) {
    const key = p.department || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(p);
  }
  return [...map.entries()]
    .map(([dept, people]) => ({ dept, people }))
    .sort((a, b) => {
      if (a.dept === null) return 1;
      if (b.dept === null) return -1;
      return a.dept.localeCompare(b.dept, 'ko');
    });
}

/** 일정 진행 상태 뱃지 */
function scheduleState(
  starts: string | null,
  ends: string | null,
): { label: string; cls: string } | null {
  if (!starts) return null;
  const now = Date.now();
  const s = new Date(starts).getTime();
  const e = ends ? new Date(ends).getTime() : null;
  if (now < s) {
    const min = Math.round((s - now) / 60_000);
    if (min < 60) return { label: `${min}분 후 시작`, cls: 'soon' };
    const h = Math.round(min / 60);
    if (h < 24) return { label: `${h}시간 후 시작`, cls: '' };
    return { label: `${Math.round(h / 24)}일 후 시작`, cls: '' };
  }
  if (e && now >= e) return { label: '종료됨', cls: 'done' };
  return { label: '진행 중', cls: 'live' };
}

interface MeetingTodo {
  id: number;
  title: string;
  done: number;
  author?: string;
  /** 담당자 username 목록 (회의 할 일 — 여러 명 가능) */
  assignees?: string[];
  /** 마감일 YYYY-MM-DD — AI 총무가 임박·지남을 리마인드 */
  due_at?: string | null;
}

function dday(endDate: string): number | null {
  const end = new Date(endDate + 'T00:00:00');
  if (isNaN(end.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((end.getTime() - today.getTime()) / 86400000);
}
function formatBytes(n: number): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
function chatTime(ts: number): string {
  const d = new Date(ts);
  const ampm = d.getHours() < 12 ? '오전' : '오후';
  const h = d.getHours() % 12 || 12;
  return `${ampm} ${h}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function chatDateLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  if (d.toDateString() === now.toDateString()) return '오늘';
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return '어제';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${days[d.getDay()]})`;
}

type SubTab = 'dash' | 'call' | 'chat' | 'files' | 'decisions' | 'schedule' | 'settings';

interface Props {
  code: string;
  /** 통화 확대 상태 (오버레이) */
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 열 때 이동할 세부 탭 (최근회의 버튼 등) */
  gotoTab?: { tab: string; ts: number };
  /** 이 그룹 탭이 화면에 보이는지 — 숨김 탭의 에디터가 프레즌스에 잡히지 않게 */
  visible?: boolean;
}

/** PiP 한 칸(영상 패널) 기준 크기 — 16:9. 리사이즈는 이 단위로 스냅된다 */
const PIP_TILE_W = 320;
const PIP_TILE_H = 180;

/** 회의 탭 = 대시보드(메인) + 통화/채팅 서브탭 */
function MeetingHub({ code, expanded, onToggleExpand, gotoTab, visible = true }: Props) {
  const user = useAuthStore((s) => s.user);
  const presence = usePresence();
  const dn = useDisplayName();
  const [detail, setDetail] = useState<MeetingDetail | null>(null);
  const [subtab, setSubtab] = useState<SubTab>('dash');
  const [inCall, setInCall] = useState(false);
  // 참가자 명함에서 연 1:1 DM 창 (홈의 통합 메시지는 회의 탭에서 언마운트라 여기서 직접 띄움)
  const [dm, setDm] = useState<{ scope: DmScope; peer: Thread } | null>(null);
  const navigate = useNavigate();

  // 채팅 프로필 hover 카드 — 정보(조직도)·채팅(DM) 선택
  const [pcard, setPcard] = useState<{ p: Participant; x: number; y: number } | null>(null);
  const pcardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showProfileCard(username: string, el: HTMLElement) {
    const p = detail?.participants.find((x) => x.username === username);
    if (!p || username === user?.username) return; // 명단에 없거나(AI 등) 본인이면 카드 없음
    if (pcardTimer.current) clearTimeout(pcardTimer.current);
    const r = el.getBoundingClientRect();
    setPcard({ p, x: r.left, y: r.top });
  }
  /** 트리거→카드로 마우스가 건너갈 틈을 주고 닫기 (카드 진입 시 keep이 취소) */
  function hideProfileCardSoon() {
    if (pcardTimer.current) clearTimeout(pcardTimer.current);
    pcardTimer.current = setTimeout(() => setPcard(null), 200);
  }
  function keepProfileCard() {
    if (pcardTimer.current) clearTimeout(pcardTimer.current);
  }
  // 터치(hover 없음) 대비 — 카드 밖 아무 데나 누르면 닫힘
  useEffect(() => {
    if (!pcard) return;
    function onDown(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('.profile-card')) setPcard(null);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [pcard]);

  // @멘션 후보 — AI 총무 + 나를 뺀 참가자 전원 (채팅·통화 채팅 공용)
  const mentionCandidates: MentionCandidate[] = [
    { username: 'AI', avatar: '✦', sub: 'AI 총무' },
    ...(detail?.participants ?? [])
      .filter((p) => p.username !== user?.username)
      .map((p) => ({
        username: p.username,
        avatar: p.avatar,
        sub: [p.position, p.department].filter(Boolean).join(' · ') || null,
      })),
  ];

  /** AI 결정 후보 제안 메시지의 [원장에 기록] — 따옴표 안 발언을 결정으로 저장 */
  async function recordSuggestedDecision(suggestText: string) {
    const m = suggestText.match(/"([^"]+)"/);
    if (!m) return;
    try {
      await api(`/api/meetings/${code}/decisions/manual`, {
        method: 'POST',
        body: { text: m[1] },
      });
      window.dispatchEvent(
        new CustomEvent('app:error', { detail: '✓ 결정 원장에 기록했어요' }),
      );
    } catch {
      /* 전역 토스트 */
    }
  }

  /** 조직 회의 + 나·상대 둘 다 활성 멤버면 조직 스코프(홈 통합 메시지와 같은 방), 아니면 개인 DM */
  function openDm(p: Participant) {
    if (!detail || p.username === user?.username) return;
    const meRole = detail.participants.find((x) => x.username === user?.username)?.role ?? null;
    const scope: DmScope =
      detail.orgId != null && p.role != null && meRole != null ? detail.orgId : 'personal';
    setDm({
      scope,
      peer: {
        userId: p.userId,
        username: p.username,
        avatar: p.avatar,
        position: p.position,
        department: p.department,
        lastText: null,
        lastTs: null,
        lastMine: false,
        unread: 0,
      },
    });
  }

  // 모바일 — 서브 화면이 대시보드 위 오버레이로 뜨고, 드래그하면 아래 대시보드가 보인다
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 서브 화면이 열리면 nowbar shade(팝업)는 닫는다 — 레이어가 겹치지 않게
  useEffect(() => {
    if (subtab !== 'dash') window.dispatchEvent(new Event('exist:close-shade'));
  }, [subtab]);

  // 모바일 — 서브 화면(오버레이)을 좌우로 밀어서 나가기. 아래에 보이는 게 대시보드니까
  // 탭 간 이동이 아니라 대시보드 복귀가 맞다. 탭 진입은 대시보드 메뉴 타일로.
  const swipeRef = useRef<{ x: number; y: number; skip: boolean; moving: boolean } | null>(null);
  // 드래그 중 화면 x 오프셋 — 손가락을 따라감. null = 드래그 아님(트랜지션으로 복귀)
  const [swipeDx, setSwipeDx] = useState<number | null>(null);

  // Pointer Events — 터치·마우스 둘 다 발화
  function onHubPointerDown(e: React.PointerEvent) {
    if (subtab === 'dash' || !window.matchMedia('(max-width: 767px)').matches) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation(); // 페이지 스와이프(홈/그룹 전환)와 분리
    swipeRef.current = {
      x: e.clientX,
      y: e.clientY,
      // 예외 — 가로 드래그가 기능인 곳(캔버스·에디터·시트 스크롤·발표 요소) + 에디터 툴바류(오발 방지)
      skip: !!(e.target as Element).closest?.(
        'canvas, [contenteditable="true"], .cm-editor, .sheet-scroll, .slide-el, ' +
          '.doc-tools, .sheet-toolbar, .sheet-bar, .slide-bar, .vsc-tabbar, .cf-editor-bar, .slide-list',
      ),
      moving: false,
    };
  }

  function onHubPointerMove(e: React.PointerEvent) {
    const s = swipeRef.current;
    if (!s || s.skip || subtab === 'dash') return;
    // 창 밖에서 마우스를 놓은 채 돌아온 경우 정리
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      swipeRef.current = null;
      setSwipeDx(null);
      return;
    }
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.moving) {
      // 수평 의도가 분명해질 때까지 대기 (세로 스크롤 방해 금지)
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      s.moving = true;
      // 스크롤 등으로 타겟이 이벤트를 놓쳐도 끝까지 우리가 받도록
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* 이미 해제된 포인터 등 — 무시 */
      }
    }
    setSwipeDx(dx);
  }

  function onHubPointerUp(e: React.PointerEvent) {
    if (subtab === 'dash') return;
    const s = swipeRef.current;
    swipeRef.current = null;
    setSwipeDx(null);
    if (!s || s.skip) return;
    // ⚠️ stopPropagation은 스와이프가 실제 진행 중일 때만 — 무조건 걸면 Excalidraw처럼
    // window 레벨 pointerup으로 인터랙션을 끝내는 라이브러리가 '뗌'을 영영 못 받아
    // 캔버스 도형이 커서를 따라다니는 지옥이 열린다 (7/25 밤 그 버그의 진범).
    e.stopPropagation();
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    // 어느 방향이든 충분히 밀면 대시보드로 나가기 (통화는 inCall이면 미니 PiP로 유지됨)
    setSubtab('dash');
  }

  // pointercancel — 좌표를 믿을 수 없으니 내비게이션 없이 원위치만
  function onHubPointerAbort() {
    swipeRef.current = null;
    setSwipeDx(null);
  }
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [uploadingFile, setUploadingFile] = useState(false);
  const chatFileRef = useRef<HTMLInputElement>(null);
  // 채팅 채널 — 그룹 안에 채널 여러 개, activeChannel의 메시지만 표시
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [activeChannel, setActiveChannel] = useState<number | null>(null);
  const [channelUnread, setChannelUnread] = useState<Record<number, number>>({}); // 세션 내 안읽음 점
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [editChannelId, setEditChannelId] = useState<number | null>(null);
  const [editChannelName, setEditChannelName] = useState('');
  const activeChannelRef = useRef<number | null>(null);
  activeChannelRef.current = activeChannel;
  const [filesMounted, setFilesMounted] = useState(false); // 공동편집(파일시스템)은 한 번 열면 마운트 유지
  const [pipPos, setPipPos] = useState<{ x: number; y: number } | null>(null); // 무빙 통화창 위치
  const [pipW, setPipW] = useState<number>(() => {
    const s = Number(localStorage.getItem('exist:pipW'));
    return s >= PIP_TILE_W && s <= PIP_TILE_W * 4 ? s : PIP_TILE_W; // 기본 1칸(320)
  });
  const [pipH, setPipH] = useState<number>(() => {
    const s = Number(localStorage.getItem('exist:pipH'));
    return s >= PIP_TILE_H && s <= PIP_TILE_H * 3 ? s : PIP_TILE_H;
  });
  const pipDragRef = useRef<{ dx: number; dy: number } | null>(null);
  const pipResizeRef = useRef<{ right: number; bottom: number } | null>(null); // 리사이즈 앵커(우하단 고정)
  const pipElRef = useRef<HTMLElement | null>(null); // 드래그/리사이즈 중 직접 조작할 PiP 엘리먼트
  const pipRafRef = useRef<number | null>(null);
  const pipLatest = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const pipSizeLatest = useRef<{ w: number; h: number }>({ w: 320, h: 180 });
  const onlineRef = useRef<number>(1); // 통화 인원 — 리사이즈 캡(다 들어가면 그만)용
  const [todos, setTodos] = useState<MeetingTodo[]>([]);
  const [todoInput, setTodoInput] = useState('');
  // 할 일 마감·제목 인라인 편집
  const [newDue, setNewDue] = useState('');
  const [newDueOpen, setNewDueOpen] = useState(false);
  const [dueEditId, setDueEditId] = useState<number | null>(null);
  const [editTodoId, setEditTodoId] = useState<number | null>(null);
  const [editTodoTitle, setEditTodoTitle] = useState('');
  // 담당자 피커 — 열려있는 대상(할 일 id 또는 추가 폼 'new')과 추가 폼의 선택 상태
  const [assignPick, setAssignPick] = useState<number | 'new' | null>(null);
  const [newAssign, setNewAssign] = useState<string[]>([]);
  const [confirmDelMeeting, setConfirmDelMeeting] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  // 맨 위 고정 토글은 PinToggle(파일 하단)로 분리 — 허브 전체 리렌더 없이 스위치만 갱신

  // 회의 공유 할 일 로드
  useEffect(() => {
    let alive = true;
    void api<MeetingTodo[]>(`/api/todos?meeting=${code}`)
      .then((list) => {
        if (alive) setTodos(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code]);

  async function reloadTodos() {
    try {
      setTodos(await api<MeetingTodo[]>(`/api/todos?meeting=${code}`));
    } catch {
      /* 무시 */
    }
    // nowbar가 이 회의 할 일을 띄우고 있으면 같이 갱신
    window.dispatchEvent(new CustomEvent('exist:todos-changed', { detail: { code } }));
  }
  async function addTodo(e: React.FormEvent) {
    e.preventDefault();
    if (!todoInput.trim()) return;
    await api('/api/todos', {
      method: 'POST',
      body: { title: todoInput, meeting: code, assignees: newAssign, due_at: newDue || null },
    });
    setTodoInput('');
    setNewAssign([]);
    setAssignPick(null);
    setNewDue('');
    setNewDueOpen(false);
    void reloadTodos();
  }
  async function saveDue(t: MeetingTodo, value: string) {
    await api(`/api/todos/${t.id}`, { method: 'PATCH', body: { due_at: value || null } });
    setDueEditId(null);
    void reloadTodos();
  }
  async function renameTodo(e: React.FormEvent) {
    e.preventDefault();
    const title = editTodoTitle.trim();
    if (!title || editTodoId == null) {
      setEditTodoId(null);
      return;
    }
    await api(`/api/todos/${editTodoId}`, { method: 'PATCH', body: { title } });
    setEditTodoId(null);
    void reloadTodos();
  }
  async function toggleAssignee(t: MeetingTodo, username: string) {
    const cur = t.assignees ?? [];
    const next = cur.includes(username) ? cur.filter((n) => n !== username) : [...cur, username];
    await api(`/api/todos/${t.id}`, { method: 'PATCH', body: { assignees: next } });
    void reloadTodos();
  }
  async function toggleTodo(t: MeetingTodo) {
    await api(`/api/todos/${t.id}`, { method: 'PATCH', body: { done: !t.done } });
    void reloadTodos();
  }
  async function deleteTodo(t: MeetingTodo) {
    await api(`/api/todos/${t.id}`, { method: 'DELETE' });
    void reloadTodos();
  }

  useEffect(() => {
    if (subtab === 'files') setFilesMounted(true);
  }, [subtab]);

  // 채팅 화면 열람 presence — 보고 있는 그룹의 채팅 알림을 서버가 생략하는 근거.
  // 보는 중일 때만 마킹하고 떠날 때 해제 (숨은 탭이 남의 마킹을 덮지 않게 조건부)
  useEffect(() => {
    if (!(visible && subtab === 'chat')) return;
    const socket = getSocket();
    socket.emit('chat:viewing', { code });
    return () => {
      socket.emit('chat:viewing', { code: null });
    };
  }, [visible, subtab, code]);

  // 최근회의 버튼 등에서 세부 탭 지정 → 해당 탭으로 이동
  useEffect(() => {
    if (gotoTab?.tab) setSubtab(gotoTab.tab as SubTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gotoTab?.ts]);

  // 강퇴 알림 — 이 회의에서 내보내지면 안내
  useEffect(() => {
    const socket = getSocket();
    const onKicked = (data: { code: string }) => {
      if (data.code?.toUpperCase() === code.toUpperCase()) {
        window.dispatchEvent(
          new CustomEvent('app:error', { detail: '그룹에서 내보내졌어요.' }),
        );
      }
    };
    socket.on('meeting:kicked', onKicked);
    return () => {
      socket.off('meeting:kicked', onKicked);
    };
  }, [code]);

  // 무빙 통화창 드래그·리사이즈 — 리렌더 없이 DOM 직접 조작(+rAF), 상태는 놓을 때 1회만 커밋
  useEffect(() => {
    function onMove(e: PointerEvent) {
      const el = pipElRef.current;
      if (!el) return;

      // 리사이즈 (우하단 앵커 고정) — 한 화면(16:9 패널) 단위로 딱딱 스냅
      const a = pipResizeRef.current;
      if (a) {
        const N = onlineRef.current; // 통화 인원 — 다 들어가면 더 못 키움
        const maxCols = Math.max(1, Math.min(4, Math.floor((a.right - 6) / PIP_TILE_W)));
        const maxRows = Math.max(1, Math.min(4, Math.floor((a.bottom - 6) / PIP_TILE_H)));
        let cols = Math.max(1, Math.min(maxCols, Math.round((a.right - e.clientX) / PIP_TILE_W)));
        let rows = Math.max(1, Math.min(maxRows, Math.round((a.bottom - e.clientY) / PIP_TILE_H)));
        // 빈 열·행이 생기지 않게 — 모든 참가자가 들어갈 최소 격자까지만 허용
        cols = Math.min(cols, Math.ceil(N / rows));
        rows = Math.min(rows, Math.ceil(N / cols));
        cols = Math.min(cols, Math.ceil(N / rows));
        const w = cols * PIP_TILE_W;
        const h = rows * PIP_TILE_H;
        const left = a.right - w;
        const top = a.bottom - h;
        pipSizeLatest.current = { w, h };
        pipLatest.current = { x: left, y: top };
        if (pipRafRef.current == null) {
          pipRafRef.current = requestAnimationFrame(() => {
            pipRafRef.current = null;
            el.style.width = `${w}px`;
            el.style.height = `${h}px`;
            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
            el.style.setProperty('--pip-cols', String(cols));
          });
        }
        return;
      }

      // 위치 이동
      const d = pipDragRef.current;
      if (!d) return;
      const w = el.offsetWidth || 90;
      const h = el.offsetHeight || 60;
      const x = Math.max(6, Math.min(window.innerWidth - w - 6, e.clientX - d.dx));
      const y = Math.max(6, Math.min(window.innerHeight - h - 6, e.clientY - d.dy));
      pipLatest.current = { x, y };
      if (pipRafRef.current == null) {
        pipRafRef.current = requestAnimationFrame(() => {
          pipRafRef.current = null;
          const p = pipLatest.current;
          el.style.left = `${p.x}px`;
          el.style.top = `${p.y}px`;
        });
      }
    }
    function onUp() {
      if (pipRafRef.current != null) {
        cancelAnimationFrame(pipRafRef.current);
        pipRafRef.current = null;
      }
      if (pipResizeRef.current) {
        pipResizeRef.current = null;
        document.body.style.userSelect = '';
        const { w, h } = pipSizeLatest.current;
        setPipW(w);
        setPipH(h);
        setPipPos({ ...pipLatest.current });
        localStorage.setItem('exist:pipW', String(w));
        localStorage.setItem('exist:pipH', String(h));
        return;
      }
      if (pipDragRef.current) {
        pipDragRef.current = null;
        document.body.style.userSelect = '';
        setPipPos({ ...pipLatest.current }); // 최종 위치만 상태로 커밋
      }
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (pipRafRef.current != null) cancelAnimationFrame(pipRafRef.current);
    };
  }, []);

  // 통화 인원을 ref로 추적 (리사이즈 핸들러가 최신 값을 보도록)
  useEffect(() => {
    onlineRef.current = Math.max(1, detail?.online ?? 1);
  }, [detail?.online]);

  function startPipDrag(e: React.PointerEvent) {
    const t = e.target as HTMLElement;
    // 컨트롤·버튼·리사이즈 핸들 위에선 이동 드래그 시작 안 함
    if (t.closest('button') || t.closest('.meeting-controls') || t.closest('.hub-pip-resize')) return;
    const el = (e.currentTarget as HTMLElement).closest('.hub-call') as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    pipElRef.current = el;
    pipDragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    pipLatest.current = { x: rect.left, y: rect.top };
    // 좌표 기준으로 즉시 고정 (right/bottom 해제) — 이후 이동은 직접 조작
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  }

  function startPipResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const el = (e.currentTarget as HTMLElement).closest('.hub-call') as HTMLElement | null;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    pipElRef.current = el;
    pipResizeRef.current = { right: rect.right, bottom: rect.bottom }; // 우하단 고정점
    pipSizeLatest.current = { w: rect.width, h: rect.height };
    pipLatest.current = { x: rect.left, y: rect.top };
    document.body.style.userSelect = 'none';
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, subtab]);

  // 상세 + 현재 통화 인원 (10초 폴링)
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const d = await api<MeetingDetail>(`/api/meetings/${code}`);
        if (alive) {
          setDetail(d);
          // 회의 탭 제목 옆 조직 배지 + 조직별 탭 필터용 (WorkspacePanel 수신)
          window.dispatchEvent(
            new CustomEvent('meeting:org', {
              detail: { code: code.toUpperCase(), orgId: d.orgId, orgName: d.orgName },
            }),
          );
        }
      } catch {
        /* 전역 토스트 */
      }
    }
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code]);

  // 채널 목록 — 기본 채널("일반")은 서버가 자동 생성
  useEffect(() => {
    let alive = true;
    void api<ChatChannel[]>(`/api/meetings/${code}/channels`)
      .then((list) => {
        if (!alive) return;
        setChannels(list);
        setActiveChannel((cur) =>
          cur != null && list.some((c) => c.id === cur) ? cur : (list[0]?.id ?? null),
        );
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code]);

  // 회의 채팅 — 통화 여부 무관 구독 (inCall 변동 시 소켓 재생성 대응 위해 재구독)
  useEffect(() => {
    if (activeChannel == null) return;
    let alive = true;
    const socket = getSocket();

    function join() {
      // 재연결 시 놓친 메시지까지 복구 (활성 채널 히스토리 재로드 + 룸 재가입)
      void api<ChatMessage[]>(`/api/meetings/${code}/messages?channel=${activeChannel}`).then(
        (history) => {
          if (alive) setMessages(history);
        },
      );
      void request(socket, 'chat:join', { code }).catch(() => {});
    }
    join();
    // 채널로 들어왔으니 이 채널의 세션 안읽음 점은 해제
    setChannelUnread((prev) => ({ ...prev, [activeChannel]: 0 }));
    // 서버 재시작/네트워크 단절 후 socket.io가 자동 재연결되면 룸 멤버십이
    // 사라지므로 다시 join해야 메시지를 계속 받는다
    socket.on('connect', join);

    function onMessage(msg: ChatMessage) {
      if (msg.code && msg.code !== code.toUpperCase()) return;
      if (msg.channelId == null || msg.channelId === activeChannelRef.current) {
        setMessages((prev) => [...prev, msg]);
      } else {
        // 다른 채널 메시지 — 그 채널 탭에 안읽음 점
        setChannelUnread((prev) => ({ ...prev, [msg.channelId!]: (prev[msg.channelId!] ?? 0) + 1 }));
      }
      // 회의 탭 안읽음 배지용 (WorkspacePanel이 수신)
      window.dispatchEvent(new CustomEvent('meeting:message', { detail: { code: code.toUpperCase() } }));
    }
    socket.on('chat:message', onMessage);
    return () => {
      alive = false;
      socket.off('connect', join);
      socket.off('chat:message', onMessage);
    };
  }, [code, inCall, activeChannel]);

  function sendChat(e: React.FormEvent) {
    e.preventDefault();
    if (!chatInput.trim()) return;
    getSocket().emit('chat:send', { code, text: chatInput, channelId: activeChannel ?? undefined });
    setChatInput('');
  }

  async function createChannel(e: React.FormEvent) {
    e.preventDefault();
    const name = newChannelName.trim();
    if (!name) return;
    try {
      const ch = await api<ChatChannel>(`/api/meetings/${code}/channels`, {
        method: 'POST',
        body: { name },
      });
      setChannels((prev) => [...prev, { ...ch, isDefault: false }]);
      setActiveChannel(ch.id);
      setNewChannelName('');
      setNewChannelOpen(false);
    } catch {
      /* 전역 토스트 */
    }
  }

  async function renameChannel(e: React.FormEvent) {
    e.preventDefault();
    const name = editChannelName.trim();
    if (!name || editChannelId == null) {
      setEditChannelId(null);
      return;
    }
    try {
      const r = await api<{ id: number; name: string }>(
        `/api/meetings/${code}/channels/${editChannelId}`,
        { method: 'PATCH', body: { name } },
      );
      setChannels((prev) => prev.map((c) => (c.id === r.id ? { ...c, name: r.name } : c)));
      setEditChannelId(null);
    } catch {
      /* 전역 토스트 */
    }
  }

  async function cycleNotify(ch: ChatChannel) {
    const next = NOTIFY_CYCLE[ch.notifyMode ?? 'mention'];
    try {
      await api(`/api/meetings/${code}/channels/${ch.id}/notify`, {
        method: 'PUT',
        body: { mode: next },
      });
      setChannels((prev) => prev.map((c) => (c.id === ch.id ? { ...c, notifyMode: next } : c)));
    } catch {
      /* 전역 토스트 */
    }
  }

  async function deleteChannel(ch: ChatChannel) {
    if (!confirm(`#${ch.name} 채널을 삭제할까요? 채널의 메시지도 사라져요.`)) return;
    try {
      await api(`/api/meetings/${code}/channels/${ch.id}`, { method: 'DELETE' });
      setChannels((prev) => {
        const next = prev.filter((c) => c.id !== ch.id);
        if (activeChannelRef.current === ch.id) setActiveChannel(next[0]?.id ?? null);
        return next;
      });
    } catch {
      /* 전역 토스트 */
    }
  }

  async function reloadDetail() {
    try {
      const d = await api<MeetingDetail>(`/api/meetings/${code}`);
      setDetail(d);
    } catch {
      /* 무시 */
    }
  }

  // 대시보드 카드 — 최근 결정(원장 상위 3) + 다음 회의 아젠다 제안
  interface LedgerEntry {
    recapId: number;
    idx: number;
    decision: string;
    attendees: string[];
    ts: number;
    acks: { username: string; ts: number }[];
    /** 이 recap에서 파생된 할 일 (실행 추적) */
    todos?: { title: string; done: number }[];
  }
  interface AgendaItem {
    title: string;
    why: string;
  }
  const [recentDecisions, setRecentDecisions] = useState<LedgerEntry[]>([]);
  async function ackDecisionRow(d: LedgerEntry) {
    setRecentDecisions((prev) =>
      prev.map((x) =>
        x.recapId === d.recapId && x.idx === d.idx
          ? { ...x, acks: [...x.acks, { username: user?.username ?? '', ts: Date.now() }] }
          : x,
      ),
    );
    await api(`/api/meetings/${code}/decisions/ack`, {
      method: 'POST',
      body: { recapId: d.recapId, idx: d.idx },
    }).catch(() => {});
  }
  const [agenda, setAgenda] = useState<AgendaItem[] | null>(null); // null = 로딩 중
  const [agendaOpen, setAgendaOpen] = useState(false); // 회의 직전에만 가치 — 기본 접힘
  const [rosterOpen, setRosterOpen] = useState(false); // 참가자 명함 — 기본 접힘(아바타 스택만)
  const [remindSent, setRemindSent] = useState(false);
  /** 미확인 팔로업 — 최신 결정 중 미확인자가 있는 첫 항목 (관리자에게만 노출) */
  const unackedFollowup = (() => {
    if (!detail) return null;
    for (const d of recentDecisions) {
      const ackedNames = new Set(d.acks.map((a) => a.username));
      const missing = detail.participants.filter((p) => !ackedNames.has(p.username)).length;
      if (missing > 0) return { d, missing };
    }
    return null;
  })();
  async function remindDecision(d: LedgerEntry) {
    try {
      await api<{ reminded: number }>(`/api/meetings/${code}/decisions/remind`, {
        method: 'POST',
        body: { recapId: d.recapId, idx: d.idx },
      });
      setRemindSent(true);
    } catch (err) {
      // 쿨다운(이미 최근에 보냄)도 사용자에겐 "보냄" 상태가 맞음 — 나머지는 전역 토스트
      if (String((err as Error)?.message ?? '').includes('이미')) setRemindSent(true);
    }
  }
  useEffect(() => {
    let alive = true;
    void api<LedgerEntry[]>(`/api/meetings/${code}/decisions`)
      .then((d) => alive && setRecentDecisions(d.slice(0, 3)))
      .catch(() => {});
    void api<{ items: AgendaItem[] }>(`/api/meetings/${code}/agenda`)
      .then((a) => alive && setAgenda(a.items))
      .catch(() => alive && setAgenda([]));
    return () => {
      alive = false;
    };
  }, [code]);
  async function kickParticipant(username: string) {
    if (!confirm(`${dn(username)} 님을 그룹에서 내보낼까요?`)) return;
    try {
      await api(`/api/meetings/${code}/participants/${encodeURIComponent(username)}`, {
        method: 'DELETE',
      });
      void reloadDetail();
    } catch {
      /* 전역 토스트 */
    }
  }
  async function transferHost(username: string) {
    if (!confirm(`${dn(username)} 님에게 호스트를 위임할까요?`)) return;
    try {
      await api(`/api/meetings/${code}/host`, { method: 'PATCH', body: { username } });
      void reloadDetail();
    } catch {
      /* 전역 토스트 */
    }
  }
  async function deleteMeeting() {
    if (!confirmDelMeeting) {
      setConfirmDelMeeting(true);
      return;
    }
    try {
      await api(`/api/meetings/${code}`, { method: 'DELETE' });
      // 대시보드·nowbar 갱신 + 열린 탭 닫기 (WorkspacePanel이 수신)
      window.dispatchEvent(new CustomEvent('exist:schedule-changed'));
      window.dispatchEvent(new CustomEvent('exist:meeting-deleted', { detail: { code } }));
    } catch {
      setConfirmDelMeeting(false);
    }
  }
  async function updateSettings(patch: Partial<MeetingSettings>) {
    const cur = detail?.settings ?? { locked: false, guestEdit: true, muteOnJoin: false };
    try {
      await api(`/api/meetings/${code}/settings`, { method: 'PATCH', body: { ...cur, ...patch } });
      void reloadDetail();
    } catch {
      /* 전역 토스트 */
    }
  }
  async function sendChatFile(file: File) {
    if (!file || uploadingFile) return;
    setUploadingFile(true);
    try {
      const token = useAuthStore.getState().token;
      const res = await fetch(`/api/workspaces/uploads?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: file,
      });
      const { url } = (await res.json()) as { url: string };
      getSocket().emit('chat:send', {
        code,
        text: '',
        file: { name: file.name, url, size: file.size },
        channelId: activeChannel ?? undefined,
      });
    } catch {
      window.dispatchEvent(new CustomEvent('app:error', { detail: '파일 업로드 실패' }));
    } finally {
      setUploadingFile(false);
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 수동 복사 */
    }
  }

  /** 초대 링크 복사 — 받는 사람은 링크만 누르면 (로그인 후) 자동으로 이 그룹에 참여된다 */
  async function copyInviteLink() {
    try {
      await navigator.clipboard.writeText(`${location.origin}/join/${code}`);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      /* 수동 복사 */
    }
  }

  function joinCall() {
    // 통화 탭으로 이동 → MeetingView가 프리뷰(디바이스 확인)부터 띄움.
    // 실제 통화 시작(inCall)은 프리뷰의 '입장하기' → onJoined에서 처리.
    setSubtab('call');
  }

  const range = detail ? formatRange(detail.starts_at, detail.ends_at) : null;

  return (
    <div
      className="meeting-hub"
      onPointerDown={onHubPointerDown}
      onPointerMove={onHubPointerMove}
      onPointerUp={onHubPointerUp}
      onPointerCancel={onHubPointerAbort}
    >
      {/* 서브탭 — 대시보드가 메인 */}
      <div className="hub-tabs">
        <button
          className={`hub-tab${subtab === 'dash' ? ' active' : ''}`}
          onClick={() => setSubtab('dash')}
        >
          <GridIcon size={14} /> 대시보드
        </button>
        <button
          className={`hub-tab${subtab === 'schedule' ? ' active' : ''}`}
          onClick={() => setSubtab('schedule')}
        >
          <CalendarIcon size={13} /> 일정
        </button>
        <button
          className={`hub-tab${subtab === 'call' ? ' active' : ''}`}
          onClick={() => setSubtab('call')}
        >
          <PhoneIcon size={13} /> 통화
          {/* 인원수 배지가 깜빡이며 라이브 표시까지 겸함 — live-dot과 중복이라 점은 제거 */}
          {(detail?.online ?? 0) > 0 && (
            <span className="hub-tab-count blink">{detail!.online}</span>
          )}
        </button>
        <button
          className={`hub-tab${subtab === 'chat' ? ' active' : ''}`}
          onClick={() => setSubtab('chat')}
        >
          <ChatIcon size={13} /> 채팅
        </button>
        <button
          className={`hub-tab${subtab === 'files' ? ' active' : ''}`}
          onClick={() => setSubtab('files')}
        >
          <FolderIcon size={14} /> 공동편집
        </button>
        <button
          className={`hub-tab${subtab === 'decisions' ? ' active' : ''}`}
          onClick={() => setSubtab('decisions')}
        >
          <CheckMarkIcon size={13} /> 결정
        </button>
        <button
          className={`hub-tab${subtab === 'settings' ? ' active' : ''}`}
          onClick={() => setSubtab('settings')}
        >
          <GearIcon size={14} /> 설정
        </button>
      </div>

      <div className="hub-body">
        {/* 대시보드 (메인) — 모바일에선 서브 화면 오버레이 아래층으로 항상 렌더 */}
        {(subtab === 'dash' || isMobile) && (
          <div className="hub-dash">
            {!detail ? (
              <div className="hub-loading">그룹 정보를 불러오는 중…</div>
            ) : (
              <>
                {/* HERO — 회의 정보 + 통화 CTA 통합 */}
                <section className="hub-hero">
                  <MeetingThumb
                    id={detail.id}
                    title={detail.title}
                    thumbnail={detail.thumbnail}
                    className="hub-hero-thumb"
                  />
                  <div className="hub-hero-main">
                    <h2 className="hub-hero-title">
                      {/* 제목이 길면 줄바꿈 대신 Marquee로 흘려서 코드 칩 자리를 확보 */}
                      <Marquee className="hub-hero-title-text">{detail.title}</Marquee>
                      <button className="hub-hero-code" onClick={copyCode} title="그룹 코드 복사">
                        {detail.code}{' '}
                        {copied ? <CheckMarkIcon size={13} /> : <CopyIcon size={13} />}
                      </button>
                    </h2>
                    <div className="hub-hero-sub">
                      호스트 <b>{dn(detail.host)}</b>
                      {detail.isHost && ' (나)'}
                      {detail.orgName && <span className="hub-sub-org"> · {detail.orgName}</span>}
                    </div>
                    <div className="hub-hero-chips">
                      {range && (
                        <span className="hub-hero-when">
                          <CalendarIcon size={13} /> {range}
                        </span>
                      )}
                      {detail.period && (
                        <span className="hub-hero-when">
                          <CalendarIcon size={13} /> 기간 {detail.period.start ?? '?'} ~{' '}
                          {detail.period.end ?? '?'}
                          {detail.period.end &&
                            (() => {
                              const d = dday(detail.period.end);
                              return d != null ? (
                                <b className="hub-hero-dday">
                                  {d > 0 ? `D-${d}` : d === 0 ? 'D-DAY' : `D+${-d}`}
                                </b>
                              ) : null;
                            })()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="hub-hero-cta">
                    {detail.online > 0 ? (
                      <span className="hub-live">
                        <i className="live-dot" /> {detail.online}명 통화 중
                      </span>
                    ) : (
                      <span className="hub-hero-idle">대기 중</span>
                    )}
                    <button className="hub-join lg" onClick={joinCall}>
                      <PhoneIcon size={18} /> {inCall ? '통화로 돌아가기' : '통화 참여'}
                    </button>
                  </div>
                </section>

                {/* 모바일 전용 메뉴 — 상단 탭 대신 대시보드에서 각 화면을 새 창처럼 연다 */}
                <section className="hub-m-menu">
                  <button className="hub-m-item" onClick={() => setSubtab('schedule')}>
                    <CalendarIcon size={19} /> 일정
                  </button>
                  <button className="hub-m-item" onClick={() => setSubtab('call')}>
                    <PhoneIcon size={19} /> 통화
                    {(detail?.online ?? 0) > 0 && (
                      <span className="hub-tab-count">{detail!.online}</span>
                    )}
                  </button>
                  <button className="hub-m-item" onClick={() => setSubtab('chat')}>
                    <ChatIcon size={19} /> 채팅
                  </button>
                  <button className="hub-m-item" onClick={() => setSubtab('files')}>
                    <FolderIcon size={19} /> 공동편집
                  </button>
                  <button className="hub-m-item" onClick={() => setSubtab('decisions')}>
                    <CheckMarkIcon size={19} /> 결정
                  </button>
                  <button className="hub-m-item" onClick={() => setSubtab('settings')}>
                    <GearIcon size={19} /> 설정
                  </button>
                </section>

                {/* 본문: 메인 + 사이드 (Teams식 2단) */}
                <div className="hub-dash-cols">
                  <div className="hub-dash-main">
                    {/* P1 — AI 회의 정리 (통화 종료 시 결정·할 일 배달) */}
                    <RecapPanel code={detail.code} isHost={detail.isHost || !!detail.canManage} />

                    {/* 최근 결정 — 원장 상위 3개를 첫 화면에 (회의→결정→전달 노출) */}
                    <section className="hub-section">
                      <div className="hub-section-title">
                        <CheckMarkIcon size={15} /> 최근 결정
                        {recentDecisions.length > 0 && (
                          <button
                            className="hub-preview-more"
                            onClick={() => setSubtab('decisions')}
                          >
                            전체 보기 <ChevronRightIcon size={12} />
                          </button>
                        )}
                      </div>
                      {recentDecisions.length === 0 ? (
                        <div className="hub-section-empty">
                          아직 기록된 결정이 없어요 — 통화가 끝나면 AI가 여기에 쌓아요
                        </div>
                      ) : (
                        <div className="hub-decision-list">
                          {recentDecisions.map((d, i) => {
                            const acked = d.acks.some((a) => a.username === user?.username);
                            return (
                              <div key={`${d.recapId}-${i}`} className="hub-decision-row">
                                <span className="hub-decision-dot" aria-hidden>
                                  <CheckMarkIcon size={12} />
                                </span>
                                <Marquee className="hub-decision-text">{d.decision}</Marquee>
                                {/* 도달·실행 상태 — "도착했음을 증명한다"를 첫 화면 숫자로 */}
                                <span
                                  className={`hub-decision-stat${d.acks.length >= detail.participants.length ? ' full' : ''}`}
                                  title={`확인 ${d.acks.length}/${detail.participants.length}명`}
                                >
                                  확인 {d.acks.length}/{detail.participants.length}
                                </span>
                                {(d.todos ?? []).length > 0 && (
                                  <span
                                    className={`hub-decision-stat${d.todos!.every((t) => t.done) ? ' full' : ''}`}
                                    title={d.todos!.map((t) => `${t.done ? '✓' : '·'} ${t.title}`).join('\n')}
                                  >
                                    실행 {d.todos!.filter((t) => t.done).length}/{d.todos!.length}
                                  </span>
                                )}
                                <span className="hub-decision-when">
                                  {new Date(d.ts).toLocaleDateString('ko-KR', {
                                    month: 'numeric',
                                    day: 'numeric',
                                  })}
                                </span>
                                {/* 수신 확인 (회람 사인) */}
                                {acked ? (
                                  <span className="hub-decision-ack done">확인함 <CheckMarkIcon size={11} /></span>
                                ) : (
                                  <button
                                    className="hub-decision-ack"
                                    title="확인했음을 남기기 (회람 사인)"
                                    onClick={() => void ackDecisionRow(d)}
                                  >
                                    확인
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* 미확인 팔로업 — 전달의 마지막 1미터. 관리자에게만, AI 총무가 대신 조름 */}
                      {(detail.isHost || detail.canManage) && unackedFollowup && (
                        <div className="hub-followup">
                          <span className="hub-followup-text">
                            '{unackedFollowup.d.decision.slice(0, 24)}
                            {unackedFollowup.d.decision.length > 24 ? '…' : ''}' 아직{' '}
                            <b>{unackedFollowup.missing}명 미확인</b>
                          </span>
                          {remindSent ? (
                            <span className="hub-followup-done">리마인드 보냄 <CheckMarkIcon size={12} /></span>
                          ) : (
                            <button
                              className="hub-followup-btn"
                              title="미확인자에게 AI 총무가 확인을 요청해요"
                              onClick={() => void remindDecision(unackedFollowup.d)}
                            >
                              리마인드
                            </button>
                          )}
                        </div>
                      )}
                    </section>

                    {/* 다음 회의 아젠다 — 회의 직전에만 가치 있는 정보라 기본 접힘 */}
                    <section className="hub-section">
                      <div
                        className="hub-section-title clickable"
                        onClick={() => setAgendaOpen((v) => !v)}
                      >
                        <ListIcon size={15} /> 다음 회의 아젠다
                        <span className="hub-agenda-badge">AI 제안</span>
                        <span className="hub-fold-meta">
                          {agenda === null ? '정리 중…' : `안건 ${agenda.length}건`}
                        </span>
                        <span className={`hub-fold-chev${agendaOpen ? ' open' : ''}`} aria-hidden>
                          <ChevronIcon size={14} />
                        </span>
                      </div>
                      {agendaOpen &&
                        (agenda === null ? (
                          <div className="hub-section-empty">기록을 보고 안건을 정리하는 중…</div>
                        ) : agenda.length === 0 ? (
                          <div className="hub-section-empty">
                            아직 제안할 안건이 없어요 — 통화·할 일이 쌓이면 여기에 초안이 떠요
                          </div>
                        ) : (
                          <div className="hub-agenda-list">
                            {agenda.map((a, i) => (
                              <div key={i} className="hub-agenda-row">
                                <span className="hub-agenda-num">{i + 1}</span>
                                <div className="hub-agenda-body">
                                  <Marquee className="hub-agenda-title">{a.title}</Marquee>
                                  {a.why && <span className="hub-agenda-why">{a.why}</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                        ))}
                    </section>

                {/* 일정 (메인으로 이동) */}
                <section className="hub-section">
                  <div className="hub-section-title">
                    <CalendarIcon size={15} /> 일정
                  </div>
                  {range ? (
                    <>
                      <div className="hub-sched-time">{range}</div>
                      {(() => {
                        const st = scheduleState(detail.starts_at, detail.ends_at);
                        return st ? (
                          <span className={`hub-sched-badge ${st.cls}`}>{st.label}</span>
                        ) : null;
                      })()}
                    </>
                  ) : (
                    <div className="hub-section-empty">아직 일정이 정해지지 않았어요</div>
                  )}
                </section>

                  </div>

                  <aside className="hub-dash-side">
                    {/* 최근 채팅 카드 제거 — 채팅 탭이 1클릭인데 자리만 먹음 (7/28 주호·효헌 합의) */}
                    {/* 할 일 (사이드로 이동) */}
                    <section className="hub-section">
                      <div className="hub-section-title">
                        <ListIcon size={15} /> 할 일
                        {todos.length > 0 && (
                          <span className="hub-todo-count">
                            {todos.filter((t) => t.done).length}/{todos.length}
                          </span>
                        )}
                      </div>
                      {todos.length > 0 &&
                        (() => {
                          const done = todos.filter((t) => t.done).length;
                          const pct = Math.round((done / todos.length) * 100);
                          return (
                            <div className="hub-todo-progress">
                              <div className="hub-todo-bar">
                                <div className="hub-todo-bar-fill" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="hub-todo-pct">{pct}%</span>
                            </div>
                          );
                        })()}
                      <div className="hub-todos">
                        {[...todos]
                          .sort((a, b) => a.done - b.done)
                          .map((t) => (
                            <div key={t.id} className={`hub-todo${t.done ? ' done' : ''}`}>
                              <label className="hub-todo-label">
                                <input
                                  type="checkbox"
                                  checked={!!t.done}
                                  onChange={() => void toggleTodo(t)}
                                />
                                <span className="hub-todo-check" aria-hidden>
                                  <CheckMarkIcon size={16} />
                                </span>
                                {editTodoId === t.id ? (
                                  <form className="hub-todo-rename" onSubmit={renameTodo}>
                                    <input
                                      autoFocus
                                      value={editTodoTitle}
                                      onChange={(e) => setEditTodoTitle(e.target.value)}
                                      onClick={(e) => e.preventDefault()}
                                      onBlur={() => setEditTodoId(null)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Escape') setEditTodoId(null);
                                      }}
                                      maxLength={200}
                                    />
                                  </form>
                                ) : (
                                  <Marquee className="hub-todo-text">{t.title}</Marquee>
                                )}
                              </label>
                              {editTodoId !== t.id && (
                                <span
                                  className="hub-todo-editbtn"
                                  title="내용 수정"
                                  onClick={() => {
                                    setEditTodoId(t.id);
                                    setEditTodoTitle(t.title);
                                  }}
                                >
                                  <PenIcon size={11} />
                                </span>
                              )}
                              {dueEditId === t.id ? (
                                <input
                                  type="date"
                                  className="hub-todo-due-input"
                                  autoFocus
                                  defaultValue={t.due_at?.slice(0, 10) ?? ''}
                                  onChange={(e) => void saveDue(t, e.target.value)}
                                  onBlur={() => setDueEditId(null)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') setDueEditId(null);
                                  }}
                                />
                              ) : t.due_at && dueBadge(t.due_at) ? (
                                <button
                                  type="button"
                                  className={`hub-todo-due ${dueBadge(t.due_at)!.cls}`}
                                  title="마감일 변경 (지우려면 선택 후 비우기)"
                                  onClick={() => setDueEditId(t.id)}
                                >
                                  {dueBadge(t.due_at)!.label}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="hub-todo-due ghost"
                                  title="마감일 지정"
                                  onClick={() => setDueEditId(t.id)}
                                >
                                  기한
                                </button>
                              )}
                              <button
                                type="button"
                                className={`hub-todo-assign${(t.assignees ?? []).length ? ' has faces' : ''}`}
                                onClick={() => setAssignPick(assignPick === t.id ? null : t.id)}
                                title={(t.assignees ?? []).length ? undefined : '담당자 지정'}
                              >
                                {(t.assignees ?? []).length ? (
                                  <span className="hub-assign-faces">
                                    {t.assignees!.slice(0, 3).map((u) => (
                                      <Avatar
                                        key={u}
                                        value={
                                          detail.participants.find((p) => p.username === u)
                                            ?.avatar ?? null
                                        }
                                        className="hub-assign-face"
                                      />
                                    ))}
                                    {t.assignees!.length > 3 && (
                                      <span className="hub-assign-more">
                                        +{t.assignees!.length - 3}
                                      </span>
                                    )}
                                  </span>
                                ) : (
                                  '담당'
                                )}
                              </button>
                              {(t.assignees ?? []).length > 0 && (
                                <div className="hub-assign-tip" aria-hidden>
                                  {t.assignees!.map((name) => {
                                    const p = detail.participants.find(
                                      (x) => x.username === name,
                                    );
                                    return (
                                      <div key={name} className="hub-assign-tip-row">
                                        <Avatar
                                          value={p?.avatar ?? null}
                                          className="hub-assign-avatar"
                                        />
                                        <span>{dn(name)}</span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {assignPick === t.id && (
                                <div className="hub-assign-pop">
                                  {detail.participants.map((p) => (
                                    <label key={p.username} className="hub-assign-opt">
                                      <input
                                        type="checkbox"
                                        checked={(t.assignees ?? []).includes(p.username)}
                                        onChange={() => void toggleAssignee(t, p.username)}
                                      />
                                      <span className="hub-todo-check" aria-hidden>
                                        <CheckMarkIcon size={13} />
                                      </span>
                                      <Avatar value={p.avatar} className="hub-assign-avatar" />
                                      <span className="hub-assign-name">{dn(p.username)}</span>
                                    </label>
                                  ))}
                                </div>
                              )}
                              <button
                                className="hub-todo-del"
                                onClick={() => void deleteTodo(t)}
                                title="삭제"
                              >
                                <CloseIcon size={12} />
                              </button>
                            </div>
                          ))}
                        {todos.length === 0 && (
                          <div className="hub-section-empty">함께 할 일을 추가해보세요</div>
                        )}
                      </div>
                      <form className="hub-todo-add" onSubmit={addTodo}>
                        <input
                          value={todoInput}
                          onChange={(e) => setTodoInput(e.target.value)}
                          placeholder="할 일 추가"
                        />
                        {newDueOpen ? (
                          <input
                            type="date"
                            className="hub-todo-due-input"
                            autoFocus
                            value={newDue}
                            onChange={(e) => setNewDue(e.target.value)}
                          />
                        ) : (
                          <button
                            type="button"
                            className={`hub-todo-due ghost icon${newDue ? ' set' : ''}`}
                            title={newDue ? `마감 ${newDue}` : '마감일 지정'}
                            onClick={() => setNewDueOpen(true)}
                          >
                            <CalendarIcon size={14} />
                            {newDue ? dueBadge(newDue)?.label : null}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`hub-todo-assign${newAssign.length ? ' has' : ''}`}
                          onClick={() => setAssignPick(assignPick === 'new' ? null : 'new')}
                          title="담당자 지정 (없으면 나)"
                        >
                          담당{newAssign.length ? ` ${newAssign.length}` : ''}
                        </button>
                        {assignPick === 'new' && (
                          <div className="hub-assign-pop up">
                            {detail.participants.map((p) => (
                              <label key={p.username} className="hub-assign-opt">
                                <input
                                  type="checkbox"
                                  checked={newAssign.includes(p.username)}
                                  onChange={() =>
                                    setNewAssign((cur) =>
                                      cur.includes(p.username)
                                        ? cur.filter((n) => n !== p.username)
                                        : [...cur, p.username],
                                    )
                                  }
                                />
                                <span className="hub-todo-check" aria-hidden>
                                  <CheckMarkIcon size={13} />
                                </span>
                                <Avatar value={p.avatar} className="hub-assign-avatar" />
                                <span className="hub-assign-name">{dn(p.username)}</span>
                              </label>
                            ))}
                          </div>
                        )}
                        <button type="submit">추가</button>
                      </form>
                    </section>

                    {/* 참가자 — 기본은 아바타 스택만(조직 그룹은 조직도와 중복), 펼치면 부서별 명함 */}
                    <section className="hub-section">
                      <div
                        className="hub-section-title clickable"
                        onClick={() => setRosterOpen((v) => !v)}
                      >
                        <UsersIcon size={15} /> 참가자 <b>{detail.participants.length}</b>
                        {detail.orgName && <span className="hub-roster-org">· {detail.orgName}</span>}
                        {!rosterOpen && (
                          <span className="hub-roster-stack">
                            {detail.participants.slice(0, 5).map((p) => (
                              <Avatar
                                key={p.username}
                                value={p.avatar}
                                className="hub-roster-face"
                              />
                            ))}
                            {detail.participants.length > 5 && (
                              <span className="hub-assign-more">
                                +{detail.participants.length - 5}
                              </span>
                            )}
                          </span>
                        )}
                        <span className={`hub-fold-chev${rosterOpen ? ' open' : ''}`} aria-hidden>
                          <ChevronIcon size={14} />
                        </span>
                      </div>
                      {rosterOpen && (
                      <div className="hub-roster">
                        {groupByDept(detail.participants).map((group) => (
                          <div key={group.dept ?? '__none'} className="hub-dept">
                            {group.dept && <div className="hub-dept-name">{group.dept}</div>}
                            <div className="hub-cards">
                              {group.people.map((p) => (
                                <div
                                  key={p.username}
                                  className={`hub-pcard${presence.has(p.username) ? ' online' : ''}`}
                                >
                                  <Avatar value={p.avatar} className="hub-pcard-avatar" />
                                  <span className="hub-pcard-info">
                                    <span className="hub-pcard-name">
                                      {dn(p.username)}
                                      {p.role === 'owner' && (
                                        <span className="hub-pcard-badge">소유자</span>
                                      )}
                                      {p.role === 'admin' && (
                                        <span className="hub-pcard-badge admin">관리자</span>
                                      )}
                                    </span>
                                    <Marquee className="hub-pcard-sub">
                                      {p.position && <b className="hub-pcard-pos">{p.position}</b>}
                                      {p.position && (p.department || detail.orgName) && ' · '}
                                      {p.department || (detail.orgName ? '부서 미지정' : '')}
                                      {p.username === detail.host && (
                                        <span className="hub-pcard-host"> · 호스트</span>
                                      )}
                                    </Marquee>
                                  </span>
                                  {p.username !== user?.username && (
                                    <button
                                      type="button"
                                      className="hub-pcard-dm"
                                      title={`${dn(p.username)}님에게 메시지`}
                                      onClick={() => openDm(p)}
                                    >
                                      <ChatIcon size={14} />
                                    </button>
                                  )}
                                  <i
                                    className="presence-dot"
                                    title={presence.has(p.username) ? '접속 중' : '오프라인'}
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                      )}
                    </section>
                  </aside>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── 서브 화면 오버레이 — 데스크톱은 display:contents(무영향), 모바일은 대시보드 위 레이어 ── */}
        <div
          className={`hub-m-screen${subtab !== 'dash' ? ' open' : ''}${swipeDx != null ? ' m-swiping' : ''}`}
          style={swipeDx != null ? { transform: `translateX(${swipeDx}px)` } : undefined}
        >
        {/* 모바일 — 서브 화면 상단 뒤로가기 바 */}
        {subtab !== 'dash' && (
          <div className="hub-m-back">
            <button onClick={() => setSubtab('dash')} aria-label="대시보드로">
              <ChevronIcon size={20} />
            </button>
            <span>
              {
                {
                  schedule: '일정',
                  call: '통화',
                  chat: '채팅',
                  files: '공동편집',
                  decisions: '결정',
                  settings: '설정',
                }[subtab]
              }
            </span>
          </div>
        )}

        {/* 일정 서브탭 — 달력으로 회의 일정 관리 */}
        {subtab === 'schedule' && detail && (
          <div className="hub-schedule">
            <MeetingSchedule
              code={code}
              isHost={detail.isHost || !!detail.canManage}
              startsAt={detail.starts_at}
              endsAt={detail.ends_at}
              recur={detail.recur ?? 'none'}
              recurUntil={detail.recur_until ?? null}
              recurExcept={detail.recur_except ?? []}
              onOccurrenceChanged={() => void reloadDetail()}
              participants={detail.participants
                .filter((p) => p.username !== 'exist AI')
                .map((p) => ({ userId: p.userId, username: p.username }))}
            />
          </div>
        )}

        {/* 설정 — 참가자 관리 + 권한 */}
        {subtab === 'settings' && detail && (
          <div className="hub-settings">
            <section className="hub-set-card">
              <div className="hub-section-title">
                <UsersIcon size={15} /> 참가자 <b>{detail.participants.length}</b>
              </div>
              <div className="hub-set-people">
                {detail.participants.map((p) => (
                  <div key={p.username} className="hub-set-person">
                    <Avatar value={p.avatar} className="hub-set-avatar" />
                    <span className="hub-set-info">
                      <span className="hub-set-name">
                        {dn(p.username)}
                        {p.isHost && <span className="hub-set-badge host">호스트</span>}
                        {p.role === 'owner' && <span className="hub-set-badge">소유자</span>}
                        {p.role === 'admin' && <span className="hub-set-badge admin">관리자</span>}
                        {presence.has(p.username) && <i className="hub-set-online" title="접속 중" />}
                      </span>
                      <span className="hub-set-sub">
                        {p.position && <b>{p.position}</b>}
                        {p.position && p.department && ' · '}
                        {p.department}
                      </span>
                    </span>
                    {(detail.isHost || detail.canManage) && !p.isHost && (
                      <span className="hub-set-actions">
                        <button className="hub-set-btn" onClick={() => void transferHost(p.username)}>
                          호스트 위임
                        </button>
                        <button className="hub-set-btn danger" onClick={() => void kickParticipant(p.username)}>
                          내보내기
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {/* 초대 — 참가자를 늘리는 행동이라 참가자 카드에 함께 */}
              <div className="hub-invite-row">
                <button className="hub-set-btn" onClick={() => void copyInviteLink()}>
                  {linkCopied ? <CheckMarkIcon size={13} /> : <ShareIcon size={13} />}{' '}
                  {linkCopied ? '복사됨' : '초대 링크 복사'}
                </button>
                <button className="hub-set-btn" onClick={() => void copyCode()}>
                  {copied ? <CheckMarkIcon size={13} /> : <CopyIcon size={13} />} 코드 {detail.code}
                </button>
                <span className="hub-invite-hint">
                  링크를 받은 사람은 로그인만 하면 자동으로 이 그룹에 참여돼요
                </span>
              </div>
            </section>

            <section className="hub-set-card">
              <div className="hub-section-title">
                <CalendarIcon size={15} /> 프로젝트 기간
                <span className="hub-set-hostonly">그룹 시작·종료에서 자동</span>
              </div>
              {(() => {
                // 프로젝트 기간 = 회의 시작일 ~ 종료일(반복이면 반복 끝나는 날)
                const pStart = detail.starts_at ? detail.starts_at.slice(0, 10) : null;
                const pEnd =
                  detail.recur && detail.recur !== 'none'
                    ? detail.recur_until ?? null
                    : detail.ends_at
                      ? detail.ends_at.slice(0, 10)
                      : null;
                const fmt = (d: string) => d.replace(/-/g, '. ');
                if (!pStart && !pEnd) {
                  return (
                    <div className="hub-section-empty">
                      그룹을 만들 때 시작·종료를 정하면 여기 기간이 표시돼요
                    </div>
                  );
                }
                return (
                  <div className="hub-period-view">
                    {pStart ? fmt(pStart) : '?'} ~ {pEnd ? fmt(pEnd) : '계속 반복'}
                    {pEnd &&
                      (() => {
                        const d = dday(pEnd);
                        return d != null ? (
                          <span className={`hub-dday${d < 0 ? ' over' : ''}`}>
                            {d > 0 ? `D-${d}` : d === 0 ? 'D-DAY' : `D+${-d}`}
                          </span>
                        ) : null;
                      })()}
                  </div>
                );
              })()}
            </section>

            <section className="hub-set-card">
              <div className="hub-section-title">
                <GearIcon size={15} /> 권한
                {!detail.isHost && !detail.canManage && (
                  <span className="hub-set-hostonly">호스트·조직 관리자만 변경 가능</span>
                )}
              </div>
              {(() => {
                const s = detail.settings ?? { locked: false, guestEdit: true, muteOnJoin: false };
                const Toggle = ({
                  on,
                  label,
                  desc,
                  onToggle,
                }: {
                  on: boolean;
                  label: string;
                  desc: string;
                  onToggle: () => void;
                }) => (
                  <div className="hub-perm">
                    <span className="hub-perm-text">
                      <span className="hub-perm-label">{label}</span>
                      <span className="hub-perm-desc">{desc}</span>
                    </span>
                    <button
                      className={`hub-switch${on ? ' on' : ''}`}
                      disabled={!detail.isHost && !detail.canManage}
                      onClick={onToggle}
                      aria-label={label}
                    >
                      <i />
                    </button>
                  </div>
                );
                return (
                  <>
                    <Toggle
                      on={s.locked}
                      label="입장 잠금"
                      desc="새로운 사람의 그룹 참여를 막아요"
                      onToggle={() => void updateSettings({ locked: !s.locked })}
                    />
                    <Toggle
                      on={s.guestEdit}
                      label="참가자 편집 허용"
                      desc="참가자도 문서·시트·캔버스를 편집할 수 있어요"
                      onToggle={() => void updateSettings({ guestEdit: !s.guestEdit })}
                    />
                    <Toggle
                      on={s.muteOnJoin}
                      label="입장 시 음소거"
                      desc="통화 입장할 때 마이크를 끈 상태로 시작해요"
                      onToggle={() => void updateSettings({ muteOnJoin: !s.muteOnJoin })}
                    />
                  </>
                );
              })()}
            </section>

            <section className="hub-set-card">
              <div className="hub-section-title">
                <PinIcon size={15} /> 내 사이드바
              </div>
              <div className="hub-perm">
                <span className="hub-perm-text">
                  <span className="hub-perm-label">맨 위 고정</span>
                  <span className="hub-perm-desc">최근 그룹 목록 맨 위에 고정해요 (나에게만 적용)</span>
                </span>
                <PinToggle meetingId={detail.id} />
              </div>
            </section>

            {(detail.isHost || detail.canManage) && (
              <section className="hub-set-card danger-zone">
                <div className="hub-section-title">
                  <GearIcon size={15} /> 그룹 삭제
                </div>
                <p className="hub-danger-desc">
                  회의와 모든 채팅·일정 기록이 영구적으로 사라져요. 되돌릴 수 없어요.
                </p>
                <button
                  className={`hub-danger-btn${confirmDelMeeting ? ' confirm' : ''}`}
                  onClick={() => void deleteMeeting()}
                  onMouseLeave={() => setConfirmDelMeeting(false)}
                >
                  {confirmDelMeeting ? '정말 삭제할까요? 한 번 더 클릭' : '이 회의 삭제하기'}
                </button>
              </section>
            )}
          </div>
        )}

        {/* 통화 — 입장하면 서브탭 옮겨도 마운트 유지. 다른 서브탭에선 우하단 미니 PiP */}
        {(inCall || subtab === 'call') && (
          <div
            className={`hub-call${subtab === 'call' ? '' : ' mini'}`}
            style={
              subtab !== 'call'
                ? ({
                    width: pipW,
                    height: pipH,
                    '--pip-cols': Math.max(1, Math.round(pipW / PIP_TILE_W)),
                    ...(pipPos ? { left: pipPos.x, top: pipPos.y, right: 'auto', bottom: 'auto' } : {}),
                  } as React.CSSProperties)
                : undefined
            }
            onPointerDown={subtab !== 'call' ? startPipDrag : undefined}
          >
            {subtab !== 'call' && (
              <div
                className="hub-pip-resize"
                onPointerDown={startPipResize}
                title="모서리를 끌어 크기 조절"
              />
            )}
            {subtab !== 'call' && (
              <div className="hub-pip-bar">
                <span className="hub-pip-grip" title="드래그해서 옮기기">
                  ⠿ 통화 · 드래그하여 이동
                </span>
                <button
                  className="hub-pip-expand"
                  onClick={() => setSubtab('call')}
                  title="통화 화면 크게 보기"
                >
                  ⤢
                </button>
              </div>
            )}
            <MeetingView
              code={code}
              embedded
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onJoined={() => setInCall(true)}
              onlinePeers={detail?.callPeers ?? []}
              peerAvatars={Object.fromEntries(
                (detail?.participants ?? []).map((p) => [p.username, p.avatar]),
              )}
              mentionCandidates={mentionCandidates}
              onLeave={(message) => {
                setInCall(false);
                setSubtab('dash');
                if (expanded) onToggleExpand?.();
                if (message)
                  window.dispatchEvent(new CustomEvent('app:error', { detail: message }));
              }}
            />
          </div>
        )}

        {/* 결정 원장 — 그룹의 모든 통화 결정 타임라인 */}
        {subtab === 'decisions' && <DecisionLedger code={code} />}

        {/* 공동편집 — 파일시스템 (코드/문서/시트/발표/캔버스 파일 여러 개, 한 번 열면 마운트 유지) */}
        {filesMounted && (
          <div
            className="hub-editor-pane"
            style={{ display: subtab === 'files' ? 'block' : 'none' }}
          >
            <CollabFiles
              code={code}
              isHost={!!(detail?.isHost || detail?.canManage)}
              visible={visible && subtab === 'files'}
            />
          </div>
        )}

        {/* 채팅 */}
        {subtab === 'chat' && (
          <div className="hub-chat">
            {/* 채널 사이드바 — 그룹 안 채널 전환/생성 */}
            <aside className="hub-channels-side">
              <div className="hub-channels-head">
                <span>채널</span>
                <button
                  className="hub-channels-add"
                  title="채널 추가"
                  onClick={() => setNewChannelOpen(true)}
                >
                  ＋
                </button>
              </div>
              <div className="hub-channels-list">
                {channels.map((ch) =>
                  editChannelId === ch.id ? (
                    <form key={ch.id} className="hub-channel-new" onSubmit={renameChannel}>
                      <input
                        autoFocus
                        value={editChannelName}
                        onChange={(e) => setEditChannelName(e.target.value)}
                        onBlur={() => setEditChannelId(null)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditChannelId(null);
                        }}
                        maxLength={24}
                      />
                    </form>
                  ) : (
                    <button
                      key={ch.id}
                      className={`hub-channel-item${ch.id === activeChannel ? ' active' : ''}`}
                      onClick={() => setActiveChannel(ch.id)}
                    >
                      <span className="hub-channel-hash">#</span>
                      <Marquee className="hub-channel-name">{ch.name}</Marquee>
                      {(channelUnread[ch.id] ?? 0) > 0 && <i className="hub-channel-dot" />}
                      {(detail?.isHost || detail?.canManage || ch.createdBy === user?.id) && (
                        <span
                          className="hub-channel-edit"
                          title="채널 이름 수정"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditChannelId(ch.id);
                            setEditChannelName(ch.name);
                          }}
                        >
                          <PenIcon size={11} />
                        </span>
                      )}
                      {(detail?.isHost || detail?.canManage) && !ch.isDefault && ch.kind !== 'call' && (
                        <span
                          className="hub-channel-del"
                          title="채널 삭제"
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteChannel(ch);
                          }}
                        >
                          <CloseIcon size={12} />
                        </span>
                      )}
                      <span
                        className={`hub-channel-notify mode-${ch.notifyMode ?? 'mention'}`}
                        title={`${NOTIFY_LABEL[ch.notifyMode ?? 'mention']} — 클릭해서 변경`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void cycleNotify(ch);
                        }}
                      >
                        <NotifyModeIcon mode={ch.notifyMode ?? 'mention'} />
                      </span>
                    </button>
                  ),
                )}
                {newChannelOpen && (
                  <form className="hub-channel-new" onSubmit={createChannel}>
                    <input
                      autoFocus
                      value={newChannelName}
                      onChange={(e) => setNewChannelName(e.target.value)}
                      onBlur={() => {
                        if (!newChannelName.trim()) setNewChannelOpen(false);
                      }}
                      placeholder="채널 이름"
                      maxLength={24}
                    />
                  </form>
                )}
              </div>
            </aside>

            <div className="hub-chat-main">
            <div className="hub-chat-chhead">
              <span className="hub-channel-hash">#</span>
              {channels.find((c) => c.id === activeChannel)?.name ?? '일반'}
              {(() => {
                const ch = channels.find((c) => c.id === activeChannel);
                if (!ch) return null;
                const mode = ch.notifyMode ?? 'mention';
                return (
                  <button
                    type="button"
                    className={`hub-chhead-notify mode-${mode}`}
                    title={`${NOTIFY_LABEL[mode]} — 클릭해서 변경`}
                    onClick={() => void cycleNotify(ch)}
                  >
                    <NotifyModeIcon mode={mode} size={16} />
                  </button>
                );
              })()}
            </div>
            <div className="hub-chat-messages">
              {messages.length === 0 && (
                <div className="chat-empty">
                  <ChatIcon size={40} />
                  <p>아직 대화가 없어요</p>
                  <span>첫 메시지를 남겨보세요</span>
                </div>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const mine = m.from === user?.username;
                const showDate = !prev || !sameDay(prev.ts, m.ts);
                const grouped =
                  !!prev && prev.from === m.from && !showDate && m.ts - prev.ts < 5 * 60_000;
                return (
                  <Fragment key={i}>
                    {showDate && (
                      <div className="chat-date">
                        <span>{chatDateLabel(m.ts)}</span>
                      </div>
                    )}
                    <div className={`chat-row${mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`}>
                      {!mine &&
                        (grouped ? (
                          <span className="chat-avatar-gap" />
                        ) : (
                          <span
                            className="chat-user-hover"
                            onMouseEnter={(e) => showProfileCard(m.from, e.currentTarget)}
                            onMouseLeave={hideProfileCardSoon}
                          >
                            <Avatar value={m.avatar} className="chat-avatar" />
                          </span>
                        ))}
                      <div className="chat-content">
                        {!mine && !grouped && (
                          <span
                            className="chat-name chat-user-hover"
                            onMouseEnter={(e) => showProfileCard(m.from, e.currentTarget)}
                            onMouseLeave={hideProfileCardSoon}
                          >
                            {dn(m.from)}
                          </span>
                        )}
                        <div className="chat-line">
                          {mine && <span className="chat-time">{chatTime(m.ts)}</span>}
                          <div className={`chat-bubble${m.file ? ' has-file' : ''}`}>
                            {m.file ? (
                              <a
                                className="chat-file"
                                href={m.file.url}
                                target="_blank"
                                rel="noreferrer"
                                download={m.file.name}
                              >
                                {/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(m.file.name) ? (
                                  <img className="chat-file-img" src={m.file.url} alt={m.file.name} />
                                ) : (
                                  <span className="chat-file-card">
                                    <span className="chat-file-ic">📎</span>
                                    <span className="chat-file-meta">
                                      <span className="chat-file-name">{m.file.name}</span>
                                      <span className="chat-file-size">{formatBytes(m.file.size)}</span>
                                    </span>
                                    <span className="chat-file-dl">⬇</span>
                                  </span>
                                )}
                                {m.text && <span className="chat-file-text">{m.text}</span>}
                              </a>
                            ) : (
                              m.text
                            )}
                            {/* AI 결정 후보 제안 — 사람이 버튼으로 원장 기록 확정 */}
                            {m.from === 'exist AI' && m.text.startsWith('💡 결정 후보:') && (
                              <button
                                className="chat-decision-btn"
                                onClick={() => void recordSuggestedDecision(m.text)}
                              >
                                <CheckMarkIcon size={12} /> 원장에 기록
                              </button>
                            )}
                          </div>
                          {!mine && <span className="chat-time">{chatTime(m.ts)}</span>}
                        </div>
                      </div>
                    </div>
                  </Fragment>
                );
              })}
              <div ref={chatEndRef} />
            </div>
            <form className="hub-chat-input" onSubmit={sendChat}>
              <input
                ref={chatFileRef}
                type="file"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void sendChatFile(f);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                className="hub-chat-attach"
                title="파일 첨부"
                disabled={uploadingFile}
                onClick={() => chatFileRef.current?.click()}
              >
                {uploadingFile ? '…' : '📎'}
              </button>
              <MentionInput
                value={chatInput}
                onChange={setChatInput}
                candidates={mentionCandidates}
                placeholder={`#${channels.find((c) => c.id === activeChannel)?.name ?? '일반'}에 메시지 입력`}
              />
              <button type="submit">전송</button>
            </form>
            </div>
          </div>
        )}
        </div>
      </div>

      {/* 채팅 프로필 hover 카드 — 정보(조직도) / 채팅(DM) */}
      {pcard && (
        <div
          className="profile-card"
          style={{ left: pcard.x, top: pcard.y }}
          onMouseEnter={keepProfileCard}
          onMouseLeave={hideProfileCardSoon}
        >
          <div className="profile-card-head">
            <Avatar value={pcard.p.avatar} className="profile-card-avatar" />
            <div className="profile-card-meta">
              <b>
                {dn(pcard.p.username)}
                {pcard.p.isHost && <span className="profile-card-host">호스트</span>}
              </b>
              <span>
                {[pcard.p.position, pcard.p.department].filter(Boolean).join(' · ') ||
                  (detail?.orgName ? '부서 미지정' : '')}
              </span>
            </div>
            <i
              className={`presence-dot${presence.has(pcard.p.username) ? ' on' : ''}`}
              title={presence.has(pcard.p.username) ? '접속 중' : '오프라인'}
            />
          </div>
          <div className="profile-card-actions">
            {detail?.orgId != null && (
              <button type="button" onClick={() => navigate(`/org/${detail.orgId}`)}>
                <UsersIcon size={14} /> 정보
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                const p = pcard.p;
                setPcard(null);
                openDm(p);
              }}
            >
              <ChatIcon size={14} /> 채팅
            </button>
          </div>
        </div>
      )}

      {/* 참가자 명함에서 연 1:1 DM — 우하단 플로팅 (홈과 같은 창) */}
      {dm && (
        <DmWindow
          scope={dm.scope}
          peer={dm.peer}
          onClose={() => setDm(null)}
          onActivity={() => {}}
        />
      )}
    </div>
  );
}

/** 맨 위 고정 토글 — 스위치만 리렌더되게 허브에서 분리 (허브 전체 리렌더는 수십 ms) */
function PinToggle({ meetingId }: { meetingId: number }) {
  const [on, setOn] = useState(() => isPinned(meetingId));
  useEffect(() => {
    const sync = () => setOn(isPinned(meetingId));
    sync();
    window.addEventListener(PINS_EVENT, sync);
    return () => window.removeEventListener(PINS_EVENT, sync);
  }, [meetingId]);
  return (
    <button
      className={`hub-switch${on ? ' on' : ''}`}
      onClick={() => togglePin(meetingId)}
      aria-label="맨 위 고정"
    >
      <i />
    </button>
  );
}

// 워크스페이스 탭들이 숨겨진 채 전부 마운트돼 있어서, 부모(대시보드) 리렌더마다
// 허브 전체가 다시 그려지면 토글류 반응이 눈에 띄게 늦는다 — props 안 바뀌면 스킵
export default memo(MeetingHub);
