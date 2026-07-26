import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
// (MeetingHub는 memo — 아래 expandHandlers처럼 props 참조가 안정해야 스킵이 먹힌다)
import { api } from '../api';
import { useAuthStore } from '../store';
import { useOrgStore, type OrgContext } from '../orgStore';
import { FolderIcon, UsersIcon, CloseIcon, HomeIcon } from './Icons';
import CanvasBoard from './CanvasBoard';
import MeetingHub from './MeetingHub';
import ProfileDashboard from './ProfileDashboard';

interface Workspace {
  id: number;
  name: string;
}

export interface MeetingTabRequest {
  code: string;
  title: string;
  ts: number; // 같은 회의 재클릭도 감지
  tab?: string; // 열 때 이동할 세부 탭 (call/chat/schedule 등)
}

type ActiveTab = { kind: 'ws'; id: number } | { kind: 'meeting'; code: string };

interface Props {
  /** 최근 회의 클릭 → 회의 탭 열기 요청 */
  meetingRequest?: MeetingTabRequest | null;
}

function tabsKey() {
  return `exist:meeting-tabs:${useAuthStore.getState().user?.username ?? ''}`;
}

function loadSavedTabs(): { code: string; title: string }[] {
  try {
    const raw = localStorage.getItem(tabsKey());
    const parsed = raw ? (JSON.parse(raw) as { code: string; title: string }[]) : [];
    return Array.isArray(parsed) ? parsed.filter((t) => t?.code && t?.title) : [];
  } catch {
    return [];
  }
}

function WorkspacePanel({ meetingRequest }: Props) {
  const orgCurrent = useOrgStore((s) => s.current);
  const setOrgCurrent = useOrgStore((s) => s.setCurrent);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // 새로고침해도 열린 회의 탭 복원
  const [meetingTabs, setMeetingTabs] = useState<{ code: string; title: string }[]>(loadSavedTabs);
  // 회의별 소속 조직 (id=필터용, name=배지용) — MeetingHub가 상세 로드 시 알려줌
  const [tabMeta, setTabMeta] = useState<Record<string, { orgId: number | null; orgName: string | null }>>(
    {},
  );
  const [active, setActive] = useState<ActiveTab | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null); // 오버레이 전체화면 회의 코드

  // 전체화면 동안 body 클래스 — 모바일은 스와이프 레이어 transform이 fixed를 가둬
  // 오버레이가 nowbar를 못 덮으므로, CSS에서 nowbar 자체를 숨기는 용도
  useEffect(() => {
    document.body.classList.toggle('call-fullscreen', expanded != null);
    return () => document.body.classList.remove('call-fullscreen');
  }, [expanded]);
  // 탭별 확대 토글 콜백 — 매 렌더 새 함수를 만들면 memo(MeetingHub)가 무력화돼 캐시
  const expandHandlers = useRef(new Map<string, () => void>());
  const toggleExpandFor = (code: string) => {
    let h = expandHandlers.current.get(code);
    if (!h) {
      h = () => setExpanded((cur) => (cur === code ? null : code));
      expandHandlers.current.set(code, h);
    }
    return h;
  };
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  const [dragCode, setDragCode] = useState<string | null>(null); // 드래그 중인 회의 탭
  // 방금 연 회의 — 조직이 파악되면 그 조직으로 컨텍스트 전환 (한 번만)
  const justOpened = useRef<string | null>(null);
  // FLIP 애니메이션용 — 회의 탭 DOM + 직전 위치
  const tabRefs = useRef<Map<string, HTMLElement>>(new Map());
  const prevRects = useRef<Map<string, DOMRect>>(new Map());

  // 탭 순서가 바뀌면 각 탭을 직전 위치에서 새 위치로 부드럽게 슬라이드 (크롬 탭 방식)
  useLayoutEffect(() => {
    const refs = tabRefs.current;
    const newRects = new Map<string, DOMRect>();
    refs.forEach((el, code) => {
      el.style.transition = 'none';
      el.style.transform = '';
      newRects.set(code, el.getBoundingClientRect());
    });
    refs.forEach((el, code) => {
      if (code === dragCode) return; // 드래그 중인 탭은 그대로
      const prev = prevRects.current.get(code);
      const next = newRects.get(code);
      if (!prev || !next) return;
      const dx = prev.left - next.left;
      if (Math.abs(dx) < 1) return;
      el.style.transform = `translateX(${dx}px)`;
      requestAnimationFrame(() => {
        el.style.transition = 'transform 0.2s cubic-bezier(.2,.7,.3,1)';
        el.style.transform = '';
      });
    });
    prevRects.current = newRects;
  });

  /** 회의 탭 이동 (드래그) — fromCode를 toCode의 앞/뒤로 삽입.
   *  순서가 실제로 바뀔 때만 갱신(같은 위치 반복 호출은 무시 → 진동 방지) */
  function moveTab(fromCode: string, toCode: string, after: boolean) {
    if (fromCode === toCode) return;
    setMeetingTabs((prev) => {
      const arr = [...prev];
      const fi = arr.findIndex((t) => t.code === fromCode);
      if (fi < 0) return prev;
      const [moved] = arr.splice(fi, 1);
      const ti = arr.findIndex((t) => t.code === toCode);
      if (ti < 0) return prev;
      arr.splice(after ? ti + 1 : ti, 0, moved);
      // 순서가 그대로면 원본 유지 (불필요 리렌더·진동 방지)
      if (arr.length === prev.length && arr.every((t, i) => t.code === prev[i].code)) return prev;
      return arr;
    });
  }

  /** 탭이 현재 조직 컨텍스트에 보여야 하는가 (org 미파악 탭은 일단 보임) */
  function tabVisible(code: string): boolean {
    const meta = tabMeta[code];
    if (!meta) return true;
    return orgCurrent === 'personal' ? meta.orgId == null : meta.orgId === orgCurrent;
  }

  // 열린 회의 탭 영속화
  useEffect(() => {
    try {
      localStorage.setItem(tabsKey(), JSON.stringify(meetingTabs));
    } catch {
      /* 저장 실패 무시 */
    }
  }, [meetingTabs]);

  // 회의 상세에서 조직 정보 수신 → 탭 메타(배지·필터)
  useEffect(() => {
    function onOrg(e: Event) {
      const { code, orgId, orgName } = (
        e as CustomEvent<{ code: string; orgId: number | null; orgName: string | null }>
      ).detail;
      setTabMeta((prev) => {
        const cur = prev[code];
        if (cur && cur.orgId === (orgId ?? null) && cur.orgName === (orgName ?? null)) return prev;
        return { ...prev, [code]: { orgId: orgId ?? null, orgName: orgName ?? null } };
      });
      // 방금 연 회의면 그 회의 조직으로 컨텍스트 전환 (다른 조직 회의를 코드로 열어도 따라감)
      if (justOpened.current === code) {
        justOpened.current = null;
        setOrgCurrent((orgId ?? 'personal') as OrgContext);
      }
    }
    window.addEventListener('meeting:org', onOrg);
    return () => window.removeEventListener('meeting:org', onOrg);
  }, [setOrgCurrent]);

  // 회의 채팅 수신 → 비활성 탭이면 안읽음 배지
  useEffect(() => {
    function onMsg(e: Event) {
      const { code } = (e as CustomEvent<{ code: string }>).detail;
      setActive((cur) => {
        if (!(cur?.kind === 'meeting' && cur.code === code)) {
          setUnread((prev) => {
            const next = new Map(prev);
            next.set(code, (next.get(code) ?? 0) + 1);
            return next;
          });
        }
        return cur;
      });
    }
    window.addEventListener('meeting:message', onMsg);
    return () => window.removeEventListener('meeting:message', onMsg);
  }, []);

  // 회의가 삭제되면 열려있던 탭도 닫기
  useEffect(() => {
    function onDeleted(e: Event) {
      const code = (e as CustomEvent<{ code: string }>).detail?.code;
      if (code) closeMeetingTab(code);
    }
    window.addEventListener('exist:meeting-deleted', onDeleted);
    return () => window.removeEventListener('exist:meeting-deleted', onDeleted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces.length]);

  // 모바일 — 탭바가 없어서 드로어의 홈 버튼이 이 이벤트로 홈 전환
  useEffect(() => {
    function onHome() {
      setActive(null);
    }
    window.addEventListener('exist:go-home', onHome);
    return () => window.removeEventListener('exist:go-home', onHome);
  }, []);

  // ESC로 전체화면 축소
  useEffect(() => {
    if (!expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setExpanded(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  async function refresh(initial = false) {
    const ctx = useOrgStore.getState().contextParam();
    const list = await api<Workspace[]>(`/api/workspaces?ctx=${ctx}`);
    setWorkspaces(list);
    setActive((cur) => {
      // 첫 로드만 첫 작업공간 자동 선택 — 이후의 null은 홈 탭이므로 유지
      if (cur === null) return initial && list.length > 0 ? { kind: 'ws', id: list[0].id } : null;
      // 컨텍스트가 바뀌어 활성 작업공간이 목록에서 사라졌으면 보이는 것으로 이동
      if (cur.kind === 'ws' && !list.some((w) => w.id === cur.id))
        return list.length > 0 ? { kind: 'ws', id: list[0].id } : null;
      return cur;
    });
  }

  const didInitWs = useRef(false);
  useEffect(() => {
    const initial = !didInitWs.current;
    didInitWs.current = true;
    void refresh(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgCurrent]);

  // 회의 탭 열기 요청 처리
  useEffect(() => {
    if (!meetingRequest) return;
    setMeetingTabs((prev) =>
      prev.some((t) => t.code === meetingRequest.code)
        ? prev
        : [...prev, { code: meetingRequest.code, title: meetingRequest.title }],
    );
    setActive({ kind: 'meeting', code: meetingRequest.code });
    // 조직을 모르면 meeting:org 수신 시 컨텍스트 전환하도록 표시
    if (!tabMeta[meetingRequest.code]) justOpened.current = meetingRequest.code;
    else setOrgCurrent((tabMeta[meetingRequest.code].orgId ?? 'personal') as OrgContext);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingRequest?.ts]);

  // 조직 컨텍스트가 바뀌어 현재 활성 회의 탭이 숨겨지면 → 보이는 탭/작업공간으로 이동
  useEffect(() => {
    if (active?.kind !== 'meeting') return;
    if (tabVisible(active.code)) return;
    const firstVisible = meetingTabs.find((t) => tabVisible(t.code));
    setActive(
      firstVisible
        ? { kind: 'meeting', code: firstVisible.code }
        : workspaces.length > 0
          ? { kind: 'ws', id: workspaces[0].id }
          : null,
    );
    setExpanded((cur) => (cur && !tabVisible(cur) ? null : cur));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgCurrent, tabMeta]);

  function closeMeetingTab(code: string, message?: string) {
    setMeetingTabs((prev) => prev.filter((t) => t.code !== code));
    setExpanded((cur) => (cur === code ? null : cur));
    setActive((cur) =>
      cur?.kind === 'meeting' && cur.code === code
        ? workspaces.length > 0
          ? { kind: 'ws', id: workspaces[0].id }
          : null
        : cur,
    );
    if (message) window.dispatchEvent(new CustomEvent('app:error', { detail: message }));
  }

  async function renameWorkspace(e: React.FormEvent) {
    e.preventDefault();
    if (renaming === null || !renameValue.trim()) return setRenaming(null);
    await api(`/api/workspaces/${renaming}`, { method: 'PATCH', body: { name: renameValue } });
    setRenaming(null);
    await refresh();
  }

  async function deleteWorkspace(id: number) {
    if (!window.confirm('작업공간을 삭제할까요? 캔버스 내용은 서버에 보존돼요.')) return;
    await api(`/api/workspaces/${id}`, { method: 'DELETE' });
    setActive((cur) => (cur?.kind === 'ws' && cur.id === id ? null : cur));
    const list = await api<Workspace[]>(
      `/api/workspaces?ctx=${useOrgStore.getState().contextParam()}`,
    );
    setWorkspaces(list);
    setActive((cur) => cur ?? (list.length > 0 ? { kind: 'ws', id: list[0].id } : null));
  }

  const activeWs = active?.kind === 'ws' ? active.id : null;

  return (
    <section className="workspace-panel">
      <div className="workspace-tabs">
        <button
          className={`ws-tab home${active === null ? ' active' : ''}${orgCurrent !== 'personal' ? ' org' : ''}`}
          onClick={() => setActive(null)}
          title="홈 — 내 대시보드"
          style={{ lineHeight: 0, alignSelf: 'stretch', justifyContent: 'center' }}
        >
          <HomeIcon size={18} />
        </button>
        {workspaces.map((ws) =>
          renaming === ws.id ? (
            <form key={ws.id} className="ws-create" onSubmit={renameWorkspace}>
              <input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={renameWorkspace}
                autoFocus
              />
            </form>
          ) : (
            <button
              key={ws.id}
              className={`ws-tab${activeWs === ws.id ? ' active' : ''}`}
              onClick={() => setActive({ kind: 'ws', id: ws.id })}
              onDoubleClick={() => {
                setRenaming(ws.id);
                setRenameValue(ws.name);
              }}
              title="더블클릭으로 이름 변경"
            >
              <FolderIcon size={16} /> {ws.name}
              <span
                className="tab-close"
                title="작업공간 삭제"
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteWorkspace(ws.id);
                }}
              >
                <CloseIcon size={12} />
              </span>
            </button>
          ),
        )}
        {/* 현재 조직 컨텍스트의 회의 탭만 표시 — 드래그로 순서 변경 가능 */}
        {meetingTabs.filter((t) => tabVisible(t.code)).map((t) => (
          <button
            key={t.code}
            ref={(el) => {
              if (el) tabRefs.current.set(t.code, el);
              else tabRefs.current.delete(t.code);
            }}
            className={`ws-tab meeting${
              active?.kind === 'meeting' && active.code === t.code ? ' active' : ''
            }${dragCode === t.code ? ' dragging' : ''}`}
            draggable
            onDragStart={(e) => {
              setDragCode(t.code);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              // 마우스가 대상 탭 중앙을 넘었을 때만 그 앞/뒤로 이동 (진동 방지)
              if (!dragCode || dragCode === t.code) return;
              const rect = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > rect.left + rect.width / 2;
              moveTab(dragCode, t.code, after);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragCode(null);
            }}
            onDragEnd={() => setDragCode(null)}
            onClick={() => {
              setActive({ kind: 'meeting', code: t.code });
              setUnread((prev) => {
                const next = new Map(prev);
                next.delete(t.code);
                return next;
              });
            }}
          >
            {(unread.get(t.code) ?? 0) > 0 && (
              <span className="tab-badge">{unread.get(t.code)}</span>
            )}
            <UsersIcon size={15} />
            <span className="ws-tab-text">
              {tabMeta[t.code]?.orgName && (
                <span className="ws-tab-org">{tabMeta[t.code].orgName}</span>
              )}
              {t.title}
            </span>
            <span
              className="tab-close"
              title="그룹 나가기"
              onClick={(e) => {
                e.stopPropagation();
                closeMeetingTab(t.code);
              }}
            >
              <CloseIcon size={12} />
            </span>
          </button>
        ))}
      </div>

      <div className="workspace-canvas">
        {activeWs !== null && <CanvasBoard key={activeWs} roomId={`ws-${activeWs}`} />}

        {/* 회의 탭은 비활성이어도 마운트 유지 (연결 보존) — display로만 전환,
            확대 시 fixed 오버레이로 승격 (리마운트 없음 = 끊김 없음) */}
        {meetingTabs.map((t) => {
          const isActive = active?.kind === 'meeting' && active.code === t.code;
          const isExpanded = expanded === t.code;
          return (
            <div
              key={t.code}
              className={`meeting-tab-host${isExpanded ? ' fullscreen' : ''}`}
              style={{ display: isActive || isExpanded ? 'block' : 'none' }}
            >
              <MeetingHub
                code={t.code}
                expanded={isExpanded}
                visible={isActive || isExpanded}
                onToggleExpand={toggleExpandFor(t.code)}
                gotoTab={
                  meetingRequest && meetingRequest.code === t.code && meetingRequest.tab
                    ? { tab: meetingRequest.tab, ts: meetingRequest.ts }
                    : undefined
                }
              />
            </div>
          );
        })}

        {active === null && <ProfileDashboard />}
      </div>
    </section>
  );
}

// 사이드바 정렬(고정 토글 등)로 대시보드가 리렌더돼도 워크스페이스 전체는 스킵
export default memo(WorkspacePanel);
