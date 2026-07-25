import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../lib/socket';
import { BellIcon, PhoneIcon, SparklesIcon } from './Icons';
import MeetingThumb from './MeetingThumb';

interface Notification {
  id: number;
  from: string;
  text: string;
  kind: string | null;
  read: boolean;
  cleared?: boolean;
  ts: number;
  meeting?: { id: number; code?: string | null; title: string; thumbnail: string | null };
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** 알림함 — nowbar 종 아이콘. 영속 알림 + 안읽음 카운트 + 실시간 + 지난 알림 보기 */
export default function NotificationCenter() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [past, setPast] = useState(false); // 지난(치운) 알림까지 보기
  const ref = useRef<HTMLDivElement>(null);

  // 초기 로드 (현재 알림 + 안읽음 수)
  useEffect(() => {
    void api<{ unread: number; items: Notification[] }>('/api/notifications')
      .then((d) => {
        setItems(d.items);
        setUnread(d.unread);
      })
      .catch(() => {});
  }, []);

  // 실시간 수신 — 목록 맨 위에 추가, 안읽음 +1, 알림음 (연타 방지 2.5초)
  const lastSoundRef = useRef(0);
  useEffect(() => {
    const socket = getSocket();
    function onNotify(n: Notification & { created_at?: string }) {
      if (typeof n.id !== 'number') return;
      const ts = typeof n.ts === 'number' ? n.ts : n.created_at ? Date.parse(n.created_at) : Date.now();
      setItems((prev) =>
        prev.some((x) => x.id === n.id) ? prev : [{ ...n, ts, read: false }, ...prev],
      );
      setUnread((u) => u + 1);
      const now = Date.now();
      if (now - lastSoundRef.current > 2500) {
        lastSoundRef.current = now;
        const audio = new Audio('/sounds/notify.wav');
        audio.volume = 0.6;
        // 페이지 상호작용 전엔 자동재생이 막힐 수 있음 — 조용히 무시
        void audio.play().catch(() => {});
      }
    }
    socket.on('agent:notify', onNotify);
    return () => {
      socket.off('agent:notify', onNotify);
    };
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

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) setPast(false); // 닫을 때 현재 알림 모드로 초기화
    // 열 때 읽음 처리
    if (next && unread > 0) {
      setItems((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnread(0);
      await api('/api/notifications/read', { method: 'POST' }).catch(() => {});
    }
  }

  async function clearAll() {
    // 완전 삭제가 아니라 "치우기"(보관) — 지난 알림에서 볼 수 있음
    setItems([]);
    setUnread(0);
    await api('/api/notifications/clear', { method: 'POST' }).catch(() => {});
  }

  async function showPast() {
    setPast(true);
    const d = await api<{ items: Notification[] }>('/api/notifications?all=1').catch(() => null);
    if (d) setItems(d.items);
  }

  async function backToCurrent() {
    setPast(false);
    const d = await api<{ unread: number; items: Notification[] }>('/api/notifications').catch(
      () => null,
    );
    if (d) {
      setItems(d.items);
      setUnread(d.unread);
    }
  }

  async function purgeAll() {
    if (!window.confirm('지난 알림까지 완전히 삭제할까요? 되돌릴 수 없어요.')) return;
    setItems([]);
    setUnread(0);
    await api('/api/notifications', { method: 'DELETE' }).catch(() => {});
  }

  return (
    <div className="notif-center" ref={ref}>
      <button className="notif-bell" onClick={toggle} title="알림">
        <BellIcon size={20} />
        {unread > 0 && <span className="notif-count">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            <span>{past ? '지난 알림' : '알림'}</span>
            {past ? (
              <button className="notif-clear" onClick={backToCurrent}>
                ‹ 최근 알림
              </button>
            ) : (
              items.length > 0 && (
                <button className="notif-clear" onClick={clearAll}>
                  모두 지우기
                </button>
              )
            )}
          </div>
          <div className="notif-list">
            {items.length === 0 ? (
              <div className="notif-empty">{past ? '지난 알림이 없어요' : '새 알림이 없어요'}</div>
            ) : (
              items.map((n) => (
                <div
                  key={n.id}
                  className={`notif-item${n.read ? '' : ' unread'}${n.cleared ? ' cleared' : ''}`}
                >
                  {n.meeting ? (
                    <MeetingThumb
                      id={n.meeting.id}
                      title={n.meeting.title}
                      thumbnail={n.meeting.thumbnail}
                      className="notif-thumb"
                    />
                  ) : (
                    <span className="notif-thumb bell" aria-hidden>
                      <BellIcon size={15} />
                    </span>
                  )}
                  <div className="notif-item-main">
                    <div className="notif-item-top">
                      <span className="notif-from">{n.from}</span>
                      <span className="notif-time">{relTime(n.ts)}</span>
                    </div>
                    <div className="notif-text">{n.text}</div>
                    {n.kind === 'call' && n.meeting?.code && (
                      <button
                        className="notif-join"
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent('exist:open-meeting', {
                              detail: { code: n.meeting!.code, title: n.meeting!.title, tab: 'call' },
                            }),
                          );
                          setOpen(false);
                        }}
                      >
                        <PhoneIcon size={13} /> 지금 들어가기
                      </button>
                    )}
                    {n.kind === 'recap' && n.meeting?.code && (
                      <button
                        className="notif-join recap"
                        onClick={() => {
                          window.dispatchEvent(
                            new CustomEvent('exist:open-meeting', {
                              detail: { code: n.meeting!.code, title: n.meeting!.title, tab: 'dash' },
                            }),
                          );
                          setOpen(false);
                        }}
                      >
                        <SparklesIcon size={13} /> 정리 보기
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="notif-foot">
            {past ? (
              <button className="notif-foot-btn danger" onClick={purgeAll}>
                완전 삭제
              </button>
            ) : (
              <button className="notif-foot-btn" onClick={showPast}>
                지난 알림 보기 ›
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
