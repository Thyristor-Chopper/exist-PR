import { useEffect, useRef, useState } from 'react';
import { useDisplayName } from '../names';
import Avatar from './Avatar';

/*
 * 채팅 @멘션 자동완성 — 카카오톡식.
 * 입력 중 캐럿 앞이 "@…" 토큰이면 후보 팝업이 입력창 위로 뜨고,
 * ↑↓로 고르고 Enter/Tab/클릭으로 "@이름 "을 삽입한다. Enter는 팝업이 열려 있을 때만
 * 가로채므로 (preventDefault) 평소 전송 동작은 그대로다.
 */

export interface MentionCandidate {
  username: string;
  avatar: string | null;
  /** 부가 정보 한 줄 (직급 · 부서 등) */
  sub?: string | null;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  candidates: MentionCandidate[];
  placeholder?: string;
  autoFocus?: boolean;
}

/** 캐럿 앞의 @토큰 — 없으면 null */
function tokenAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const m = before.match(/(^|\s)@([\w가-힣.-]*)$/);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

export default function MentionInput({
  value,
  onChange,
  candidates,
  placeholder,
  autoFocus,
}: Props) {
  const dn = useDisplayName();
  const inputRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  const [sel, setSel] = useState(0);

  const q = token?.query.toLowerCase() ?? '';
  const hits = token
    ? candidates
        .filter(
          (c) => c.username.toLowerCase().includes(q) || dn(c.username).toLowerCase().includes(q),
        )
        .slice(0, 8)
    : [];
  const open = hits.length > 0;

  // 후보가 줄어들면 선택이 목록 밖으로 나가지 않게
  useEffect(() => {
    if (sel >= hits.length) setSel(0);
  }, [hits.length, sel]);

  function syncToken() {
    const el = inputRef.current;
    if (!el) return;
    const t = tokenAt(el.value, el.selectionStart ?? el.value.length);
    setToken((prev) => {
      if (!!prev !== !!t || prev?.start !== t?.start || prev?.query !== t?.query) {
        if (!prev || !t || prev.start !== t.start) setSel(0);
        return t;
      }
      return prev;
    });
  }

  function pick(c: MentionCandidate) {
    if (!token) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? value.length;
    const next = `${value.slice(0, token.start)}@${c.username} ${value.slice(caret)}`;
    onChange(next);
    setToken(null);
    // 삽입 뒤 캐럿을 멘션 뒤 공백 다음으로
    const pos = token.start + c.username.length + 2;
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => (s + 1) % hits.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => (s - 1 + hits.length) % hits.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); // 팝업이 열려 있을 때만 — 전송 대신 멘션 확정
      pick(hits[sel]);
    } else if (e.key === 'Escape') {
      setToken(null);
    }
  }

  return (
    <div className="mention-wrap">
      {open && (
        <div className="mention-pop" role="listbox">
          {hits.map((c, i) => (
            <button
              key={c.username}
              type="button"
              role="option"
              aria-selected={i === sel}
              className={`mention-item${i === sel ? ' active' : ''}`}
              // mousedown이 input blur보다 먼저 오므로 클릭 유실 방지
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setSel(i)}
            >
              <Avatar value={c.avatar} className="mention-avatar" />
              <span className="mention-name">{dn(c.username)}</span>
              {c.sub && <span className="mention-sub">{c.sub}</span>}
            </button>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          requestAnimationFrame(syncToken);
        }}
        onSelect={syncToken}
        onKeyDown={onKeyDown}
        onBlur={() => setToken(null)}
      />
    </div>
  );
}
