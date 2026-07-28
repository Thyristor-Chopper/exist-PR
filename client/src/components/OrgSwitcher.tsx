import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrgStore, type OrgContext } from '../orgStore';
import { BuildingIcon, ChevronIcon, PlusIcon, UsersIcon, CheckMarkIcon } from './Icons';
import CreateOrgModal from './CreateOrgModal';
import JoinOrgModal from './JoinOrgModal';

/** 상단 조직 전환기 — 현재 컨텍스트(개인/조직) 선택 + 생성·가입·멤버관리 진입 */
export default function OrgSwitcher() {
  const orgs = useOrgStore((s) => s.orgs);
  const current = useOrgStore((s) => s.current);
  const setCurrent = useOrgStore((s) => s.setCurrent);
  const load = useOrgStore((s) => s.load);

  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void load();
  }, [load]);

  // 모바일 상단 조직 바에서 메뉴 열기
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('exist:open-org-menu', onOpen);
    return () => window.removeEventListener('exist:open-org-menu', onOpen);
  }, []);

  // 바깥 클릭 닫기
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const currentOrg = current === 'personal' ? null : orgs.find((o) => o.id === current);
  const label = currentOrg?.name ?? '개인';
  const totalPending = orgs.reduce((s, o) => s + o.pendingCount, 0);

  function choose(ctx: OrgContext) {
    setCurrent(ctx);
    setOpen(false);
  }

  return (
    <div className="org-switcher" ref={ref}>
      <button className="org-switcher-btn" onClick={() => setOpen((v) => !v)}>
        <span className="org-switcher-icon">
          {currentOrg ? <BuildingIcon size={16} /> : <UsersIcon size={16} />}
        </span>
        <span className="org-switcher-name">{label}</span>
        {totalPending > 0 && <span className="org-switcher-badge">{totalPending}</span>}
        <ChevronIcon size={15} />
      </button>

      {/* 모바일 — 메뉴가 중앙 팝업이라 뒤를 덮는 스크림 (데스크톱은 CSS로 숨김) */}
      {open && (
        <button className="org-menu-scrim" aria-label="닫기" onClick={() => setOpen(false)} />
      )}
      {open && (
        <div className="org-menu">
          <div className="org-menu-section">
            <button
              className={`org-menu-item${current === 'personal' ? ' active' : ''}`}
              onClick={() => choose('personal')}
            >
              <span className="org-switcher-icon">
                <UsersIcon size={15} />
              </span>
              개인
              {current === 'personal' && <span className="org-check"><CheckMarkIcon size={13} /></span>}
            </button>
            {orgs.map((o) => (
              <button
                key={o.id}
                className={`org-menu-item${current === o.id ? ' active' : ''}`}
                onClick={() => choose(o.id)}
              >
                <span className="org-switcher-icon">
                  <BuildingIcon size={15} />
                </span>
                <span className="org-menu-item-name">{o.name}</span>
                {o.isManager && o.pendingCount > 0 && (
                  <span className="org-switcher-badge sm">{o.pendingCount}</span>
                )}
                <span
                  className="org-menu-manage"
                  title="조직도 보기"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    navigate(`/org/${o.id}`);
                  }}
                >
                  <UsersIcon size={14} />
                </span>
                {current === o.id && <span className="org-check"><CheckMarkIcon size={13} /></span>}
              </button>
            ))}
          </div>

          <div className="org-menu-divider" />

          <button
            className="org-menu-item action"
            onClick={() => {
              setShowCreate(true);
              setOpen(false);
            }}
          >
            <span className="org-switcher-icon">
              <PlusIcon size={15} />
            </span>
            조직 만들기
          </button>
          <button
            className="org-menu-item action"
            onClick={() => {
              setShowJoin(true);
              setOpen(false);
            }}
          >
            <span className="org-switcher-icon">
              <BuildingIcon size={15} />
            </span>
            조직 가입하기
          </button>
        </div>
      )}

      <CreateOrgModal open={showCreate} onClose={() => setShowCreate(false)} />
      <JoinOrgModal open={showJoin} onClose={() => setShowJoin(false)} />
    </div>
  );
}
