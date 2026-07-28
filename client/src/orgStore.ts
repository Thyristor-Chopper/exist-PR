import { create } from 'zustand';
import { api } from './api';
import { useAuthStore } from './store';

export interface Org {
  id: number;
  name: string;
  joinCode: string;
  role: 'owner' | 'admin' | 'member';
  isManager: boolean;
  /** 이 조직에 그룹을 만들 수 있나 (owner/admin 또는 group:create 역할) — 생성 버튼 노출 근거 */
  canCreateGroup: boolean;
  memberCount: number;
  pendingCount: number;
}

/** 현재 조직 컨텍스트 — 'personal' 이거나 조직 id */
export type OrgContext = 'personal' | number;

interface OrgState {
  orgs: Org[];
  current: OrgContext;
  loaded: boolean;
  load: () => Promise<void>;
  setCurrent: (ctx: OrgContext) => void;
  /** recent/meetings API에 붙일 쿼리값 — 'personal' | '<id>' */
  contextParam: () => string;
}

function storageKey() {
  return `exist:org-context:${useAuthStore.getState().user?.username ?? ''}`;
}

function loadSavedContext(): OrgContext {
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw === 'personal' || raw == null) return 'personal';
    const n = Number(raw);
    return Number.isInteger(n) ? n : 'personal';
  } catch {
    return 'personal';
  }
}

export const useOrgStore = create<OrgState>((set, get) => ({
  orgs: [],
  current: loadSavedContext(),
  loaded: false,

  async load() {
    try {
      const orgs = await api<Org[]>('/api/orgs');
      // 저장된 컨텍스트가 더 이상 멤버가 아닌 조직이면 개인으로 폴백
      const cur = get().current;
      const valid = cur === 'personal' || orgs.some((o) => o.id === cur);
      set({ orgs, loaded: true, current: valid ? cur : 'personal' });
    } catch {
      set({ loaded: true });
    }
  },

  setCurrent(ctx) {
    try {
      localStorage.setItem(storageKey(), String(ctx));
    } catch {
      /* 무시 */
    }
    set({ current: ctx });
  },

  contextParam() {
    const cur = get().current;
    return cur === 'personal' ? 'personal' : String(cur);
  },
}));
