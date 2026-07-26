import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api';
import NowBar, { type Todo, type Meeting } from '../components/NowBar';
import Logo from '../components/Logo';
import WorkspacePanel, { type MeetingTabRequest } from '../components/WorkspacePanel';
import { PhoneIcon, ChatIcon, CalendarIcon, GearIcon, HistoryIcon, PinIcon, HomeIcon, BuildingIcon, UsersIcon, ChevronIcon } from '../components/Icons';
import CreateMeetingModal from '../components/CreateMeetingModal';
import MeetingSettingsModal from '../components/MeetingSettingsModal';
import MeetingThumb from '../components/MeetingThumb';
import OrgSwitcher from '../components/OrgSwitcher';
import { useOrgStore } from '../orgStore';
import { readPins, PINS_EVENT } from '../lib/pins';
import { initPush } from '../lib/push';

export default function DashboardPage() {
  const location = useLocation();
  const orgCurrent = useOrgStore((s) => s.current);
  const orgs = useOrgStore((s) => s.orgs);
  // 모바일 상단 얇은 바 — 지금 어느 조직 컨텍스트인지
  const currentOrgName =
    orgCurrent === 'personal' ? null : orgs.find((o) => o.id === orgCurrent)?.name ?? null;
  // 가입 승인 대기 총합 — 레일의 전환 버튼을 없애서 배지를 상단 바가 대신 보여줌
  const totalPending = orgs.reduce((s, o) => s + o.pendingCount, 0);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('exist:sidebar') !== 'closed',
  );

  // 모바일 — 왼쪽 아이콘 레일 상시 고정. 홈↔그룹 이동은 레일 탭으로만
  // (대시보드에선 페이지 스와이프 없음 — 스와이프는 그룹 서브 화면 나가기 전용)

  // ── 태블릿(768~1023) — 사이드바(로고 포함)가 왼쪽 가장자리 스와이프로 나오는 드로어 ──
  const TABLET_MQ = '(min-width: 768px) and (max-width: 1023px)';
  const [tabletDrawer, setTabletDrawer] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(TABLET_MQ);
    const onChange = () => {
      if (!mq.matches) setTabletDrawer(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const tabSwipe = useRef<{ x: number; y: number; edge: boolean } | null>(null);
  function onTabPointerDown(e: React.PointerEvent) {
    if (!window.matchMedia(TABLET_MQ).matches) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 가로 제스처가 기능인 요소 위에선 무시 (탭바·채널·에디터류)
    const blocked = (e.target as Element).closest?.(
      '.hub-tabs, .hub-channels-list, .workspace-tabs, canvas, .cm-editor, [contenteditable="true"], ' +
        '.sheet-scroll, .slide-el, .doc-tools, .sheet-toolbar, .sheet-bar, .slide-bar, .vsc-tabbar, .slide-list',
    );
    tabSwipe.current = {
      x: e.clientX,
      y: e.clientY,
      // 화면 왼쪽 절반에서 시작한 →스와이프로 열기
      edge: !blocked && e.clientX < window.innerWidth / 2,
    };
  }
  /** 임계값을 넘는 즉시 발동 — pointerup을 기다리면 브라우저 스크롤 가로채기(pointercancel)에 씹힌다 */
  function onTabPointerMove(e: React.PointerEvent) {
    const s = tabSwipe.current;
    if (!s || !window.matchMedia(TABLET_MQ).matches) return;
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      tabSwipe.current = null;
      return;
    }
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    tabSwipe.current = null; // 한 제스처당 한 번만
    if (dx > 0 && s.edge && !tabletDrawer) setTabletDrawer(true);
    else if (dx < 0 && tabletDrawer) setTabletDrawer(false);
  }
  function onTabPointerEnd() {
    tabSwipe.current = null;
  }

  const [code, setCode] = useState('');
  const [addOpen, setAddOpen] = useState(false); // 모바일 — 그룹 추가 선택(만들기/참여)
  const [joinOpen, setJoinOpen] = useState(false); // 모바일 — 코드로 참여 모달
  const [recent, setRecent] = useState<Meeting[]>([]);
  const [schedule, setSchedule] = useState<Meeting[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  // 맨 위 고정한 그룹 id (기기별 — localStorage). 토글은 그룹 설정 화면(MeetingHub)에서.
  const [pinned, setPinned] = useState<number[]>(readPins);
  // 강퇴 등 라우팅으로 전달된 안내 메시지
  const message = (location.state as { message?: string } | null)?.message ?? '';

  // 회의 생성 모달 (schedMode = 일정 잡기로 진입)
  const [showCreate, setShowCreate] = useState(false);
  const [createSchedMode, setCreateSchedMode] = useState(false);

  // 아래 핸들러들은 memo(NowBar)에 props로 내려가므로 참조가 안정해야 함 (setter만 캡처)
  const openCreate = useCallback((schedMode = false) => {
    setCreateSchedMode(schedMode);
    setShowCreate(true);
  }, []);

  // 회의 탭 열기 요청 (우측 패널로 전달)
  const [meetingRequest, setMeetingRequest] = useState<MeetingTabRequest | null>(null);
  // nowbar가 띄울 회의 그룹 (최근회의 클릭 시 그 회의로 고정)
  const [focusedCode, setFocusedCode] = useState<string | null>(null);

  // 회의 설정 모달 (일정/설정 버튼)
  const [settingsMeeting, setSettingsMeeting] = useState<Meeting | null>(null);

  const openMeetingTab = useCallback((code: string, title: string, tab?: string) => {
    setMeetingRequest({ code, title, ts: Date.now(), tab });
    setFocusedCode(code); // nowbar가 이 회의 그룹을 띄우도록
    setTabletDrawer(false); // 태블릿 드로어: 그룹 고르면 닫기
  }, []);

  const toggleSidebar = useCallback(() => {
    // 태블릿에선 접기 대신 드로어 토글
    if (window.matchMedia(TABLET_MQ).matches) {
      setTabletDrawer((v) => !v);
      return;
    }
    setSidebarOpen((v) => {
      const next = !v;
      localStorage.setItem('exist:sidebar', next ? 'open' : 'closed');
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const param = useOrgStore.getState().contextParam();
      const [meetings, sched, todoList] = await Promise.all([
        api<Meeting[]>(`/api/meetings/recent?org=${param}`),
        api<Meeting[]>(`/api/meetings/schedule?org=${param}`),
        api<Todo[]>(`/api/todos?org=${param}`),
      ]);
      setRecent(meetings);
      setSchedule(sched);
      setTodos(todoList);
    } catch {
      /* 로그아웃 등으로 실패 시 무시 — 라우터 가드가 처리 */
    }
  }, []);

  // 최초 + 조직 컨텍스트 전환 시 회의 목록 갱신
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgCurrent]);

  // 웹푸시 구독 (PWA) — 로그인된 대시보드 진입 시 한 번
  useEffect(() => {
    void initPush();
  }, []);

  // 회의 일정 이벤트가 추가/삭제되면 nowbar 일정도 다시 불러오기
  useEffect(() => {
    function onChanged() {
      void refresh();
    }
    window.addEventListener('exist:schedule-changed', onChanged);
    return () => window.removeEventListener('exist:schedule-changed', onChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 그룹 설정 화면에서 고정 토글 시 사이드바 목록 즉시 반영
  useEffect(() => {
    const onPins = (e: Event) => setPinned((e as CustomEvent<number[]>).detail);
    window.addEventListener(PINS_EVENT, onPins);
    return () => window.removeEventListener(PINS_EVENT, onPins);
  }, []);

  // 알림의 "지금 들어가기" 등 → 회의(통화) 탭 열기
  useEffect(() => {
    function onOpen(e: Event) {
      const d = (e as CustomEvent<{ code: string; title?: string; tab?: string }>).detail;
      if (d?.code) openMeetingTab(d.code, d.title ?? d.code, d.tab);
    }
    function onNew() {
      openCreate(false);
    }
    window.addEventListener('exist:open-meeting', onOpen);
    window.addEventListener('exist:new-meeting', onNew);
    return () => {
      window.removeEventListener('exist:open-meeting', onOpen);
      window.removeEventListener('exist:new-meeting', onNew);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 초대 링크로 들어온 경우 — 그룹(/join/:code)은 자동 참여 후 열기, 조직(/join/org/:code)은 가입 신청
  useEffect(() => {
    const pending = sessionStorage.getItem('exist:pending-join');
    if (pending) {
      sessionStorage.removeItem('exist:pending-join');
      void (async () => {
        try {
          const m = await api<Meeting>('/api/meetings/join', { method: 'POST', body: { code: pending } });
          openMeetingTab(m.code, m.title);
          void refresh();
        } catch {
          /* 잘못된 코드 등 — 전역 에러 토스트가 표시 */
        }
      })();
    }
    const pendingOrg = sessionStorage.getItem('exist:pending-join-org');
    if (pendingOrg) {
      sessionStorage.removeItem('exist:pending-join-org');
      void (async () => {
        try {
          const r = await api<{ orgName: string }>('/api/orgs/join', {
            method: 'POST',
            body: { joinCode: pendingOrg },
          });
          window.dispatchEvent(
            new CustomEvent('app:info', {
              detail: `${r.orgName} 가입 신청 완료 — 관리자가 승인하면 들어갈 수 있어요`,
            }),
          );
          void useOrgStore.getState().load();
        } catch {
          /* 이미 멤버·잘못된 코드 등 — 전역 에러 토스트가 표시 */
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function joinMeeting(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    try {
      const m = await api<Meeting>('/api/meetings/join', { method: 'POST', body: { code } });
      openMeetingTab(m.code, m.title);
      setCode('');
      setJoinOpen(false);
      void refresh();
    } catch {
      /* 전역 에러 토스트가 표시 */
    }
  }

  const toggleTodo = useCallback(
    async (todo: Todo) => {
      await api(`/api/todos/${todo.id}`, { method: 'PATCH', body: { done: !todo.done } });
      void refresh();
    },
    [refresh],
  );

  const addTodo = useCallback(
    async (title: string) => {
      await api('/api/todos', { method: 'POST', body: { title } });
      void refresh();
    },
    [refresh],
  );

  const onOpenMeetingFromBar = useCallback(
    (m: Meeting) => openMeetingTab(m.code, m.title),
    [openMeetingTab],
  );
  const onScheduleFromBar = useCallback(() => openCreate(true), [openCreate]);

  // nowbar 그룹 = 최근 회의 ∪ 일정(occurrence/이벤트)이 있는 회의.
  // 최근 목록에서 밀려난 회의라도 예정 일정이 있으면 nowbar가 띄울 수 있게 합친다.
  const nowbarGroups = useMemo(() => {
    const byId = new Map<number, Meeting>();
    for (const m of recent) byId.set(m.id, m);
    for (const s of schedule) {
      if (byId.has(s.id)) continue;
      byId.set(s.id, {
        id: s.id,
        code: s.code,
        title: s.meetingTitle ?? s.title,
        thumbnail: s.thumbnail ?? null,
        starts_at: s.starts_at,
        ends_at: s.ends_at,
        recur: s.recur,
      });
    }
    return [...byId.values()];
  }, [recent, schedule]);

  // 사이드바 "최근 그룹" 정렬: ① 고정 ② 임박 일정(미래 가까운 순) ③ 최근순
  const sortedGroups = useMemo(() => {
    const now = Date.now();
    const nextStart = new Map<number, number>();
    for (const m of nowbarGroups) {
      if (!m.starts_at) continue;
      const t = Date.parse(m.starts_at);
      if (Number.isNaN(t) || t < now) continue; // 미래 일정만
      const prev = nextStart.get(m.id);
      if (prev == null || t < prev) nextStart.set(m.id, t);
    }
    const pinnedSet = new Set(pinned);
    const rank = (m: Meeting) => (pinnedSet.has(m.id) ? 0 : nextStart.has(m.id) ? 1 : 2);
    return [...nowbarGroups]
      .sort((a, b) => {
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        if (ra === 1) return (nextStart.get(a.id) ?? 0) - (nextStart.get(b.id) ?? 0);
        return 0;
      })
      .map((m) => ({ meeting: m, isPinned: pinnedSet.has(m.id), nextStart: nextStart.get(m.id) ?? null }));
  }, [nowbarGroups, pinned]);

  return (
    <>
      <NowBar
        todos={todos}
        meetings={schedule}
        groups={nowbarGroups}
        focusedCode={focusedCode}
        onToggleTodo={toggleTodo}
        onAddTodo={addTodo}
        onOpenMeeting={onOpenMeetingFromBar}
        onSchedule={onScheduleFromBar}
        onToggleSidebar={toggleSidebar}
      />
      <main
        className={`dashboard${sidebarOpen ? '' : ' collapsed'}${tabletDrawer ? ' t-open' : ''}`}
        onPointerDown={onTabPointerDown}
        onPointerMove={onTabPointerMove}
        onPointerUp={onTabPointerEnd}
        onPointerCancel={onTabPointerEnd}
      >
        <aside>
          {/* 태블릿 드로어 상단 로고 (모바일·데스크톱에선 숨김 — 데스크톱은 헤더에 있음) */}
          <div className="drawer-logo">
            <Logo />
          </div>
          {/* 모바일 전용 — 탭바가 없어서 드로어에서 홈으로 이동 */}
          <button
            className="drawer-home"
            onClick={() => window.dispatchEvent(new Event('exist:go-home'))}
          >
            <HomeIcon size={20} />
            <span className="drawer-home-label">홈 대시보드</span>
          </button>

          <OrgSwitcher />

          <div className="join-card">
            <div className="head">
              <h2>그룹 입장</h2>
              <button className="new-btn" onClick={() => openCreate(false)} title="새 그룹 만들기">
                +
              </button>
            </div>
            <form onSubmit={joinMeeting}>
              <input
                placeholder="그룹 코드"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button type="submit" className="join-btn">
                참여
              </button>
            </form>
          </div>

          <div className="section-title">
            <HistoryIcon size={21} /> 최근 그룹
          </div>
          <div className="recent-list">
            {sortedGroups.map(({ meeting: m, isPinned }) => (
              <div
                key={m.id}
                className={`recent-card clickable${isPinned ? ' pinned' : ''}`}
                onClick={() => openMeetingTab(m.code, m.title)}
                title="클릭하면 옆 탭에서 그룹이 열려요"
              >
                <MeetingThumb id={m.id} title={m.title} thumbnail={m.thumbnail} className="thumb" />
                <div>
                  <div className="name">
                    {m.title}
                    {isPinned && <PinIcon size={17} />}
                  </div>
                  <div className="actions" onClick={(e) => e.stopPropagation()}>
                    <button title="통화" onClick={() => openMeetingTab(m.code, m.title, 'call')}>
                      <PhoneIcon size={17} />
                    </button>
                    <button title="채팅" onClick={() => openMeetingTab(m.code, m.title, 'chat')}>
                      <ChatIcon size={17} />
                    </button>
                    <button title="일정" onClick={() => openMeetingTab(m.code, m.title, 'schedule')}>
                      <CalendarIcon size={17} />
                    </button>
                    <button title="설정" onClick={() => openMeetingTab(m.code, m.title, 'settings')}>
                      <GearIcon size={17} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {sortedGroups.length === 0 && (
              <div className="recent-card recent-empty">
                <div>아직 그룹이 없어요. + 버튼으로 만들어보세요.</div>
              </div>
            )}
          </div>

          {/* 모바일 레일 전용 — + 하나로 만들기/코드 참여 선택 (데스크톱은 그룹 입장 카드) */}
          <button className="drawer-add" onClick={() => setAddOpen(true)} title="그룹 추가">
            +
          </button>

        </aside>

        {/* 모바일 — 그룹 추가 선택 (만들기 / 코드로 참여) */}
        {addOpen && (
          <div className="modal-overlay" onClick={() => setAddOpen(false)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">그룹 추가</div>
              <button
                className="add-choice"
                onClick={() => {
                  setAddOpen(false);
                  openCreate(false);
                }}
              >
                <span className="add-choice-icon">+</span>
                <span>
                  <b>새 그룹 만들기</b>
                  <small>팀·프로젝트 그룹을 새로 시작해요</small>
                </span>
              </button>
              <button
                className="add-choice"
                onClick={() => {
                  setAddOpen(false);
                  setJoinOpen(true);
                }}
              >
                <span className="add-choice-icon">#</span>
                <span>
                  <b>코드로 참여</b>
                  <small>받은 그룹 코드를 입력해 들어가요</small>
                </span>
              </button>
            </div>
          </div>
        )}

        {/* 모바일 — 그룹 코드로 참여 모달 */}
        {joinOpen && (
          <div className="modal-overlay" onClick={() => setJoinOpen(false)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head">그룹 코드로 참여</div>
              <form onSubmit={joinMeeting}>
                <label className="modal-label">
                  그룹 코드
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="예: 66J78C"
                    autoFocus
                  />
                </label>
                <div className="modal-actions">
                  <button type="button" className="modal-cancel" onClick={() => setJoinOpen(false)}>
                    취소
                  </button>
                  <button type="submit" className="modal-primary">
                    참여
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* 모바일 전용 — 상단 얇은 조직 컨텍스트 바 (탭하면 조직 전환 메뉴) */}
        <button
          className="m-orgbar"
          onClick={() => window.dispatchEvent(new Event('exist:open-org-menu'))}
        >
          {currentOrgName ? <BuildingIcon size={12} /> : <UsersIcon size={12} />}
          <span className="m-orgbar-name">{currentOrgName ?? '개인'}</span>
          {totalPending > 0 && <span className="m-orgbar-badge">{totalPending}</span>}
          <ChevronIcon size={11} />
        </button>

        <div className="workspace-col">
          {message && <div className="dash-message">{message}</div>}
          <WorkspacePanel meetingRequest={meetingRequest} />
        </div>

        {/* 태블릿 드로어 스크림 — 탭하면 닫힘 */}
        {tabletDrawer && (
          <button className="t-scrim" aria-label="사이드바 닫기" onClick={() => setTabletDrawer(false)} />
        )}
      </main>

      <CreateMeetingModal
        open={showCreate}
        defaultSchedule={createSchedMode}
        onClose={() => setShowCreate(false)}
        onCreated={() => void refresh()}
      />

      <MeetingSettingsModal
        meeting={settingsMeeting}
        onClose={() => setSettingsMeeting(null)}
        onChanged={() => void refresh()}
      />
    </>
  );
}
