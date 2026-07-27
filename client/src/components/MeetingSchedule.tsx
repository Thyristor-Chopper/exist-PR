import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { useAuthStore } from '../store';
import { useDisplayName } from '../names';
import { PhoneIcon, BellIcon } from './Icons';
import Marquee from './Marquee';

interface MEvent {
  id: number;
  title: string;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM (시작)
  end_time: string | null; // HH:MM (종료)
  is_call?: number; // 1이면 통화 일정 (10분 전 "통화 들어오세요" 알림)
  memo: string | null; // 일정 메모 (애플 캘린더식)
  remind: number | null; // 알림 시점(분 전) — null=기본(30·10분), 0=없음
  recur: string | null; // 반복 — daily/weekly/biweekly/monthly (null=없음)
  recur_until: string | null; // 반복 종료일
  color: string | null; // 일정 색 (#rrggbb, null=기본)
  end_date: string | null; // 여러 날 걸친 일정의 종료일 (null=하루)
  /** 반복 확장 occurrence면 원본 날짜 (수정 폼은 이 날짜 기준) */
  baseDate?: string;
  /** 여러 날 일정의 하루 조각 — start(첫날)/mid(중간)/end(마지막) */
  seg?: 'start' | 'mid' | 'end';
  people: { id: number; username: string; name: string | null }[]; // 관련자
  author: string;
  created_by: number;
}

interface Props {
  code: string;
  isHost: boolean;
  startsAt: string | null;
  endsAt: string | null;
  /** 반복 주기 — 'none'|'daily'|'weekly'|'biweekly'|'monthly' */
  recur?: string;
  /** 반복 종료일 (YYYY-MM-DD). 없으면 1년까지만 표시 */
  recurUntil?: string | null;
  /** 삭제된 특정 회차 날짜들 (YYYY-MM-DD) */
  recurExcept?: string[];
  /** 회차 삭제/복원 후 부모가 detail 다시 불러오게 */
  onOccurrenceChanged?: () => void;
  /** 회의 참가자 — 일정 관련자 선택 칩에 사용 */
  participants?: { userId: number; username: string }[];
}

function stepDate(d: Date, recur: string): Date {
  const n = new Date(d);
  if (recur === 'daily') n.setDate(n.getDate() + 1);
  else if (recur === 'weekly') n.setDate(n.getDate() + 7);
  else if (recur === 'biweekly') n.setDate(n.getDate() + 14);
  else if (recur === 'monthly') n.setMonth(n.getMonth() + 1);
  return n;
}

const pad = (n: number) => String(n).padStart(2, '0');
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const addDays = (ds: string, n: number): string => {
  const d = new Date(ds + 'T00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
};

const daysBetween = (a: string, b: string): number =>
  Math.round((new Date(b + 'T00:00').getTime() - new Date(a + 'T00:00').getTime()) / 86_400_000);
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/** "7월 23일 (수)" — 팝오버 날짜 표기 */
function dateLabelOf(ds: string): string {
  const d = new Date(ds + 'T00:00');
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
}

/** 알림 시점 선택지 — 애플식. ''=기본(30·10분 전) */
const REMIND_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '기본 (30분·10분 전)' },
  { value: '0', label: '없음' },
  { value: '5', label: '5분 전' },
  { value: '10', label: '10분 전' },
  { value: '30', label: '30분 전' },
  { value: '60', label: '1시간 전' },
  { value: '120', label: '2시간 전' },
  { value: '1440', label: '하루 전' },
];

const remindLabel = (r: number | null): string =>
  REMIND_OPTIONS.find((o) => o.value === (r == null ? '' : String(r)))?.label ?? '기본';

const EV_RECUR_LABEL: Record<string, string> = {
  daily: '매일',
  weekly: '매주',
  biweekly: '격주',
  monthly: '매월',
};

/** 일정 색 팔레트 (애플 캘린더 색 느낌) — ''=기본(초록/통화 파랑) */
const COLOR_CHOICES: { value: string; label: string }[] = [
  { value: '', label: '기본' },
  { value: '#e5484d', label: '빨강' },
  { value: '#f7801a', label: '주황' },
  { value: '#d9a900', label: '노랑' },
  { value: '#4f8df7', label: '파랑' },
  { value: '#8e4ef7', label: '보라' },
  { value: '#e93d82', label: '핑크' },
];

/** 블록·행에 일정 색을 CSS 변수로 주입 (없으면 CSS 기본값 사용) */
const evColorStyle = (c: string | null | undefined) =>
  c ? ({ '--evc': c } as CSSProperties) : undefined;

type ViewMode = 'day' | 'week' | 'month';
const VIEW_LABEL: Record<ViewMode, string> = { day: '일', week: '주', month: '월' };

/** 주 뷰 한 시간 행 높이(px) — CSS .msched-week-cell 높이와 일치해야 함 */
const WEEK_ROWH = 40;

/** 시간 눈금 라벨 — 0→오전 12시, 13→오후 1시, 24→오전 12시 */
function hourLabel(h: number): string {
  const ampm = h % 24 < 12 ? '오전' : '오후';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${ampm} ${hh}시`;
}

/** 분 단위 시작·종료 → 주 뷰 블록 top/height (종료 없으면 1시간) */
function blockPos(startMin: number, endMin: number | null) {
  const dur = Math.max((endMin ?? startMin + 60) - startMin, 20);
  return {
    top: (startMin / 60) * WEEK_ROWH,
    height: (dur / 60) * WEEK_ROWH,
  };
}

const toMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
const minToHHMM = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** "오후 3:00" — HH:MM을 오전/오후 표기로 (앱 전체 시계 표기와 통일) */
function ampm(t: string): string {
  const h = parseInt(t.slice(0, 2), 10);
  const ap = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ap} ${h12}:${t.slice(3, 5)}`;
}

/** "오후 3:00~4:30" — 같은 오전/오후면 뒤쪽 접두 생략, 걸치면 둘 다 표기 */
function ampmRange(t: string, end: string | null | undefined): string {
  if (!end) return ampm(t);
  const same = parseInt(t.slice(0, 2), 10) < 12 === parseInt(end.slice(0, 2), 10) < 12;
  return `${ampm(t)}~${same ? ampm(end).replace(/^오[전후] /, '') : ampm(end)}`;
}

/** 일정 시간 표기 — 여러 날 조각은 화살표로 이어짐 표시 */
function evTimeText(ev: MEvent): string {
  if (ev.seg === 'start') return ev.time ? `${ampm(ev.time)} →` : '';
  if (ev.seg === 'mid') return '계속';
  if (ev.seg === 'end') return ev.end_time ? `→ ${ampm(ev.end_time)}` : '→ 종일';
  return ev.time ? ampmRange(ev.time, ev.end_time) : '';
}

/** 월 칩용 짧은 표기 — 정각이면 "오후 3시" */
function ampmShort(t: string): string {
  const h = parseInt(t.slice(0, 2), 10);
  const ap = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const m = t.slice(3, 5);
  return m === '00' ? `${ap} ${h12}시` : `${ap} ${h12}:${m}`;
}

/** 드래그 스냅 단위(분) — 애플과 동일 */
const SNAP = 15;
const snapMin = (v: number) => Math.max(0, Math.min(24 * 60, Math.round(v / SNAP) * SNAP));

/** 드래그 중 화면 표시용 상태 (실제 추적은 ref) */
type DragView =
  | { kind: 'create'; day: string; a: number; b: number }
  | { kind: 'move'; id: number; sm: number; em: number; dayIdx: number; origIdx: number; dx: number }
  | { kind: 'resize'; id: number; sm: number; em: number };

/** 겹침 배치 기준 — 시작 차이가 이 분 미만이면 제목이 가려지므로 좌우 분할, 이상이면 애플식 겹쳐 얹기 */
const NEAR_MIN = 30;

/** 일·주 뷰 — 겹치는 시간 일정 배치 (애플 캘린더식).
 *  시작이 가까우면 좌우 분할(col/ncols), 시작이 충분히 다르면 들여쓰기(indent)해서
 *  위에 겹쳐 얹는다 — 앞 일정의 제목 줄은 가려지지 않음. z는 나중 시작이 위. */
function layoutDayBlocks(evts: MEvent[]) {
  const items = evts
    .map((ev) => {
      const sm = toMin(ev.time!);
      const em = ev.end_time ? Math.max(toMin(ev.end_time), sm + 20) : sm + 60;
      return { ev, sm, em, col: 0, ncols: 1, indent: 0, z: 1 };
    })
    .sort((a, b) => a.sm - b.sm || b.em - a.em);
  const placed: typeof items = [];
  items.forEach((it, i) => {
    it.z = i + 1;
    const overlaps = placed.filter((p) => p.em > it.sm);
    const cascade = overlaps.filter((p) => it.sm - p.sm >= NEAR_MIN);
    it.indent = cascade.length > 0 ? Math.max(...cascade.map((p) => p.indent)) + 1 : 0;
    // 같은 들여쓰기 단계에서 시작이 가까운 것들과는 빈 열 찾아 좌우 분할
    const near = overlaps.filter((p) => it.sm - p.sm < NEAR_MIN && p.indent === it.indent);
    const used = new Set(near.map((p) => p.col));
    while (used.has(it.col)) it.col++;
    placed.push(it);
  });
  for (const it of items) {
    const peers = items.filter(
      (o) =>
        o.indent === it.indent && o.em > it.sm && it.em > o.sm && Math.abs(o.sm - it.sm) < NEAR_MIN,
    );
    it.ncols = Math.max(...peers.map((p) => p.col), it.col) + 1;
  }
  return items;
}

/** 회의 일정 달력 — 이벤트를 날짜에 표시하고 추가·삭제로 관리 */
export default function MeetingSchedule({
  code,
  isHost,
  startsAt,
  endsAt,
  recur = 'none',
  recurUntil = null,
  recurExcept = [],
  onOccurrenceChanged,
  participants = [],
}: Props) {
  const userId = useAuthStore((s) => s.user?.id);
  const dn = useDisplayName();
  const [events, setEvents] = useState<MEvent[]>([]);
  const [view, setView] = useState<ViewMode>('month');
  const [cursor, setCursor] = useState<Date>(() => new Date()); // 뷰 기준 날짜
  const [selected, setSelected] = useState<string>(() => ymd(new Date()));
  const [title, setTitle] = useState('');
  const [time, setTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [allDay, setAllDay] = useState(false); // 하루 종일 — 시간 없이 날짜에만 (애플 캘린더식)
  const [isCall, setIsCall] = useState(false);
  const [memo, setMemo] = useState('');
  const [remind, setRemind] = useState(''); // ''=기본, '0'=없음, 그 외 분
  const [evRecur, setEvRecur] = useState('none'); // 개별 일정 반복
  const [evUntil, setEvUntil] = useState(''); // 반복 종료일 (''=계속)
  const [evColor, setEvColor] = useState(''); // 일정 색 (''=기본)
  const [endDate, setEndDate] = useState(''); // 여러 날 일정 종료일 (''=하루)
  const [colorOpen, setColorOpen] = useState(false); // 색 팔레트 펼침

  // 색 팔레트 바깥 클릭으로 닫기
  useEffect(() => {
    if (!colorOpen) return;
    function onDown(e: PointerEvent) {
      if (!(e.target as HTMLElement).closest('.msched-color-pick')) setColorOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [colorOpen]);
  const [people, setPeople] = useState<{ id: number; username: string }[]>([]); // 선택된 관련자
  const [pq, setPq] = useState(''); // 관련자 검색어
  const [pplOpen, setPplOpen] = useState(false);
  const [pplIdx, setPplIdx] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [now, setNow] = useState<Date>(() => new Date()); // 일·주 뷰 "지금" 선
  const dayviewRef = useRef<HTMLDivElement | null>(null);
  const weekRef = useRef<HTMLDivElement | null>(null);
  // 모바일 — 주 뷰를 2일 단위로 (CSS의 767px 그리드 오버라이드와 짝)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // ── 애플식 인터랙션: 팝오버 + 드래그 ──
  /** 이벤트 클릭 팝오버 — view(상세) / edit(수정 폼) / create(드래그 생성 폼) */
  const [pop, setPop] = useState<{ mode: 'view' | 'edit' | 'create'; evId: number | null; day?: string; x: number; y: number } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragView | null>(null);
  /** 드래그 원시 추적 — 렌더와 무관한 값 (시작 좌표, 원본 시간, 권한) */
  const dragRef = useRef<{
    kind: 'create' | 'move' | 'resize';
    id?: number;
    day: string;
    startX: number;
    startY: number;
    a?: number; // create 시작 분
    origSm?: number;
    origEm?: number;
    hasEnd?: boolean;
    canEdit?: boolean;
    origIdx?: number; // 주 뷰 요일 인덱스
    colLefts?: number[]; // 주 뷰 각 요일 컬럼의 화면 x — 그리드는 display 문제로 rect가 0일 수 있어 컬럼 기준
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false); // 드래그 후 이어지는 click 무시
  const hoursElRef = useRef<HTMLDivElement | null>(null); // 일 뷰 .msched-hours
  // 월 뷰 기간 바 — 주(행) 단위 연속 오버레이 (셀별 칩은 셀 경계에서 끊겨 보임)
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cellElsRef = useRef(new Map<string, HTMLElement>());
  const [monthBars, setMonthBars] = useState<
    {
      key: string;
      left: number;
      top: number;
      width: number;
      title: string;
      color: string | null;
      roundL: boolean;
      roundR: boolean;
      showTitle: boolean;
    }[]
  >([]);
  /** 월 셀 하나에 들어가는 표시 줄 수 — 셀 높이 실측으로 계산 (칩 한 줄 ≈ 18px) */
  const [cellCap, setCellCap] = useState(2);

  function closePop() {
    setPop((p) => {
      if (p && p.mode !== 'view') resetForm();
      return null;
    });
  }

  // 팝오버 바깥 클릭·Escape로 닫기
  useEffect(() => {
    if (!pop) return;
    function onDown(e: PointerEvent) {
      if (popRef.current && !popRef.current.contains(e.target as Node)) closePop();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closePop();
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pop]);

  /** 블록 클릭 → 상세 팝오버 */
  function openViewPop(ev: MEvent, anchor: DOMRect) {
    setSelected(ev.date);
    // day = 클릭한 occurrence 날짜 — 팝오버가 반복 회차의 날짜를 정확히 보여주게
    setPop({ mode: 'view', evId: ev.id, day: ev.date, x: anchor.left + anchor.width / 2, y: anchor.bottom });
  }

  /** 드래그 생성 완료 → 폼을 팝오버로 (시간 범위 프리필) */
  function openCreatePop(day: string, s: number, e: number, x: number, y: number) {
    resetForm();
    setSelected(day);
    setTime(minToHHMM(s));
    setEndTime(minToHHMM(Math.max(e, s + SNAP)));
    setPop({ mode: 'create', evId: null, x, y });
  }

  /** 헤더 + 버튼 → 생성 폼 (선택 날짜 + 다음 정시 프리필). 모바일에서 유일한 생성 진입점 */
  function openCreatePlus(e: React.MouseEvent) {
    resetForm();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const h = selected === todayKey ? Math.min(new Date().getHours() + 1, 22) : 9;
    setTime(minToHHMM(h * 60));
    setEndTime(minToHHMM((h + 1) * 60));
    setPop({ mode: 'create', evId: null, x: r.left + r.width / 2, y: r.bottom });
  }

  // ── 빈 그리드 드래그로 생성 (마우스 전용 — 터치는 스크롤과 충돌) ──
  function gridPointerDown(e: React.PointerEvent, day: string, rectTop: number) {
    if (e.pointerType !== 'mouse' || e.button !== 0 || pop) return;
    const a = snapMin(((e.clientY - rectTop) / WEEK_ROWH) * 60);
    dragRef.current = { kind: 'create', day, startX: e.clientX, startY: e.clientY, a, moved: false };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 합성 이벤트 등 캡처 불가 환경 — 캡처 없이도 동작 */
    }
  }

  function gridPointerMove(e: React.PointerEvent, rectTop: number) {
    const d = dragRef.current;
    if (!d || d.kind !== 'create') return;
    if (!d.moved && Math.abs(e.clientY - d.startY) < 5) return;
    d.moved = true;
    const b = snapMin(((e.clientY - rectTop) / WEEK_ROWH) * 60);
    setDrag({ kind: 'create', day: d.day, a: d.a!, b });
  }

  function gridPointerUp(e: React.PointerEvent, rectTop: number) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.kind !== 'create') return;
    setDrag(null);
    if (!d.moved) return; // 짧은 클릭 → 기존 onClick(시간 프리필)에 맡김
    suppressClick.current = true;
    const b = snapMin(((e.clientY - rectTop) / WEEK_ROWH) * 60);
    openCreatePop(d.day, Math.min(d.a!, b), Math.max(d.a!, b), e.clientX, e.clientY);
  }

  // ── 블록 드래그: 이동(본체) / 리사이즈(아래 가장자리) ──
  function blockPointerDown(e: React.PointerEvent, ev: MEvent, dayIdx: number) {
    if ((e.target as HTMLElement).closest('button.msched-event-edit, button.msched-event-del')) return;
    e.stopPropagation();
    // 반복·여러 날 일정은 드래그로 옮기면 앵커/조각이 통째로 움직여 혼란 — 팝오버 수정만 허용
    const canEdit = (ev.created_by === userId || isHost) && !ev.recur && !ev.end_date;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.pointerType !== 'mouse' || e.button !== 0) {
      // 터치: 탭 = 상세 팝오버
      openViewPop(ev, rect);
      return;
    }
    const sm = toMin(ev.time!);
    const em = ev.end_time ? Math.max(toMin(ev.end_time), sm + SNAP) : sm + 60;
    const resize = canEdit && e.clientY > rect.bottom - 7;
    // 주 뷰 — 요일 컬럼들의 x 좌표 (가로 이동 판정용)
    const colEl = (e.currentTarget as HTMLElement).closest('.msched-week-col');
    const colLefts = colEl?.parentElement
      ? [...colEl.parentElement.querySelectorAll(':scope > .msched-week-col')].map(
          (c) => (c as HTMLElement).getBoundingClientRect().left,
        )
      : undefined;
    dragRef.current = {
      kind: resize ? 'resize' : 'move',
      id: ev.id,
      day: ev.date,
      startX: e.clientX,
      startY: e.clientY,
      origSm: sm,
      origEm: em,
      hasEnd: !!ev.end_time,
      canEdit,
      origIdx: dayIdx,
      colLefts,
      moved: false,
    };
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 합성 이벤트 등 캡처 불가 환경 — 캡처 없이도 동작 */
    }
  }

  function blockPointerMove(e: React.PointerEvent, weekMode: boolean) {
    const d = dragRef.current;
    if (!d || d.kind === 'create') return;
    if (!d.moved && Math.abs(e.clientY - d.startY) < 5 && Math.abs(e.clientX - d.startX) < 5) return;
    if (!d.canEdit) return; // 권한 없으면 드래그 무시 (클릭만)
    d.moved = true;
    const dur = d.origEm! - d.origSm!;
    const dMin = snapMin(d.origSm! + ((e.clientY - d.startY) / WEEK_ROWH) * 60) - d.origSm!;
    if (d.kind === 'move') {
      const sm = Math.max(0, Math.min(24 * 60 - dur, d.origSm! + dMin));
      let dayIdx = d.origIdx!;
      let dx = 0;
      if (weekMode && d.colLefts && d.colLefts.length >= 2) {
        dayIdx = 0;
        for (let i = 0; i < d.colLefts.length; i++) if (e.clientX >= d.colLefts[i]) dayIdx = i;
        dx = d.colLefts[dayIdx] - d.colLefts[d.origIdx!];
      }
      setDrag({ kind: 'move', id: d.id!, sm, em: sm + dur, dayIdx, origIdx: d.origIdx!, dx });
    } else {
      const em = Math.max(d.origSm! + SNAP, Math.min(24 * 60, d.origEm! + dMin));
      setDrag({ kind: 'resize', id: d.id!, sm: d.origSm!, em });
    }
  }

  function blockPointerUp(e: React.PointerEvent, ev: MEvent, weekMode: boolean) {
    const d = dragRef.current;
    dragRef.current = null;
    const view = drag;
    setDrag(null);
    if (!d || d.kind === 'create') return;
    if (!d.moved) {
      // 클릭 → 상세 팝오버
      openViewPop(ev, (e.currentTarget as HTMLElement).getBoundingClientRect());
      return;
    }
    suppressClick.current = true;
    if (!view || view.kind === 'create') return;
    const body: Record<string, unknown> = {};
    if (view.kind === 'move') {
      body.time = minToHHMM(view.sm);
      // 종료가 있던 일정만 종료도 함께 이동 (없던 건 그대로 없음)
      if (d.hasEnd) body.end_time = minToHHMM(view.em);
      if (weekMode && view.dayIdx !== view.origIdx) body.date = ymd(weekDays[view.dayIdx]);
    } else {
      body.end_time = minToHHMM(view.em); // 리사이즈는 종료를 부여/변경
    }
    void api(`/api/meetings/${code}/events/${ev.id}`, { method: 'PATCH', body }).then(() => {
      void load();
      window.dispatchEvent(new CustomEvent('exist:schedule-changed'));
    });
  }

  // 일·주 뷰일 때만 30초마다 현재 시각 갱신
  useEffect(() => {
    if (view === 'month') return;
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, [view]);

  // 일 뷰 진입 시 지금 시각 근처로 스크롤
  useEffect(() => {
    if (view !== 'day') return;
    const el = dayviewRef.current?.querySelector<HTMLElement>(`[data-hour="${new Date().getHours()}"]`);
    el?.scrollIntoView({ block: 'center' });
  }, [view, selected]);

  // 주 뷰 진입 시 지금 시각 근처로 스크롤
  useEffect(() => {
    if (view !== 'week') return;
    const box = weekRef.current;
    if (!box) return;
    const headH = box.querySelector('.msched-week-head')?.clientHeight ?? 0;
    const nowTop = ((new Date().getHours() * 60 + new Date().getMinutes()) / 60) * WEEK_ROWH;
    box.scrollTop = Math.max(0, headH + nowTop - box.clientHeight / 2);
  }, [view]);

  const load = useCallback(async () => {
    try {
      setEvents(await api<MEvent[]>(`/api/meetings/${code}/events`));
    } catch {
      /* 무시 */
    }
  }, [code]);

  useEffect(() => {
    void load();
  }, [load]);

  // 회의 메인 일정 날짜들 — 반복이면 occurrence 전부 펼쳐 표시 (nowbar와 일치시키기 위함)
  const meetingDays = useMemo(() => {
    const set = new Set<string>();
    if (!startsAt) return set;
    const first = new Date(startsAt);
    if (isNaN(first.getTime())) return set;
    if (recur === 'none') {
      set.add(ymd(first));
      return set;
    }
    const until = recurUntil ? new Date(recurUntil + 'T23:59:59') : null;
    // 종료일 없으면 시작 +1년까지만 (무한 루프 방지), 최대 400개
    const cap = until ?? new Date(first.getFullYear() + 1, first.getMonth(), first.getDate());
    let cur = first;
    for (let i = 0; i < 400 && cur.getTime() <= cap.getTime(); i++) {
      set.add(ymd(cur));
      cur = stepDate(cur, recur);
    }
    return set;
  }, [startsAt, recur, recurUntil]);
  // 삭제된 회차는 제외
  const exceptSet = useMemo(() => new Set(recurExcept), [recurExcept]);
  const isMeetingDayKey = (key: string) => meetingDays.has(key) && !exceptSet.has(key);

  // 날짜별 이벤트 — 반복 일정은 occurrence로 전개 (baseDate에 원본 날짜 유지)
  const byDate = useMemo(() => {
    const m = new Map<string, MEvent[]>();
    const push = (d: string, e: MEvent) => {
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push(e);
    };
    // 여러 날 걸친 일정은 날짜별 조각(seg)으로 분해 — 첫날 시작~자정, 중간 종일, 마지막 0시~종료
    const pushSpan = (e: MEvent, anchor: string) => {
      const span = e.end_date && e.end_date > e.date ? daysBetween(e.date, e.end_date) : 0;
      if (span === 0) {
        push(anchor, { ...e, date: anchor, baseDate: e.date });
        return;
      }
      for (let k = 0; k <= span && k < 60; k++) {
        const d = addDays(anchor, k);
        const seg: 'start' | 'mid' | 'end' = k === 0 ? 'start' : k === span ? 'end' : 'mid';
        let segTime = e.time;
        let segEnd = e.end_time;
        if (e.time) {
          if (seg === 'start') segEnd = '23:59';
          else if (seg === 'mid') {
            segTime = '00:00';
            segEnd = '23:59';
          } else segTime = '00:00';
        }
        push(d, { ...e, date: d, time: segTime, end_time: segEnd, baseDate: e.date, seg });
      }
    };
    for (const e of events) {
      if (!e.recur) {
        pushSpan(e, e.date);
        continue;
      }
      // 종료일 없으면 +6개월까지만 전개 (최대 200회)
      const fallback = new Date();
      fallback.setMonth(fallback.getMonth() + 6);
      const cap = e.recur_until ? new Date(e.recur_until + 'T23:59:59') : fallback;
      let cur = new Date(e.date + 'T00:00');
      for (let i = 0; i < 200 && cur.getTime() <= cap.getTime(); i++) {
        pushSpan(e, ymd(cur));
        cur = stepDate(cur, e.recur);
      }
    }
    return m;
  }, [events]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const todayKey = ymd(new Date());

  // 월 뷰 셀
  const first = new Date(year, month, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: { key: string; day: number; cur: boolean }[] = [];
  const prevDays = new Date(year, month, 0).getDate();
  for (let i = startDow - 1; i >= 0; i--) {
    const d = new Date(year, month - 1, prevDays - i);
    cells.push({ key: ymd(d), day: prevDays - i, cur: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ key: ymd(new Date(year, month, d)), day: d, cur: true });
  }
  while (cells.length % 7 !== 0) {
    const d = cells.length - startDow - daysInMonth + 1;
    cells.push({ key: ymd(new Date(year, month + 1, d)), day: d, cur: false });
  }

  // 월 기간 바 계산 — 셀 DOM 위치 실측으로 주 단위 연속 바를 배치
  useLayoutEffect(() => {
    if (view !== 'month') {
      setMonthBars([]);
      return;
    }
    const compute = () => {
      const grid = gridRef.current;
      if (!grid) return;
      const gr = grid.getBoundingClientRect();
      // 셀 높이 → 표시 가능한 칩 줄 수 (넘치면 +N이 한 줄 차지)
      const anyCell = cellElsRef.current.get(cells[0]?.key);
      if (anyCell) {
        const cr = anyCell.getBoundingClientRect();
        const ea = anyCell.querySelector('.msched-day-events')?.getBoundingClientRect();
        const availH = cr.bottom - (ea ? ea.top : cr.top + 34) - 4;
        setCellCap(Math.max(1, Math.floor(availH / 18)));
      }
      const bars: typeof monthBars = [];
      for (let r = 0; r < cells.length / 7; r++) {
        const row = cells.slice(r * 7, r * 7 + 7);
        // 이 주에 걸친 기간 일정을 run(연속 구간)으로 수집
        const runs = new Map<
          number,
          { c0: number; c1: number; ev: MEvent; hasStart: boolean; hasEnd: boolean }
        >();
        row.forEach((c, ci) => {
          for (const e of byDate.get(c.key) ?? []) {
            if (!e.seg) continue;
            const run = runs.get(e.id);
            if (!run)
              runs.set(e.id, {
                c0: ci,
                c1: ci,
                ev: e,
                hasStart: e.seg === 'start',
                hasEnd: e.seg === 'end',
              });
            else {
              run.c1 = ci;
              run.hasEnd = run.hasEnd || e.seg === 'end';
            }
          }
        });
        // 겹치면 아랫줄 레인으로
        const laneEnds: number[] = [];
        const sorted = [...runs.values()].sort((a, b) => a.c0 - b.c0 || a.ev.id - b.ev.id);
        for (const run of sorted) {
          let lane = 0;
          while (lane < laneEnds.length && laneEnds[lane] >= run.c0) lane++;
          laneEnds[lane] = run.c1;
          const el0 = cellElsRef.current.get(row[run.c0].key);
          const el1 = cellElsRef.current.get(row[run.c1].key);
          if (!el0 || !el1) continue;
          const r0 = el0.getBoundingClientRect();
          const r1 = el1.getBoundingClientRect();
          const evArea = el0.querySelector('.msched-day-events')?.getBoundingClientRect();
          bars.push({
            key: `${run.ev.id}@${r}:${lane}`,
            left: r0.left - gr.left + 3,
            width: r1.right - r0.left - 6,
            top: (evArea ? evArea.top : r0.top + 30) - gr.top + lane * 18,
            title: run.ev.title,
            color: run.ev.color,
            roundL: run.hasStart,
            roundR: run.hasEnd,
            showTitle: run.hasStart || run.c0 === 0,
          });
        }
      }
      setMonthBars(bars);
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, byDate, year, month]);

  // 주 뷰: 데스크탑은 cursor가 속한 주(일요일 시작), 모바일은 cursor부터 2일
  const weekDays = useMemo(() => {
    const start = new Date(cursor);
    if (!narrow) start.setDate(start.getDate() - start.getDay());
    const len = narrow ? 2 : 7;
    return Array.from({ length: len }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor, narrow]);

  const dayEvents = byDate.get(selected) ?? [];

  function nav(dir: -1 | 1) {
    const c = new Date(cursor);
    if (view === 'month') {
      c.setDate(1);
      c.setMonth(c.getMonth() + dir);
    } else if (view === 'week') {
      c.setDate(c.getDate() + (narrow ? 2 : 7) * dir);
    } else {
      c.setDate(c.getDate() + dir);
    }
    setCursor(c);
    if (view === 'day') setSelected(ymd(c));
  }

  function goToday() {
    const t = new Date();
    setCursor(t);
    setSelected(ymd(t));
  }

  function switchView(v: ViewMode) {
    setView(v);
    // 일 뷰(그리고 모바일 2일 주 뷰)는 커서=선택 날짜로 정렬
    if (v === 'day' || (v === 'week' && narrow)) setCursor(new Date(selected + 'T00:00'));
  }

  function headLabel(): string {
    if (view === 'month') return `${year}년 ${month + 1}월`;
    if (view === 'week') {
      const a = weekDays[0];
      const b = weekDays[weekDays.length - 1];
      const left = `${a.getMonth() + 1}월 ${a.getDate()}일`;
      const right =
        a.getMonth() === b.getMonth() ? `${b.getDate()}일` : `${b.getMonth() + 1}월 ${b.getDate()}일`;
      return `${left} ~ ${right}`;
    }
    const d = new Date(selected + 'T00:00');
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
  }

  async function excludeOccurrence() {
    if (!window.confirm(`${selectedLabel()} 회차를 삭제할까요? 이 날 하나만 빠지고 나머지는 그대로예요.`))
      return;
    try {
      await api(`/api/meetings/${code}/occurrences/exclude`, {
        method: 'POST',
        body: { date: selected },
      });
      onOccurrenceChanged?.();
      window.dispatchEvent(new CustomEvent('exist:schedule-changed'));
    } catch {
      /* 전역 토스트 */
    }
  }

  function resetForm() {
    setTitle('');
    setTime('');
    setEndTime('');
    setAllDay(false);
    setIsCall(false);
    setMemo('');
    setRemind('');
    setEvRecur('none');
    setEvUntil('');
    setEvColor('');
    setEndDate('');
    setPeople([]);
    setPq('');
    setPplOpen(false);
    setEditingId(null);
  }

  function startEdit(evLike: MEvent) {
    // 조각(seg)·occurrence 사본은 시간이 변조돼 있음 — 항상 원본 이벤트 기준으로 편집
    const ev = events.find((x) => x.id === evLike.id) ?? evLike;
    setEditingId(ev.id);
    // 반복 occurrence를 수정해도 원본(앵커) 날짜 기준 — 날짜를 바꾸면 시리즈 전체가 이동
    setSelected(ev.date);
    setTitle(ev.title);
    setAllDay(!ev.time);
    setTime(ev.time ?? '');
    setEndTime(ev.end_time ?? '');
    setIsCall(!!ev.is_call);
    setMemo(ev.memo ?? '');
    setRemind(ev.remind == null ? '' : String(ev.remind));
    setEvRecur(ev.recur ?? 'none');
    setEvUntil(ev.recur_until ?? '');
    setEvColor(ev.color ?? '');
    setEndDate(ev.end_date ?? '');
    setPeople(ev.people?.map((p) => ({ id: p.id, username: p.name || p.username })) ?? []);
  }

  // 검색어에 맞는 참가자 (이미 선택된 사람 제외, 최대 8명)
  const pplMatches = useMemo(() => {
    const q = pq.trim().toLowerCase();
    return participants
      .filter((p) => !people.some((s) => s.id === p.userId))
      .filter((p) => !q || p.username.toLowerCase().includes(q) || dn(p.username).toLowerCase().includes(q))
      .slice(0, 8);
  }, [participants, people, pq]);

  function addPerson(p: { userId: number; username: string }) {
    setPeople((prev) => [...prev, { id: p.userId, username: p.username }]);
    setPq('');
    setPplIdx(0);
  }

  function removePerson(id: number) {
    setPeople((prev) => prev.filter((x) => x.id !== id));
  }

  function pplKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !pq && people.length > 0) {
      removePerson(people[people.length - 1].id);
      return;
    }
    if (!pplOpen || pplMatches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setPplIdx((i) => (i + 1) % pplMatches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setPplIdx((i) => (i - 1 + pplMatches.length) % pplMatches.length);
    } else if (e.key === 'Enter') {
      e.preventDefault(); // 폼 제출 막고 선택으로
      addPerson(pplMatches[Math.min(pplIdx, pplMatches.length - 1)]);
    } else if (e.key === 'Escape') {
      setPplOpen(false);
    }
  }

  async function addEvent(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    const multiDay = !!endDate && endDate > selected;
    // 여러 날 걸치면 다음 날 이른 시각도 정상 — 같은 날일 때만 검사
    if (time && endTime && endTime <= time && !multiDay) {
      window.dispatchEvent(
        new CustomEvent('app:error', { detail: '종료 시간이 시작보다 빨라요' }),
      );
      return;
    }
    const body = {
      title,
      date: selected,
      time: allDay ? null : time || null,
      end_time: !allDay && time ? endTime || null : null,
      end_date: multiDay ? endDate : null,
      is_call: isCall && !allDay && !!time, // 통화는 시작 시간이 있어야 의미 있음
      memo: memo.trim() || null,
      remind: remind === '' ? null : Number(remind),
      recur: evRecur === 'none' ? null : evRecur,
      recur_until: evRecur !== 'none' && evUntil ? evUntil : null,
      color: evColor || null,
      people: people.map((p) => p.id),
    };
    if (editingId != null) {
      await api(`/api/meetings/${code}/events/${editingId}`, { method: 'PATCH', body });
    } else {
      await api(`/api/meetings/${code}/events`, { method: 'POST', body });
    }
    resetForm();
    setPop(null);
    void load();
    window.dispatchEvent(new CustomEvent('exist:schedule-changed')); // nowbar 일정 갱신
  }
  async function removeEvent(id: number) {
    await api(`/api/meetings/${code}/events/${id}`, { method: 'DELETE' });
    void load();
    window.dispatchEvent(new CustomEvent('exist:schedule-changed'));
  }

  function selectedLabel(): string {
    const d = new Date(selected + 'T00:00');
    return `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
  }

  // 일 뷰 타임라인 재료
  const timed = [...dayEvents.filter((e) => e.time)].sort((a, b) =>
    a.time!.localeCompare(b.time!),
  );
  const untimed = dayEvents.filter((e) => !e.time);
  const meetingToday = isMeetingDayKey(selected);
  const meetStart = startsAt ? new Date(startsAt) : null;
  const meetOk = meetingToday && meetStart != null && !isNaN(meetStart.getTime());
  // 오전 12시(0시) ~ 밤 11시 — 하루 전체 시간선
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const isToday = selected === todayKey;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // 지금 배지와 겹치는 눈금 라벨은 숨김 (정각 ±20분)
  const labelHidden = (h: number) => Math.abs(nowMin - h * 60) < 20;
  const todayInWeek = weekDays.some((d) => ymd(d) === todayKey);

  const eventRow = (ev: MEvent, compact = false) => (
    <div
      key={ev.id}
      className={'msched-event' + (compact ? ' compact' : '') + (ev.is_call ? ' call' : '')}
      style={evColorStyle(ev.color)}
    >
      {!ev.time && <span className="msched-event-time allday">하루 종일</span>}
      {ev.time && <span className="msched-event-time">{evTimeText(ev)}</span>}
      <Marquee className="msched-event-title">
        {ev.is_call ? (
          <span className="msched-call-ic">
            <PhoneIcon size={12} />
          </span>
        ) : null}
        {ev.title}
      </Marquee>
      <span className="msched-event-author">{dn(ev.author)}</span>
      {(ev.created_by === userId || isHost) && (
        <>
          <button
            className={`msched-event-edit${editingId === ev.id ? ' on' : ''}`}
            title="수정"
            onClick={() => startEdit(ev)}
          >
            ✎
          </button>
          <button className="msched-event-del" title="삭제" onClick={() => void removeEvent(ev.id)}>
            ×
          </button>
        </>
      )}
      {/* 관련자·메모 — 있는 것만 다음 줄에 (애플 캘린더 상세 느낌) */}
      {((ev.people?.length ?? 0) > 0 || ev.memo) && (
        <div className="msched-event-extra">
          {(ev.people?.length ?? 0) > 0 && (
            <span className="msched-event-ppl">
              {ev.people.map((p) => (
                <span key={p.id} className="msched-event-person">
                  {p.name || dn(p.username)}
                </span>
              ))}
            </span>
          )}
          {ev.memo && <span className="msched-event-memo">{ev.memo}</span>}
        </div>
      )}
    </div>
  );

  // 일정 추가/수정 폼 — 평소엔 패널 하단, 팝오버(edit/create)에선 팝오버 안에 렌더
  const formEl = (
        <form className="msched-add" onSubmit={addEvent}>
          <input
            className="msched-add-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`${selectedLabel()} 통화/일정 제목`}
            maxLength={80}
          />
          <div className="msched-add-times">
            {/* 하루 종일 — 켜면 시간 없이 날짜에만 등록 (애플 캘린더식) */}
            <button
              type="button"
              className={`msched-call-sw${allDay ? ' on' : ''}`}
              onClick={() =>
                setAllDay((v) => {
                  const next = !v;
                  if (next) {
                    setTime('');
                    setEndTime('');
                    setIsCall(false);
                  }
                  return next;
                })
              }
              title="시간 없이 하루 종일 일정으로 등록"
            >
              하루 종일
              <span className={`msched-sw${allDay ? ' on' : ''}`}>
                <i />
              </span>
            </button>
            {!allDay && (
              <button
                type="button"
                className={`msched-call-sw${isCall ? ' on' : ''}`}
                onClick={() => time && setIsCall((v) => !v)}
                disabled={!time}
                title={time ? '통화로 등록 (10분 전 알림)' : '시작 시간을 먼저 정하세요'}
              >
                <PhoneIcon size={14} /> 통화
                <span className={`msched-sw${isCall ? ' on' : ''}`}>
                  <i />
                </span>
              </button>
            )}
          </div>
          {/* 시작/종료 — 넓으면 한 줄, 패널이 좁으면 그룹 단위로 2줄 (글씨 짤림 방지) */}
          <div className="msched-add-remind msched-se">
            <span className="msched-se-group">
              <span className="msched-se-label">시작</span>
              <input
                type="date"
                value={selected}
                onChange={(e) => e.target.value && setSelected(e.target.value)}
                onClick={(e) => (e.currentTarget as HTMLInputElement).showPicker?.()}
                title="시작 날짜"
              />
              {!allDay && (
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  title="시작 시간"
                />
              )}
            </span>
            <span className="msched-times-sep">~</span>
            <span className="msched-se-group">
              <span className="msched-se-label">종료</span>
              <input
                type="date"
                value={endDate || selected}
                min={selected}
                onChange={(e) =>
                  setEndDate(!e.target.value || e.target.value <= selected ? '' : e.target.value)
                }
                onClick={(e) => (e.currentTarget as HTMLInputElement).showPicker?.()}
                title="종료 날짜"
              />
              {!allDay && (
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  disabled={!time}
                  title="종료 시간"
                />
              )}
            </span>
          </div>
          {/* 알림 시점 — 애플식 선택 (시간 일정에만 의미) */}
          {!allDay && (
            <div className="msched-add-remind">
              <span className="msched-people-label">알림</span>
              <select value={remind} onChange={(e) => setRemind(e.target.value)} disabled={!time}>
                {REMIND_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {/* 반복 — 애플식 (개별 일정 단위) */}
          <div className="msched-add-remind">
            <span className="msched-people-label">반복</span>
            <select value={evRecur} onChange={(e) => setEvRecur(e.target.value)}>
              <option value="none">없음</option>
              <option value="daily">매일</option>
              <option value="weekly">매주</option>
              <option value="biweekly">격주</option>
              <option value="monthly">매월</option>
            </select>
            {evRecur !== 'none' && (
              <input
                type="date"
                value={evUntil}
                onChange={(e) => setEvUntil(e.target.value)}
                title="반복 종료일 — 비우면 계속 반복"
              />
            )}
          </div>
          {/* 색 — 애플 캘린더 팔레트 */}
          <div className="msched-add-remind">
            <span className="msched-people-label">색</span>
            {/* 색 점 자체가 드롭다운 버튼 — 누르면 팔레트가 펼쳐짐 */}
            <div className="msched-color-pick">
              <button
                type="button"
                className="msched-color-dot btn"
                style={{ background: evColor || 'var(--green)' }}
                aria-label="일정 색 선택"
                title={COLOR_CHOICES.find((c) => c.value === evColor)?.label ?? '기본'}
                onClick={() => setColorOpen((v) => !v)}
              />
              {colorOpen && (
                <div className="msched-color-pop">
                  {COLOR_CHOICES.map((c) => (
                    <button
                      type="button"
                      key={c.value}
                      className={'msched-color-dot' + (evColor === c.value ? ' on' : '')}
                      style={{ background: c.value || 'var(--green)' }}
                      title={c.label}
                      aria-label={`색 ${c.label}`}
                      onClick={() => {
                        setEvColor(c.value);
                        setColorOpen(false);
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* 관련자 — 검색해서 추가 (애플 캘린더 초대 느낌) */}
          {participants.length > 0 && (
            <div className="msched-add-people">
              <span className="msched-people-label">관련자</span>
              {people.map((p) => (
                <span key={p.id} className="msched-person on">
                  {dn(p.username)}
                  <button
                    type="button"
                    className="msched-person-x"
                    aria-label={`${dn(p.username)} 제외`}
                    onClick={() => removePerson(p.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
              <div className="msched-ppl-search">
                <input
                  value={pq}
                  onChange={(e) => {
                    setPq(e.target.value);
                    setPplIdx(0);
                  }}
                  onFocus={() => setPplOpen(true)}
                  onBlur={() => setPplOpen(false)}
                  onKeyDown={pplKeyDown}
                  placeholder={people.length === 0 ? '참가자 검색해서 추가' : '더 추가'}
                />
                {pplOpen && pplMatches.length > 0 && (
                  <div className="msched-ppl-pop">
                    {pplMatches.map((p, i) => (
                      <button
                        type="button"
                        key={p.userId}
                        className={'msched-ppl-item' + (i === pplIdx ? ' active' : '')}
                        // blur보다 먼저 잡아야 클릭이 살아남음 (MentionInput과 동일한 트릭)
                        onMouseDown={(e) => {
                          e.preventDefault();
                          addPerson(p);
                        }}
                        onMouseEnter={() => setPplIdx(i)}
                      >
                        {dn(p.username)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <input
            className="msched-add-memo"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="메모 (선택)"
            maxLength={500}
          />
          <div className="msched-add-actions">
            {editingId != null && (
              <button
                type="button"
                className="msched-add-cancel"
                onClick={() => {
                  resetForm();
                  setPop(null);
                }}
              >
                취소
              </button>
            )}
            <button type="submit" className="msched-add-btn" disabled={!title.trim()}>
              {editingId != null ? '수정 저장' : '일정 추가'}
            </button>
          </div>
          <p className="msched-add-hint">
            {editingId != null ? (
              '✎ 일정을 수정하는 중이에요'
            ) : (
              <>
                <BellIcon size={12} /> 추가하면 참가자 전원에게 알림
              </>
            )}
            {isCall && ' · 통화는 10분 전에 "들어오세요" 알림'}
          </p>
        </form>
  );

  const popEv =
    pop && pop.evId != null
      ? ((pop.day ? (byDate.get(pop.day) ?? []).find((x) => x.id === pop.evId) : undefined) ??
        events.find((x) => x.id === pop.evId) ??
        null)
      : null;
  /** 조각이 아닌 원본 이벤트 — 여러 날 일정의 기간·시간 표시용 */
  const popBase = popEv ? (events.find((x) => x.id === popEv.id) ?? popEv) : null;
  const popCanEdit = popEv ? popEv.created_by === userId || isHost : false;

  return (
    <div className={`msched msched-view-${view}`}>
      <div className="msched-cal">
        <div className="msched-cal-head">
          <button onClick={() => nav(-1)} aria-label="이전">
            ‹
          </button>
          <span className="msched-head-label">{headLabel()}</span>
          <button onClick={() => nav(1)} aria-label="다음">
            ›
          </button>
          <button type="button" className="msched-today-btn" onClick={goToday}>
            오늘
          </button>
          <div className="msched-seg" role="tablist" aria-label="일정 보기 단위">
            {(['day', 'week', 'month'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={view === v ? 'on' : ''}
                onClick={() => switchView(v)}
              >
                {VIEW_LABEL[v]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="msched-plus"
            onClick={openCreatePlus}
            aria-label="일정 추가"
            title="일정 추가"
          >
            +
          </button>
        </div>

        {view === 'week' && (
          <div className="msched-weekwrap" ref={weekRef}>
            {/* 헤더 + 종일 레인을 한 덩어리로 sticky — 따로 붙이면 스크롤 중 겹쳐 높이가 변해 보임 */}
            <div className="msched-week-sticky">
            <div className="msched-week-head">
              <span className="msched-week-gutter-spacer" />
              {weekDays.map((d) => {
                const key = ymd(d);
                const dayUntimed = (byDate.get(key) ?? []).filter((e) => !e.time);
                return (
                  <button
                    key={key}
                    className={
                      'msched-wday-btn' +
                      (key === selected ? ' sel' : '') +
                      (key === todayKey ? ' today' : '')
                    }
                    onClick={() => setSelected(key)}
                  >
                    <span className="msched-wcol-dow">{DOW[d.getDay()]}</span>
                    <span className={'msched-wcol-num' + (key === todayKey ? ' today' : '')}>
                      {d.getDate()}
                    </span>
                    {dayUntimed.length > 0 && (
                      <span className="msched-wday-untimed" title="하루 종일 일정">
                        {dayUntimed.length}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 하루 종일 레인 — 날짜 헤더 바로 아래, 애플 캘린더식 */}
            {weekDays.some((d) => (byDate.get(ymd(d)) ?? []).some((e) => !e.time)) && (
              <div className="msched-week-allday">
                <span className="msched-week-gutter-spacer allday">종일</span>
                {weekDays.map((d) => {
                  const key = ymd(d);
                  const dayUntimed = (byDate.get(key) ?? []).filter((e) => !e.time);
                  return (
                    <div
                      key={key}
                      className={'msched-wallday-col' + (key === selected ? ' sel' : '')}
                      onClick={() => setSelected(key)}
                    >
                      {dayUntimed.map((e) => (
                        <span key={e.id} className="msched-wallday-chip" style={evColorStyle(e.color)} title={`${e.title} · ${dn(e.author)}${e.memo ? ` — ${e.memo}` : ''}`}>
                          {e.title}
                        </span>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            </div>
            <div className="msched-week-body">
              <div className="msched-week-gutter">
                {hours.map((h) => (
                  <span key={h} className="msched-week-hlabel">
                    {todayInWeek && labelHidden(h) ? '' : hourLabel(h)}
                  </span>
                ))}
                <span className="msched-week-hlabel end">{hourLabel(24)}</span>
                {todayInWeek && (
                  <span
                    className="msched-nowline-time week"
                    style={{ top: ((now.getHours() * 60 + now.getMinutes()) / 60) * WEEK_ROWH }}
                  >
                    {pad(now.getHours())}:{pad(now.getMinutes())}
                  </span>
                )}
              </div>
              <div className="msched-week-grid">
                {weekDays.map((d, dayIdx) => {
                  const key = ymd(d);
                  const dayTimed = (byDate.get(key) ?? [])
                    .filter((e) => e.time)
                    .sort((a, b) => a.time!.localeCompare(b.time!));
                  const meet = isMeetingDayKey(key);
                  return (
                    <div
                      key={key}
                      className={
                        'msched-week-col' +
                        (key === selected ? ' sel' : '') +
                        (key === todayKey ? ' today' : '')
                      }
                      onPointerDown={(e) => {
                        if ((e.target as HTMLElement).closest('.msched-wblock')) return;
                        gridPointerDown(e, key, e.currentTarget.getBoundingClientRect().top);
                      }}
                      onPointerMove={(e) =>
                        gridPointerMove(e, e.currentTarget.getBoundingClientRect().top)
                      }
                      onPointerUp={(e) =>
                        gridPointerUp(e, e.currentTarget.getBoundingClientRect().top)
                      }
                    >
                      {hours.map((h) => (
                        <div
                          key={h}
                          className="msched-week-cell"
                          onClick={() => {
                            if (suppressClick.current) {
                              suppressClick.current = false;
                              return;
                            }
                            setSelected(key);
                            setTime(`${pad(h)}:00`);
                            setEndTime('');
                          }}
                          title="드래그하면 그 길이만큼 일정을 만들어요"
                        />
                      ))}
                      {/* 드래그 생성 고스트 */}
                      {drag?.kind === 'create' && drag.day === key && (
                        <div
                          className="msched-ghost"
                          style={{
                            top: (Math.min(drag.a, drag.b) / 60) * WEEK_ROWH,
                            height: (Math.max(Math.abs(drag.b - drag.a), SNAP) / 60) * WEEK_ROWH,
                          }}
                        >
                          {ampmRange(minToHHMM(Math.min(drag.a, drag.b)), minToHHMM(Math.max(drag.a, drag.b)))}
                        </div>
                      )}
                      {meet && meetStart && !isNaN(meetStart.getTime()) && (
                        <div
                          className="msched-wblock meeting"
                          style={blockPos(
                            meetStart.getHours() * 60 + meetStart.getMinutes(),
                            endsAt
                              ? new Date(endsAt).getHours() * 60 + new Date(endsAt).getMinutes()
                              : null,
                          )}
                          title="이 그룹 일정"
                        >
                          📌 이 그룹
                        </div>
                      )}
                      {/* 겹치는 일정은 일 뷰와 같은 열 분할 (포개져 안 보이던 문제) */}
                      {layoutDayBlocks(dayTimed).map(({ ev: e, sm, em, col, ncols, indent, z }) => {
                        const dv = drag && drag.kind !== 'create' && drag.id === e.id ? drag : null;
                        const s = dv ? dv.sm : sm;
                        const en = dv ? dv.em : em;
                        // 주 뷰 이동은 요일도 바뀔 수 있음 — 원래 컬럼 기준 X 오프셋으로 표현
                        const dx = dv && dv.kind === 'move' ? dv.dx : 0;
                        return (
                        <button
                          key={e.id}
                          className={'msched-wblock' + (e.is_call ? ' call' : '') + (dv ? ' dragging' : '')}
                          style={{
                            ...evColorStyle(e.color),
                            top: (s / 60) * WEEK_ROWH,
                            height: (Math.max(en - s, 20) / 60) * WEEK_ROWH,
                            left: `calc((100% - ${indent * 8 + 4}px) * ${(col / ncols).toFixed(4)} + ${indent * 8 + 2}px)`,
                            width: `calc((100% - ${indent * 8 + 4}px) / ${ncols})`,
                            zIndex: dv ? 15 : z,
                            transform: dx ? `translateX(${dx}px)` : undefined,
                          }}
                          title={`${ampmRange(e.time!, e.end_time)} ${e.title}${e.memo ? ` — ${e.memo}` : ''}`}
                          onPointerDown={(ev2) => blockPointerDown(ev2, e, dayIdx)}
                          onPointerMove={(ev2) => blockPointerMove(ev2, true)}
                          onPointerUp={(ev2) => blockPointerUp(ev2, e, true)}
                        >
                          {/* 애플처럼 제목 먼저, 시간은 아랫줄 */}
                          <span className="msched-wblock-t">{e.title}</span>
                          <span className="msched-wblock-time">
                            {dv ? ampmRange(minToHHMM(s), minToHHMM(en)) : evTimeText(e)}
                          </span>
                        </button>
                        );
                      })}
                      {todayInWeek && (
                        <div
                          className={'msched-nowline week' + (key === todayKey ? '' : ' dim')}
                          style={{ top: (nowMin / 60) * WEEK_ROWH }}
                        >
                          {key === todayKey && <i className="msched-nowline-dot" />}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {view === 'day' && (
          <div className="msched-dayview" ref={dayviewRef}>
            {untimed.length > 0 && (
              <div className="msched-allday">
                <span className="msched-hour-label">종일</span>
                <div className="msched-allday-list">{untimed.map((e) => eventRow(e, true))}</div>
              </div>
            )}
            <div
              className="msched-hours"
              ref={hoursElRef}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest('.msched-dblock')) return;
                const el = hoursElRef.current;
                if (el) gridPointerDown(e, selected, el.getBoundingClientRect().top + 8);
              }}
              onPointerMove={(e) => {
                const el = hoursElRef.current;
                if (el) gridPointerMove(e, el.getBoundingClientRect().top + 8);
              }}
              onPointerUp={(e) => {
                const el = hoursElRef.current;
                if (el) gridPointerUp(e, el.getBoundingClientRect().top + 8);
              }}
            >
              {hours.map((h) => (
                <div
                  key={h}
                  data-hour={h}
                  className="msched-hour"
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false;
                      return;
                    }
                    setAllDay(false);
                    setTime(`${pad(h)}:00`);
                    setEndTime('');
                  }}
                  title="드래그하면 그 길이만큼 일정을 만들어요"
                >
                  <span className="msched-hour-label">
                    {isToday && labelHidden(h) ? '' : hourLabel(h)}
                  </span>
                  {isToday && now.getHours() === h && (
                    <div
                      className="msched-nowline"
                      style={{ top: `${(now.getMinutes() / 60) * 100}%` }}
                    >
                      <span className="msched-nowline-time">
                        {pad(now.getHours())}:{pad(now.getMinutes())}
                      </span>
                    </div>
                  )}
                  <div className="msched-hour-slot" />
                </div>
              ))}

              {/* 시간 일정 — 주 뷰처럼 분 비례 절대 배치 (칸이 늘어나 시간선이 밀리던 문제 해결) */}
              <div className="msched-day-layer">
                {meetOk && (
                  <div
                    className="msched-dblock meeting"
                    style={blockPos(
                      meetStart!.getHours() * 60 + meetStart!.getMinutes(),
                      endsAt
                        ? new Date(endsAt).getHours() * 60 + new Date(endsAt).getMinutes()
                        : null,
                    )}
                  >
                    <span className="msched-event-title">📌 이 그룹 일정</span>
                    <span className="msched-event-time">
                      {ampmRange(
                        `${pad(meetStart!.getHours())}:${pad(meetStart!.getMinutes())}`,
                        endsAt
                          ? `${pad(new Date(endsAt).getHours())}:${pad(new Date(endsAt).getMinutes())}`
                          : null,
                      )}
                    </span>
                    {isHost && recur !== 'none' && (
                      <button
                        type="button"
                        className="msched-occ-del"
                        onClick={(e) => {
                          e.stopPropagation();
                          void excludeOccurrence();
                        }}
                      >
                        이 회차 삭제
                      </button>
                    )}
                  </div>
                )}
                {/* 드래그 생성 고스트 */}
                {drag?.kind === 'create' && drag.day === selected && (
                  <div
                    className="msched-ghost"
                    style={{
                      top: (Math.min(drag.a, drag.b) / 60) * WEEK_ROWH,
                      height: (Math.max(Math.abs(drag.b - drag.a), SNAP) / 60) * WEEK_ROWH,
                    }}
                  >
                    {ampmRange(minToHHMM(Math.min(drag.a, drag.b)), minToHHMM(Math.max(drag.a, drag.b)))}
                  </div>
                )}
                {layoutDayBlocks(timed).map(({ ev, sm, em, col, ncols, indent, z }) => {
                  // 드래그 중이면 그 위치·길이를 실시간 반영
                  const dv = drag && drag.kind !== 'create' && drag.id === ev.id ? drag : null;
                  const s = dv ? dv.sm : sm;
                  const en = dv ? dv.em : em;
                  return (
                  <div
                    key={ev.id}
                    className={'msched-dblock' + (ev.is_call ? ' call' : '') + (dv ? ' dragging' : '')}
                    style={{
                      ...evColorStyle(ev.color),
                      top: (s / 60) * WEEK_ROWH,
                      height: Math.max(((en - s) / 60) * WEEK_ROWH - 2, 22),
                      left: `calc((100% - ${indent * 12}px) * ${(col / ncols).toFixed(4)} + ${indent * 12 + (col > 0 ? 2 : 0)}px)`,
                      width: `calc((100% - ${indent * 12}px) / ${ncols}${ncols > 1 ? ' - 2px' : ''})`,
                      zIndex: dv ? 15 : z,
                    }}
                    onPointerDown={(e) => blockPointerDown(e, ev, 0)}
                    onPointerMove={(e) => blockPointerMove(e, false)}
                    onPointerUp={(e) => blockPointerUp(e, ev, false)}
                  >
                    <Marquee className="msched-event-title">
                      {ev.is_call ? (
                        <span className="msched-call-ic">
                          <PhoneIcon size={12} />
                        </span>
                      ) : null}
                      {ev.title}
                    </Marquee>
                    <span className="msched-event-time">
                      {dv ? ampmRange(minToHHMM(s), minToHHMM(en)) : evTimeText(ev)}
                    </span>
                    <span className="msched-event-author">{dn(ev.author)}</span>
                    {(ev.created_by === userId || isHost) && (
                      <>
                        <button
                          className={`msched-event-edit${editingId === ev.id ? ' on' : ''}`}
                          title="수정"
                          onClick={() => startEdit(ev)}
                        >
                          ✎
                        </button>
                        <button
                          className="msched-event-del"
                          title="삭제"
                          onClick={() => void removeEvent(ev.id)}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                  );
                })}
              </div>
              {/* 하루 끝 경계선 */}
              <div className="msched-hour msched-hour-end" aria-hidden>
                <span className="msched-hour-label">{hourLabel(24)}</span>
                <div className="msched-hour-slot" />
              </div>
            </div>
          </div>
        )}

        {view === 'month' && (
        <div className="msched-grid" ref={gridRef}>
          {DOW.map((w) => (
            <span key={w} className="msched-dow">
              {w}
            </span>
          ))}
          {cells.map((c, i) => {
            const all = byDate.get(c.key) ?? [];
            // 기간 일정(seg)은 오버레이 바로 그림 — 셀 칩에서는 제외하고 자리만 비워둠
            const spanCount = Math.min(all.filter((e) => e.seg).length, Math.min(cellCap, 2));
            const evs = all.filter((e) => !e.seg);
            const isMeetingDay = isMeetingDayKey(c.key);
            // 셀 높이만큼 최대한 채우고, 안 들어가면 마지막 한 줄은 +N
            const avail = Math.max(0, cellCap - spanCount - (isMeetingDay ? 1 : 0));
            const chips = evs.length > avail ? evs.slice(0, Math.max(0, avail - 1)) : evs;
            const overflow = evs.length - chips.length;
            return (
              <button
                key={i}
                ref={(el) => {
                  if (el) cellElsRef.current.set(c.key, el);
                  else cellElsRef.current.delete(c.key);
                }}
                className={
                  'msched-day' +
                  (c.cur ? '' : ' out') +
                  (c.key === selected ? ' sel' : '')
                }
                onClick={() => setSelected(c.key)}
              >
                <span
                  className={
                    'msched-day-num' +
                    (c.key === todayKey ? ' today' : '') +
                    (c.key === selected ? ' sel' : '')
                  }
                >
                  {c.day}
                </span>
                <span className="msched-day-events">
                  {/* 오버레이 바가 차지할 자리 */}
                  {Array.from({ length: spanCount }).map((_, k) => (
                    <span key={`sp${k}`} className="msched-chip-space" />
                  ))}
                  {isMeetingDay && (
                    <span className="msched-chip meeting" title="이 그룹 일정">
                      <i className="msched-chip-dot" />이 그룹
                    </span>
                  )}
                  {chips.map((e) => (
                    <span key={e.id} className="msched-chip" style={evColorStyle(e.color)} title={e.title}>
                      {e.time && <b className="msched-chip-time">{ampmShort(e.time)}</b>}
                      {e.title}
                    </span>
                  ))}
                  {overflow > 0 && <span className="msched-more">+{overflow}</span>}
                </span>
              </button>
            );
          })}
          {/* 기간 일정 연속 바 — 주 단위로 셀 위를 하나의 덩어리로 가로지름 (애플식) */}
          {monthBars.map((b) => (
            <div
              key={b.key}
              className="msched-mbar"
              style={{
                ...evColorStyle(b.color),
                left: b.left,
                top: b.top,
                width: b.width,
                borderRadius: `${b.roundL ? 4 : 0}px ${b.roundR ? 4 : 0}px ${b.roundR ? 4 : 0}px ${b.roundL ? 4 : 0}px`,
              }}
              title={b.title}
            >
              {b.showTitle ? b.title : ''}
            </div>
          ))}
        </div>
        )}
      </div>

      <div className="msched-day-panel">
        {view !== 'day' && <div className="msched-day-title">{selectedLabel()}</div>}

        {/* 회의 본 일정이 이 날이면 표시 (일 뷰는 타임라인에 이미 있음) */}
        {view !== 'day' && isMeetingDayKey(selected) && (
          <div className="msched-main-event">
            <span className="msched-main-event-text">
              📌 이 그룹 일정
              {startsAt && (
                <span>
                  {' '}
                  {ampmRange(
                    `${pad(new Date(startsAt).getHours())}:${pad(new Date(startsAt).getMinutes())}`,
                    endsAt
                      ? `${pad(new Date(endsAt).getHours())}:${pad(new Date(endsAt).getMinutes())}`
                      : null,
                  )}
                </span>
              )}
            </span>
            {/* 반복 회의면 이 회차만 삭제 (호스트) */}
            {isHost && recur !== 'none' && (
              <button
                type="button"
                className="msched-occ-del"
                title="이 회차만 삭제"
                onClick={() => void excludeOccurrence()}
              >
                이 회차 삭제
              </button>
            )}
          </div>
        )}

        {view !== 'day' && (
          <div className="msched-events">
            {dayEvents.length === 0 ? (
              <div className="msched-empty">이 날 일정이 없어요</div>
            ) : (
              dayEvents.map((ev) => eventRow(ev))
            )}
          </div>
        )}
        {view === 'day' && dayEvents.length === 0 && !meetingToday && (
          <div className="msched-empty">이 날 일정이 없어요 — 시간을 눌러 바로 추가할 수 있어요</div>
        )}

        {(!pop || pop.mode === 'view') && formEl}
      </div>

      {/* 애플식 이벤트 팝오버 — 상세(view) 또는 수정/생성 폼 */}
      {pop &&
        createPortal(
          <div
            className={`msched-pop ${pop.mode}`}
            ref={popRef}
            style={{
              left: Math.max(8, Math.min(pop.x - 160, window.innerWidth - 328)),
              top: Math.max(8, Math.min(pop.y + 8, window.innerHeight - (pop.mode === 'view' ? 230 : 430))),
            }}
          >
            {pop.mode === 'view' && popEv ? (
              <div className="msched-pop-view">
                <div className="msched-pop-title">
                  {popEv.is_call ? (
                    <span className="msched-call-ic">
                      <PhoneIcon size={13} />
                    </span>
                  ) : null}
                  {popEv.title}
                </div>
                <div className="msched-pop-time">
                  {popBase && popBase.end_date
                    ? // 여러 날 걸친 일정 — 원본 기준 기간 표시
                      `${dateLabelOf(popBase.date)}${popBase.time ? ` ${ampm(popBase.time)}` : ''} → ${dateLabelOf(popBase.end_date)}${popBase.end_time ? ` ${ampm(popBase.end_time)}` : ''}`
                    : popEv.time
                      ? `${dateLabelOf(popEv.date)} · ${ampmRange(popEv.time, popEv.end_time)}`
                      : `${dateLabelOf(popEv.date)} · 하루 종일`}
                </div>
                {popEv.time && (
                  <div className="msched-pop-remind">
                    <BellIcon size={12} /> {remindLabel(popEv.remind)}
                  </div>
                )}
                {popEv.recur && (
                  <div className="msched-pop-remind">
                    🔁 {EV_RECUR_LABEL[popEv.recur] ?? popEv.recur}
                    {popEv.recur_until
                      ? ` · ${popEv.recur_until.slice(5).replace('-', '/')}까지`
                      : ''}
                  </div>
                )}
                {(popEv.people?.length ?? 0) > 0 && (
                  <div className="msched-pop-ppl">
                    {popEv.people.map((p) => (
                      <span key={p.id} className="msched-event-person">
                        {p.name || dn(p.username)}
                      </span>
                    ))}
                  </div>
                )}
                {popEv.memo && <div className="msched-pop-memo">{popEv.memo}</div>}
                <div className="msched-pop-foot">
                  <span className="msched-pop-author">작성 {dn(popEv.author)}</span>
                  {popCanEdit && (
                    <span className="msched-pop-actions">
                      <button
                        type="button"
                        onClick={() => {
                          startEdit(popEv);
                          setPop({ ...pop, mode: 'edit' });
                        }}
                      >
                        수정
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          void removeEvent(popEv.id);
                          setPop(null);
                        }}
                      >
                        {popEv.recur ? '반복 전체 삭제' : '삭제'}
                      </button>
                    </span>
                  )}
                </div>
              </div>
            ) : (
              formEl
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
