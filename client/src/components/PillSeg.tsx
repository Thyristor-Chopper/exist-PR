import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/* 알약 세그먼트 토글 — 활성 알약(썸)이 선택 항목으로 미끄러진다.
 * 일정 일/주/월, 결정 원장 목록/변경 이력 등 앱 공용 토글 언어 */
export default function PillSeg({
  options,
  value,
  onChange,
  className,
  ariaLabel,
}: {
  options: { key: string; label: ReactNode }[];
  value: string;
  onChange: (key: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  // 활성 버튼 위치 실측 → 썸 이동 (가변 폭 라벨이라 계산 대신 측정)
  useLayoutEffect(() => {
    function measure() {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const btn = wrap.querySelector<HTMLElement>(`button[data-key="${CSS.escape(value)}"]`);
      if (btn) setThumb({ left: btn.offsetLeft, width: btn.offsetWidth });
    }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [value, options.length]);

  return (
    <div className={`pillseg${className ? ` ${className}` : ''}`} ref={wrapRef} role="tablist" aria-label={ariaLabel}>
      {thumb && (
        <span
          className="pillseg-thumb"
          style={{ transform: `translateX(${thumb.left}px)`, width: thumb.width }}
          aria-hidden
        />
      )}
      {options.map((o) => (
        <button
          key={o.key}
          data-key={o.key}
          type="button"
          role="tab"
          aria-selected={value === o.key}
          className={value === o.key ? 'on' : ''}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
