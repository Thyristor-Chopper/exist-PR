import { useEffect, useState } from 'react';
import { api } from '../api';
import { getSocket } from './socket';

/** 접속 중인 사용자명 집합 — 소켓 푸시(presence:update)가 주 경로.
 * 폴링 없음: 접속/해제 전 케이스를 서버가 즉시 방송하므로 중복이었다.
 * 최초 1회 + 소켓 재연결 시에만 스냅샷을 받아 끊긴 사이를 보정한다 */
export function usePresence(): Set<string> {
  const [users, setUsers] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const d = await api<{ users: string[] }>('/api/presence');
        if (alive) setUsers(new Set(d.users));
      } catch {
        /* 무시 */
      }
    }
    void load();

    const socket = getSocket();
    function onUpdate({ users }: { users: string[] }) {
      setUsers(new Set(users));
    }
    const onReconnect = () => void load();
    socket.on('presence:update', onUpdate);
    socket.on('connect', onReconnect);
    return () => {
      alive = false;
      socket.off('presence:update', onUpdate);
      socket.off('connect', onReconnect);
    };
  }, []);

  return users;
}
