import { useEffect, useState } from 'react';

interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info';
}

let nextId = 1;

/** 전역 토스트 (우상단) — app:error(오류)·app:info(안내) 이벤트 수신 */
export default function ErrorToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    function push(text: string, kind: Toast['kind']) {
      const id = nextId++;
      // 같은 문구가 이미 떠 있으면 스택하지 않음 (반복 폴링 에러 스팸 방지)
      setToasts((prev) =>
        prev.some((t) => t.text === text && t.kind === kind)
          ? prev
          : [...prev.slice(-2), { id, text, kind }],
      ); // 최대 3개
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 6000);
    }
    function onError(e: Event) {
      push((e as CustomEvent<string>).detail, 'error');
    }
    function onInfo(e: Event) {
      push((e as CustomEvent<string>).detail, 'info');
    }
    window.addEventListener('app:error', onError);
    window.addEventListener('app:info', onInfo);
    return () => {
      window.removeEventListener('app:error', onError);
      window.removeEventListener('app:info', onInfo);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="error-toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`error-toast${t.kind === 'info' ? ' info' : ''}`}>
          <span className="error-toast-ic" aria-hidden>
            {t.kind === 'info' ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M8.5 12.5l2.4 2.4 4.6-5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
                <path
                  d="M12 7.5v5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="16.3" r="1.1" fill="currentColor" />
              </svg>
            )}
          </span>
          <span className="error-toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
