import { useEffect, useRef, useState, type ComponentType } from 'react';
import { api } from '../api';
import { useOrgStore } from '../orgStore';
import {
  CheckMarkIcon,
  ChatIcon,
  CalendarIcon,
  FolderIcon,
  ListIcon,
  UsersIcon,
  CloseIcon,
  SearchIcon,
} from './Icons';

/*
 * 전역 검색 (Ctrl+K) — 채팅·결정·할 일·파일·일정·그룹을 한 창에서.
 * "기록이 조직에 남는다"의 회수 경로: 남긴 걸 못 찾으면 안 남긴 것과 같다.
 * 결과 클릭 = 해당 그룹의 해당 탭으로 이동. 현재 워크스페이스(개인/조직) 스코프.
 */

interface Hit {
  text: string;
  sub?: string | null;
  code: string | null;
  title?: string | null;
  done?: number;
}

interface SearchRes {
  groups: { code: string; title: string }[];
  messages: Hit[];
  decisions: Hit[];
  todos: Hit[];
  files: Hit[];
  events: Hit[];
}

export default function GlobalSearch() {
  const org = useOrgStore((s) => s.current);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchRes | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('exist:open-search', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('exist:open-search', onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setQ('');
      setRes(null);
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [open]);

  // 220ms 디바운스 조회 — 스코프는 현재 탭(개인/조직)을 따라감
  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    const t = q.trim();
    if (!t) {
      setRes(null);
      return;
    }
    timer.current = setTimeout(() => {
      setLoading(true);
      const orgQ = org === 'personal' ? 'personal' : String(org);
      api<SearchRes>(`/api/agent/search?q=${encodeURIComponent(t)}&org=${orgQ}`)
        .then(setRes)
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 220);
  }, [q, open, org]);

  if (!open) return null;

  const go = (code: string | null, title?: string | null, tab?: string) => {
    setOpen(false);
    if (code)
      window.dispatchEvent(
        new CustomEvent('exist:open-meeting', { detail: { code, title: title ?? code, tab } }),
      );
  };

  const total = res
    ? res.groups.length +
      res.messages.length +
      res.decisions.length +
      res.todos.length +
      res.files.length +
      res.events.length
    : 0;

  function section(
    label: string,
    Icon: ComponentType<{ size?: number }>,
    hits: Hit[],
    onPick: (h: Hit) => void,
  ) {
    if (hits.length === 0) return null;
    return (
      <div className="gs-sec">
        <div className="gs-sec-head">
          <Icon size={13} /> {label}
        </div>
        {hits.map((h, i) => (
          <button key={i} className="gs-hit" onClick={() => onPick(h)}>
            <span className="gs-hit-text">{h.text}</span>
            <span className="gs-hit-sub">
              {h.sub ? `${h.sub} · ` : ''}
              {h.title ?? (h.code ? h.code : '개인')}
            </span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="gs-overlay" onClick={() => setOpen(false)}>
      <div className="gs-box" role="dialog" aria-label="전역 검색" onClick={(e) => e.stopPropagation()}>
        <div className="gs-head">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            className="gs-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="채팅·결정·할 일·파일·일정 검색"
          />
          <button className="gs-close" onClick={() => setOpen(false)} title="닫기 (Esc)">
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="gs-body">
          {!q.trim() ? (
            <div className="gs-empty">이 워크스페이스의 모든 기록에서 찾아요</div>
          ) : loading && !res ? (
            <div className="gs-empty">찾는 중…</div>
          ) : res && total === 0 ? (
            <div className="gs-empty">"{q}" 결과가 없어요</div>
          ) : res ? (
            <>
              {section(
                '그룹',
                UsersIcon,
                res.groups.map((g) => ({ text: g.title, code: g.code, title: g.title })),
                (h) => go(h.code, h.text),
              )}
              {section('결정', CheckMarkIcon, res.decisions, (h) => go(h.code, h.title, 'decisions'))}
              {section('채팅', ChatIcon, res.messages, (h) => go(h.code, h.title, 'chat'))}
              {section('할 일', ListIcon, res.todos, (h) => go(h.code, h.title))}
              {section('파일', FolderIcon, res.files, (h) => go(h.code, h.title, 'files'))}
              {section('일정', CalendarIcon, res.events, (h) => go(h.code, h.title, 'schedule'))}
            </>
          ) : null}
        </div>
        <div className="gs-hint">
          <b>Ctrl</b>+<b>K</b>로 언제든 열 수 있어요
        </div>
      </div>
    </div>
  );
}
