import { useAuthStore } from './store';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; silent?: boolean } = {},
): Promise<T> {
  const token = useAuthStore.getState().token;
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const serverMsg = (data as { error?: string }).error;
    const message = serverMsg
      ? `${serverMsg} (${res.status})`
      : `요청 실패 (${res.status}) · ${options.method ?? 'GET'} ${path}`;
    if (res.status === 401) {
      useAuthStore.getState().logout();
    } else if (!options.silent && !path.startsWith('/api/auth/')) {
      // 인증 폼은 인라인으로 표시하므로 제외 — 나머지는 전역 토스트
      window.dispatchEvent(new CustomEvent('app:error', { detail: message }));
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}
