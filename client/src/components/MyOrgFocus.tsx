import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { ListIcon, CalendarIcon, ChatIcon } from './Icons';

/*
 * 내 포커스 — 일반 멤버의 조직 홈. 팀 인사이트(관리자용) 대신
 * "이 조직에서 내가 지금 챙길 것"을 보여준다: 미완료 할 일 · 다가오는 일정 · 안읽은 채팅.
 * 항목 클릭 → 해당 그룹으로 이동.
 */

interface Focus {
  todos: { id: number; title: string; dueAt: string | null; meetingCode?: string; meetingTitle?: string }[];
  events: { id: number; title: string; date: string; time: string | null; meetingCode?: string; meetingTitle?: string }[];
  unread: { meetingCode?: string; meetingTitle?: string; count: number }[];
}

function fmtDate(d: string, t: string | null): string {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const label = d === todayStr ? '오늘' : `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return t ? `${label} ${t}` : `${label} 종일`;
}

export default function MyOrgFocus({ orgId }: { orgId: number }) {
  const [data, setData] = useState<Focus | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    api<Focus>(`/api/orgs/${orgId}/my-focus`)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ todos: [], events: [], unread: [] }));
    return () => {
      alive = false;
    };
  }, [orgId]);

  const open = (code?: string, title?: string) => {
    if (!code) return;
    window.dispatchEvent(new CustomEvent('exist:open-meeting', { detail: { code, title: title ?? '' } }));
  };

  async function doneTodo(id: number) {
    setData((prev) => (prev ? { ...prev, todos: prev.todos.filter((t) => t.id !== id) } : prev));
    try {
      await api(`/api/todos/${id}`, { method: 'PATCH', body: { done: true } });
    } catch {
      /* 전역 토스트 */
    }
  }

  if (!data) return <section style={box}>📌 내 포커스 불러오는 중…</section>;

  const empty = data.todos.length === 0 && data.events.length === 0 && data.unread.length === 0;

  return (
    <section style={box}>
      <div style={head}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>📌 내 포커스</span>
        <span style={badge}>이 조직에서 지금 챙길 것</span>
      </div>

      {empty && (
        <div style={{ padding: '18px 4px', color: 'var(--text-sub)', fontSize: 14 }}>
          지금 처리할 게 없어요 — 다 따라잡았어요 👍
        </div>
      )}

      {data.todos.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={sectTitle}>
            <ListIcon size={13} /> 미완료 할 일 {data.todos.length}
          </div>
          {data.todos.map((t) => (
            <div key={t.id} style={row}>
              <button style={checkBtn} title="완료" onClick={() => void doneTodo(t.id)} />
              <span style={rowMain}>{t.title}</span>
              {t.meetingTitle && (
                <button style={chip} onClick={() => open(t.meetingCode, t.meetingTitle)}>
                  {t.meetingTitle}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {data.events.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={sectTitle}>
            <CalendarIcon size={13} /> 다가오는 일정
          </div>
          {data.events.map((e) => (
            <div key={e.id} style={row}>
              <span style={when}>{fmtDate(e.date, e.time)}</span>
              <span style={rowMain}>{e.title}</span>
              {e.meetingTitle && (
                <button style={chip} onClick={() => open(e.meetingCode, e.meetingTitle)}>
                  {e.meetingTitle}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {data.unread.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={sectTitle}>
            <ChatIcon size={13} /> 안 읽은 채팅
          </div>
          {data.unread.map((u) => (
            <div key={u.meetingCode} style={row}>
              <span style={rowMain}>{u.meetingTitle}</span>
              <span style={unreadBadge}>{u.count}</span>
              <button style={chip} onClick={() => open(u.meetingCode, u.meetingTitle)}>
                열기
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const box: CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 14,
  padding: 18,
  margin: 0, // 아래 간격은 부모 컬럼(gap)이 책임 — 자체 마진 주면 이중 간격
  boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
};
const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
};
const badge: CSSProperties = {
  fontSize: 12,
  color: '#21C818',
  background: 'rgba(33,200,24,0.1)',
  borderRadius: 8,
  padding: '3px 8px',
  fontWeight: 600,
};
const sectTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  marginBottom: 6,
  color: 'var(--text-sub)',
  display: 'flex',
  alignItems: 'center',
  gap: 5,
};
const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 4px',
  borderBottom: '1px solid var(--border)',
  fontSize: 14,
};
const rowMain: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const chip: CSSProperties = {
  fontSize: 12,
  color: 'var(--text-sub)',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 7,
  padding: '3px 8px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
const checkBtn: CSSProperties = {
  width: 17,
  height: 17,
  borderRadius: 5,
  border: '1.5px solid var(--border)',
  background: 'transparent',
  cursor: 'pointer',
  flexShrink: 0,
};
const when: CSSProperties = {
  fontSize: 12,
  color: '#21C818',
  fontWeight: 700,
  whiteSpace: 'nowrap',
  minWidth: 74,
};
const unreadBadge: CSSProperties = {
  background: '#e5484d',
  color: '#fff',
  borderRadius: 9,
  fontSize: 11,
  fontWeight: 700,
  padding: '2px 7px',
};
