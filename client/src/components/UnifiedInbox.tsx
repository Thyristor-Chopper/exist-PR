import { useEffect, useState } from 'react';
import { api } from '../api';
import { getSocket, request } from '../lib/socket';
import { useDisplayName } from '../names';
import Avatar from './Avatar';
import Marquee from './Marquee';
import MeetingThumb from './MeetingThumb';
import { DmWindow, relTime, type Thread, type SearchHit, type DmScope } from './DirectMessages';

/*
 * 통합 메시지함 — 같은 스코프(조직/개인) 안의 그룹 채팅 + 1:1 DM을
 * 하나의 목록으로 합쳐 최근 대화순으로 보여준다.
 *  - 그룹 항목 클릭: 해당 그룹의 채팅 탭 열기 + 읽음 처리
 *  - DM 항목 클릭: 우하단 플로팅 대화창(DmWindow)
 *  - 하단 검색: 이름으로 새 DM 시작
 */

interface InboxItem {
  id: number;
  code: string;
  title: string;
  thumbnail: string | null;
  lastText: string | null;
  lastTs: string | null;
  unread: number;
}

interface UItem {
  key: string;
  kind: 'group' | 'dm';
  name: string;
  thumb?: string | null;
  gid?: number;
  code?: string;
  avatar?: string | null;
  lastText: string | null;
  lastTs: number;
  lastMine?: boolean;
  unread: number;
  sub?: string;
  peer?: Thread;
}

/** SQLite datetime('now')은 UTC인데 타임존 표기가 없어 Date.parse가 로컬로 오해함 — UTC로 보정 */
function parseUtc(s: string): number {
  return /Z|[+-]\d{2}:\d{2}$/.test(s) ? Date.parse(s) : Date.parse(s.replace(' ', 'T') + 'Z');
}

export default function UnifiedInbox({ scope }: { scope: DmScope }) {
  const dn = useDisplayName();
  const [groups, setGroups] = useState<InboxItem[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activePeer, setActivePeer] = useState<Thread | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);

  function loadThreads() {
    void api<Thread[]>(`/api/dm/${scope}/threads`).then(setThreads).catch(() => setThreads([]));
  }
  function loadGroups() {
    void api<InboxItem[]>(`/api/meetings/inbox?org=${scope}`).then(setGroups).catch(() => setGroups([]));
  }

  useEffect(() => {
    setActivePeer(null);
    setQuery('');
    setHits([]);
    loadGroups();
    loadThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // 그룹 채팅 룸 구독 — 목록에 있는 그룹의 새 메시지를 소켓으로 받기 위해 (join은 멱등)
  useEffect(() => {
    const socket = getSocket();
    const join = () => {
      for (const g of groups) void request(socket, 'chat:join', { code: g.code }).catch(() => {});
    };
    join();
    // 서버 재시작(배포)·네트워크 끊김 후 재연결되면 서버 쪽 룸이 초기화됨 —
    // 다시 구독하고, 끊긴 동안 놓친 메시지를 재조회로 따라잡는다
    const onReconnect = () => {
      join();
      loadGroups();
      loadThreads();
    };
    socket.io.on('reconnect', onReconnect);
    return () => {
      socket.io.off('reconnect', onReconnect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  // 실시간 갱신 — 새 그룹 채팅/DM이 오면 새로고침 없이 목록·안읽음·미리보기 반영.
  // 서버가 안읽음을 정확히 계산하므로 재조회 방식, 버스트는 300ms로 묶음
  useEffect(() => {
    const socket = getSocket();
    let gt: ReturnType<typeof setTimeout> | null = null;
    let dt: ReturnType<typeof setTimeout> | null = null;
    const onChat = () => {
      if (gt) return;
      gt = setTimeout(() => {
        gt = null;
        loadGroups();
      }, 300);
    };
    const onDm = () => {
      if (dt) return;
      dt = setTimeout(() => {
        dt = null;
        loadThreads();
      }, 300);
    };
    socket.on('chat:message', onChat);
    // 새 그룹 생성·참여·초대(inbox:changed) — 목록 재조회 후 위의 구독 이펙트가 새 룸도 join
    socket.on('inbox:changed', onChat);
    socket.on('dm:message', onDm);
    return () => {
      socket.off('chat:message', onChat);
      socket.off('inbox:changed', onChat);
      socket.off('dm:message', onDm);
      if (gt) clearTimeout(gt);
      if (dt) clearTimeout(dt);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // 이름 검색(디바운스) — 새 DM 상대 찾기
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

  // 그룹 + DM 병합, 최근 대화순
  const items: UItem[] = [
    ...groups.map(
      (g): UItem => ({
        key: 'g' + g.code,
        kind: 'group',
        name: g.title,
        thumb: g.thumbnail,
        gid: g.id,
        code: g.code,
        lastText: g.lastText,
        lastTs: g.lastTs ? parseUtc(g.lastTs) : 0,
        unread: g.unread,
      }),
    ),
    ...threads.map(
      (t): UItem => ({
        key: 'd' + t.userId,
        kind: 'dm',
        name: dn(t.username),
        avatar: t.avatar,
        lastText: t.lastText,
        lastTs: t.lastTs ?? 0,
        lastMine: t.lastMine,
        unread: t.unread,
        sub: [t.department, t.position].filter(Boolean).join(' · '),
        peer: t,
      }),
    ),
  ].sort((a, b) => b.lastTs - a.lastTs);

  function openItem(it: UItem) {
    if (it.kind === 'group') {
      window.dispatchEvent(
        new CustomEvent('exist:open-meeting', { detail: { code: it.code, title: it.name, tab: 'chat' } }),
      );
      // 서버 읽음 처리는 허브 채팅 탭이 히스토리 로드 "후"에 함 — 여기서 먼저 마킹하면
      // 히스토리의 unread 플래그가 지워져 "여기까지 읽었어요" 구분선이 못 뜬다
      setGroups((p) => p.map((g) => (g.code === it.code ? { ...g, unread: 0 } : g)));
    } else if (it.peer) {
      const peer = it.peer;
      setThreads((p) => p.map((x) => (x.userId === peer.userId ? { ...x, unread: 0 } : x)));
      setActivePeer(peer);
    }
  }

  function openHit(h: SearchHit) {
    setQuery('');
    setHits([]);
    const existing = threads.find((t) => t.userId === h.userId);
    if (existing) {
      setThreads((p) => p.map((x) => (x.userId === h.userId ? { ...x, unread: 0 } : x)));
      setActivePeer(existing);
      return;
    }
    setActivePeer({
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

      <div className="dm-list">
        {items.length === 0 && <div className="dm-empty">아직 대화가 없어요</div>}
        {items.map((it) => (
          <button key={it.key} className="dm-item" onClick={() => openItem(it)}>
            {it.kind === 'group' ? (
              <MeetingThumb id={it.gid!} title={it.name} thumbnail={it.thumb} className="dm-item-avatar" />
            ) : (
              <Avatar value={it.avatar} className="dm-item-avatar" />
            )}
            <div className="dm-item-main">
              <div className="dm-item-top">
                <Marquee className="dm-item-name">{it.name}</Marquee>
                {it.lastTs > 0 && <span className="dm-item-time">{relTime(it.lastTs)}</span>}
              </div>
              <div className="dm-item-preview">
                {it.lastMine && it.lastText && <span className="dm-item-me">나:</span>}
                <Marquee className="dm-item-preview-text">
                {it.lastText ? (
                  it.lastText
                ) : (
                  <span className="dm-item-muted">
                    {it.sub || (it.kind === 'group' ? '아직 메시지가 없어요' : '대화 시작하기')}
                  </span>
                )}
                </Marquee>
              </div>
            </div>
            {it.unread > 0 && <span className="dm-item-badge">{it.unread > 9 ? '9+' : it.unread}</span>}
          </button>
        ))}
      </div>

      {activePeer && (
        <DmWindow scope={scope} peer={activePeer} onClose={() => setActivePeer(null)} onActivity={loadThreads} />
      )}
    </>
  );
}
