import { Fragment, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { getSocket } from '../lib/socket';
import { useAuthStore } from '../store';
import { useDisplayName } from '../names';
import Avatar from './Avatar';
import Marquee from './Marquee';
import { ChatIcon, CloseIcon } from './Icons';

/* 1:1 다이렉트 메시지(DM).
 * scope = 조직 id(숫자) 또는 'personal'(조직 무관).
 *  - 조직: 사이드바에 멤버 목록을 띄우고 누르면 대화창.
 *  - 개인: 대화한 적 있는 상대 목록 + 이름 검색으로 새 대화 시작.
 * 멤버/상대를 누르면 우하단 플로팅 채팅창이 열린다. 실시간 수신은 소켓 'dm:message'. */

export type DmScope = number | 'personal';

export interface Thread {
  userId: number;
  username: string;
  avatar: string | null;
  position: string | null;
  department: string | null;
  lastText: string | null;
  lastTs: number | null;
  lastMine: boolean;
  unread: number;
}

interface DmMessage {
  id: number;
  fromId: number;
  from: string;
  avatar: string | null;
  mine: boolean;
  text: string;
  ts: number;
  /** 히스토리 조회 시점 기준 안읽음 — "여기까지 읽었어요" 구분선용 */
  unread?: boolean;
}

/** 소켓으로 들어오는 실시간 메시지 (개인 DM이면 orgId = null) */
interface IncomingDm {
  id: number;
  orgId: number | null;
  fromId: number;
  toId: number;
  from: string;
  avatar: string | null;
  text: string;
  ts: number;
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
export function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간`;
  return `${Math.floor(h / 24)}일`;
}

/** 우하단 플로팅 대화창 */
export function DmWindow({
  scope,
  peer,
  onClose,
  onActivity,
}: {
  scope: DmScope;
  peer: Thread;
  onClose: () => void;
  /** 새 메시지로 스레드 목록을 갱신해야 할 때 */
  onActivity: () => void;
}) {
  const scopeOrg = scope === 'personal' ? null : scope;
  const dn = useDisplayName();
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  // "여기까지 읽었어요" 구분선 — 창을 연 시점의 첫 안읽음 메시지 id (열려 있는 동안 고정).
  // 첫 조회가 읽음 처리를 겸하므로 앵커는 상대별로 한 번만 기록 — StrictMode 이중 실행·재조회로
  // 두 번째 응답(플래그 없음)이 앵커를 덮어쓰지 않게 한다
  const [unreadMarkId, setUnreadMarkId] = useState<number | null>(null);
  const unreadAnchorRef = useRef<Record<number, number | null>>({});
  const prevPeerRef = useRef<number | null>(null); // 상대 전환 시 이전 상대 앵커 정리용
  const endRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const initialScrollDone = useRef(false);
  // exist AI에게 보낸 뒤 답변 준비 중 표시 — 상대 메시지 도착·타임아웃 시 해제
  const isAgent = peer.username === 'exist AI';
  const [aiThinking, setAiThinking] = useState(false);
  const aiThinkingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 이 상대의 DM 창을 보고 있음을 서버에 알림 — 보는 동안은 서버가 알림(notifyUser) 생략
  useEffect(() => {
    const socket = getSocket();
    socket.emit('dm:viewing', { peerId: peer.userId });
    return () => {
      socket.emit('dm:viewing', { peerId: null });
    };
  }, [peer.userId]);

  // 히스토리 로드 (열면서 상대 메시지 읽음 처리됨)
  useEffect(() => {
    let alive = true;
    initialScrollDone.current = false;
    // 다른 상대로 전환 — 이전 상대의 구분선 앵커는 그 열람 세션에서 소비된 것, 지운다
    // (같은 상대 재실행(StrictMode)은 안 지움 — 첫 응답의 플래그를 지키기 위한 조건)
    if (prevPeerRef.current !== null && prevPeerRef.current !== peer.userId) {
      delete unreadAnchorRef.current[prevPeerRef.current];
    }
    prevPeerRef.current = peer.userId;
    void api<DmMessage[]>(`/api/dm/${scope}/with/${peer.userId}`)
      .then((h) => {
        // 앵커 기록은 stale 응답이라도 수행 — 첫 조회가 읽음 처리를 겸하므로 플래그는
        // "처음 도착한 응답"에만 있다 (StrictMode 이중 실행이 첫 응답을 버려도 앵커는 남게)
        const first = h.find((m) => m.unread)?.id ?? null;
        if (!(peer.userId in unreadAnchorRef.current) || (unreadAnchorRef.current[peer.userId] == null && first != null)) {
          unreadAnchorRef.current[peer.userId] = first;
        }
        if (!alive) return;
        setUnreadMarkId(unreadAnchorRef.current[peer.userId]);
        setMessages(h);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [scope, peer.userId]);

  // 실시간 수신 — 이 상대와의 메시지만 추가 (id로 중복 제거)
  useEffect(() => {
    const socket = getSocket();
    function onDm(m: IncomingDm) {
      if (m.orgId !== scopeOrg) return;
      const isThis = m.fromId === peer.userId || (m.toId === peer.userId && m.fromId !== peer.userId);
      if (!isThis) return;
      // 상대가 보낸 메시지면 창이 열려 있으니 바로 읽음 처리 (배지 재출현 방지)
      if (m.fromId === peer.userId) {
        void api(`/api/dm/${scope}/with/${peer.userId}/read`, { method: 'POST' }).catch(() => {});
        setAiThinking(false); // AI 답변 도착 — 준비 중 표시 해제
        if (aiThinkingTimer.current) clearTimeout(aiThinkingTimer.current);
      }
      setMessages((prev) => {
        if (prev.some((x) => x.id === m.id)) return prev;
        return [
          ...prev,
          {
            id: m.id,
            fromId: m.fromId,
            from: m.from,
            avatar: m.avatar,
            mine: m.fromId !== peer.userId,
            text: m.text,
            ts: m.ts,
          },
        ];
      });
    }
    socket.on('dm:message', onDm);
    return () => {
      socket.off('dm:message', onDm);
    };
  }, [scope, scopeOrg, peer.userId]);

  // 새 메시지 오면 맨 아래로 — 단, 처음 열 때 안읽음 구분선이 있으면 거기부터 보여준다
  useEffect(() => {
    if (messages.length === 0) return;
    if (!initialScrollDone.current) {
      initialScrollDone.current = true;
      if (markRef.current) {
        markRef.current.scrollIntoView({ block: 'center' });
        return;
      }
    }
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, aiThinking]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    // AI 상대면 전송 "전"에 준비 중 표시 — 답변 소켓이 POST 응답보다 먼저 와도
    // 해제(onDm)가 켜기보다 늦지 않게 (늦으면 45초 유령 표시)
    if (isAgent) {
      setAiThinking(true);
      if (aiThinkingTimer.current) clearTimeout(aiThinkingTimer.current);
      aiThinkingTimer.current = setTimeout(() => setAiThinking(false), 45_000);
    }
    try {
      const m = await api<IncomingDm>(`/api/dm/${scope}/with/${peer.userId}`, {
        method: 'POST',
        body: { text },
      });
      // 소켓 echo와 중복되지 않게 id로 합치기
      setMessages((prev) =>
        prev.some((x) => x.id === m.id)
          ? prev
          : [
              ...prev,
              {
                id: m.id,
                fromId: m.fromId,
                from: m.from,
                avatar: m.avatar,
                mine: true,
                text: m.text,
                ts: m.ts,
              },
            ],
      );
      onActivity();
    } catch {
      setInput(text); // 실패 시 입력 복원
      setAiThinking(false); // 전송 실패 — 답이 올 리 없으니 표시 해제
      if (aiThinkingTimer.current) clearTimeout(aiThinkingTimer.current);
    } finally {
      setSending(false);
    }
  }

  // body 포털 — 조상 transform(스와이프 레이어 등)이 fixed를 가두는 stacking context 함정 회피
  return createPortal(
    <div className="dm-window">
      <div className="dm-window-head">
        <Avatar value={peer.avatar} className="dm-head-avatar" />
        <div className="dm-head-info">
          <span className="dm-head-name">{dn(peer.username)}</span>
          {(peer.department || peer.position) && (
            <span className="dm-head-sub">
              {[peer.department, peer.position].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        <button className="dm-head-close" onClick={onClose} title="닫기">
          <CloseIcon size={16} />
        </button>
      </div>

      <div className="dm-window-body">
        {messages.length === 0 && (
          <div className="chat-empty">
            <ChatIcon size={34} />
            <p>{dn(peer.username)}님과의 대화</p>
            <span>첫 메시지를 보내보세요</span>
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const showDate = !prev || !sameDay(prev.ts, m.ts);
          const grouped =
            !!prev && prev.fromId === m.fromId && !showDate && m.ts - prev.ts < 5 * 60_000;
          return (
            <Fragment key={m.id}>
              {m.id === unreadMarkId && (
                <div className="chat-unread-divider" ref={markRef}>
                  <span>여기까지 읽었어요</span>
                </div>
              )}
              {showDate && (
                <div className="chat-date">
                  <span>{chatDateLabel(m.ts)}</span>
                </div>
              )}
              <div className={`chat-row${m.mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`}>
                {!m.mine &&
                  (grouped ? (
                    <span className="chat-avatar-gap" />
                  ) : (
                    <Avatar value={m.avatar} className="chat-avatar" />
                  ))}
                <div className="chat-content">
                  <div className="chat-line">
                    {m.mine && <span className="chat-time">{chatTime(m.ts)}</span>}
                    <div className="chat-bubble">{m.text}</div>
                    {!m.mine && <span className="chat-time">{chatTime(m.ts)}</span>}
                  </div>
                </div>
              </div>
            </Fragment>
          );
        })}
        {aiThinking && (
          <div className="chat-row">
            <Avatar value={peer.avatar} className="chat-avatar" />
            <div className="chat-content">
              <div className="chat-line">
                <div className="chat-bubble chat-typing">
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="dm-window-input" onSubmit={send}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="메시지 입력"
          autoFocus
        />
        <button type="submit" disabled={sending || !input.trim()}>
          전송
        </button>
      </form>
    </div>,
    document.body,
  );
}

/** 이름 검색 결과 (새 대화 시작용) */
export interface SearchHit {
  userId: number;
  username: string;
  avatar: string | null;
}

export default function DirectMessages({ scope }: { scope: DmScope }) {
  const dn = useDisplayName();
  const myId = useAuthStore((s) => s.user?.id);
  const personal = scope === 'personal';
  const scopeOrg = personal ? null : scope;
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activePeer, setActivePeer] = useState<Thread | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const activeRef = useRef<number | null>(null);
  activeRef.current = activePeer?.userId ?? null;

  function loadThreads() {
    void api<Thread[]>(`/api/dm/${scope}/threads`)
      .then(setThreads)
      .catch(() => setThreads([]));
  }

  // 스코프(조직/개인) 바뀌면 목록 새로고침 + 열린 창·검색 초기화
  useEffect(() => {
    setActivePeer(null);
    setQuery('');
    setHits([]);
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // 이름 검색 (디바운스) — 새 대화 상대 찾기
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    const id = setTimeout(() => {
      void api<SearchHit[]>(`/api/dm/${scope}/search?q=${encodeURIComponent(q)}`)
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(id);
  }, [query, scope]);

  // 실시간 — 스레드 목록의 미리보기·안읽음 갱신
  useEffect(() => {
    const socket = getSocket();
    function onDm(m: IncomingDm) {
      if (m.orgId !== scopeOrg) return;
      const partner = m.fromId === myId ? m.toId : m.fromId;
      const incoming = m.toId === myId; // 내가 받은 메시지
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.userId === partner);
        if (idx === -1) {
          // 목록에 없던 상대 — 전체 새로고침
          loadThreads();
          return prev;
        }
        const t = prev[idx];
        // 이 상대 창이 열려 있으면 안읽음으로 세지 않음
        const isOpen = activeRef.current === partner;
        const updated: Thread = {
          ...t,
          lastText: m.text,
          lastTs: m.ts,
          lastMine: m.fromId === myId,
          unread: incoming && !isOpen ? t.unread + 1 : t.unread,
        };
        const rest = prev.filter((_, i) => i !== idx);
        return [updated, ...rest];
      });
    }
    socket.on('dm:message', onDm);
    return () => {
      socket.off('dm:message', onDm);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, scopeOrg, myId]);

  function openThread(t: Thread) {
    // 열면 안읽음 비우기 (서버는 히스토리 조회 시 읽음 처리)
    setThreads((prev) => prev.map((x) => (x.userId === t.userId ? { ...x, unread: 0 } : x)));
    setActivePeer(t);
  }

  // 검색 결과에서 새 대화 열기 — 이미 있는 스레드면 그걸, 없으면 임시 스레드로
  function openHit(h: SearchHit) {
    setQuery('');
    setHits([]);
    const existing = threads.find((t) => t.userId === h.userId);
    if (existing) return openThread(existing);
    openThread({
      userId: h.userId,
      username: h.username,
      avatar: h.avatar,
      position: null,
      department: null,
      lastText: null,
      lastTs: null,
      lastMine: false,
      unread: 0,
    });
  }

  return (
    <>
      {/* 개인 스코프: 이름으로 검색해 새 대화 시작 */}
      {personal && (
        <div className="dm-search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름으로 검색해 새 대화"
          />
          {hits.length > 0 && (
            <div className="dm-search-results">
              {hits.map((h) => (
                <button key={h.userId} className="dm-search-hit" onClick={() => openHit(h)}>
                  <Avatar value={h.avatar} className="dm-item-avatar" />
                  <span className="dm-item-name">{dn(h.username)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="dm-list">
        {threads.length === 0 && (
          <div className="dm-empty">
            {personal ? '위에서 이름을 검색해 대화를 시작해보세요' : '이 조직에 다른 멤버가 없어요'}
          </div>
        )}
        {threads.map((t) => (
          <button
            key={t.userId}
            className={`dm-item${activePeer?.userId === t.userId ? ' active' : ''}`}
            onClick={() => openThread(t)}
          >
            <Avatar value={t.avatar} className="dm-item-avatar" />
            <div className="dm-item-main">
              <div className="dm-item-top">
                <Marquee className="dm-item-name">{dn(t.username)}</Marquee>
                {t.lastTs && <span className="dm-item-time">{relTime(t.lastTs)}</span>}
              </div>
              <div className="dm-item-preview">
                {t.lastMine && t.lastText && <span className="dm-item-me">나:</span>}
                <Marquee className="dm-item-preview-text">
                {t.lastText ? (
                  t.lastText
                ) : (
                  <span className="dm-item-muted">
                    {[t.department, t.position].filter(Boolean).join(' · ') || '대화 시작하기'}
                  </span>
                )}
                </Marquee>
              </div>
            </div>
            {t.unread > 0 && <span className="dm-item-badge">{t.unread > 9 ? '9+' : t.unread}</span>}
          </button>
        ))}
      </div>

      {activePeer && (
        <DmWindow
          scope={scope}
          peer={activePeer}
          onClose={() => setActivePeer(null)}
          onActivity={loadThreads}
        />
      )}
    </>
  );
}
