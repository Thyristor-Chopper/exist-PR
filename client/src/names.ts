import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from './api';
import { useAuthStore } from './store';

/** username → 표시 이름 디렉터리. 이름을 안 정한 사용자는 항목이 없다 (= 아이디로 표시) */
interface NameState {
  map: Record<string, string>;
  loaded: boolean;
  load: () => Promise<void>;
}

export const useNameStore = create<NameState>((set) => ({
  map: {},
  loaded: false,
  load: async () => {
    try {
      const rows = await api<{ username: string; name: string | null }[]>('/api/auth/names');
      const map: Record<string, string> = {};
      for (const r of rows) if (r.name) map[r.username] = r.name;
      set({ map, loaded: true });
    } catch {
      /* 미로그인 등 — 다음 로드 기회에 */
    }
  },
}));

/** 표시 이름 훅 — dn(username) = 이름, 없으면 아이디 그대로. 'AI'·'exist AI' 같은 비사용자 문자열은 통과 */
export function useDisplayName() {
  const map = useNameStore((s) => s.map);
  return (username?: string | null) => (username ? (map[username] ?? username) : '');
}

/** 훅을 못 쓰는 곳(이벤트 핸들러 등)용 — 스냅샷 조회 */
export function displayNameOf(username?: string | null): string {
  if (!username) return '';
  return useNameStore.getState().map[username] ?? username;
}

/** 로그인 상태가 되면 디렉터리 로드 (App에서 1회 구독, 로그인 갱신 시 재로드) */
export function useLoadNames() {
  const token = useAuthStore((s) => s.token);
  const load = useNameStore((s) => s.load);
  useEffect(() => {
    if (token) void load();
  }, [token, load]);
}
