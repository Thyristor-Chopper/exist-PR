import { useLayoutEffect, useRef, useState } from 'react';
import type React from 'react';

/*
 * 구글 시트식 오버플로 툴바 — 폭이 모자라면 뒤쪽 버튼들을 ⋮ 팝오버로 접는다.
 * 보이는 아이템 폭을 지속 갱신하는 캐시로 목표 cut을 원샷 계산 (자가치유),
 * 진동 감지 시 더 작은 값으로 고정. 항상 렌더돼야 하는 것(숨은 file input 등)은
 * items에 넣지 말고 바깥에 둘 것.
 */
const GAP = 3;
const MORE_W = 40;

export default function OverflowToolbar({
  items,
  className = '',
}: {
  items: React.ReactNode[];
  className?: string;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const widthCache = useRef<number[]>([]);
  const histRef = useRef<number[]>([]);
  const [cut, setCut] = useState(items.length);
  const [moreOpen, setMoreOpen] = useState(false);

  useLayoutEffect(() => {
    histRef.current = [];
    setCut(items.length);
  }, [items.length]);

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const adjust = () => {
      if (!el.isConnected || el.clientWidth === 0) return; // display:none
      const kids = [...el.children].filter(
        (c) => !(c as HTMLElement).classList.contains('tb-more-wrap'),
      ) as HTMLElement[];
      // 지금 보이는 아이템 폭으로 캐시 갱신 (0폭 측정은 무시)
      kids.forEach((c, i) => {
        const w = c.offsetWidth;
        if (w > 0 || c.classList.contains('sht-sep') || c.classList.contains('doc-tool-sep')) {
          const st = getComputedStyle(c);
          widthCache.current[i] =
            w + (parseFloat(st.marginLeft) || 0) + (parseFloat(st.marginRight) || 0);
        }
      });
      const cs = getComputedStyle(el);
      const avail =
        el.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
      // 목표 cut 원샷 계산
      const wOf = (i: number) => widthCache.current[i] ?? 40;
      let total = 0;
      for (let i = 0; i < items.length; i++) total += wOf(i) + (i ? GAP : 0);
      let target: number;
      if (total <= avail) {
        target = items.length;
      } else {
        let used = MORE_W + GAP;
        let k = 0;
        while (k < items.length && used + wOf(k) + (k ? GAP : 0) <= avail) {
          used += wOf(k) + (k ? GAP : 0);
          k++;
        }
        target = k;
      }
      if (target === cut) return;
      // 진동 가드 — 두 값을 오가면 작은 쪽에 고정
      const h = histRef.current;
      h.push(target);
      if (h.length > 6) h.shift();
      const bouncing =
        h.length >= 4 &&
        h[h.length - 1] === h[h.length - 3] &&
        h[h.length - 2] === h[h.length - 4] &&
        h[h.length - 1] !== h[h.length - 2];
      if (bouncing && target > Math.min(h[h.length - 1], h[h.length - 2])) return;
      setCut(target);
    };
    const raf = requestAnimationFrame(adjust);
    const ro = new ResizeObserver(() => requestAnimationFrame(adjust));
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cut, items.length]);

  const hidden = items.slice(cut);
  return (
    <div ref={rowRef} className={`${className} tb-row`}>
      {items.slice(0, cut)}
      {hidden.length > 0 && (
        <div className="tb-more-wrap">
          <button
            type="button"
            className={`sht-btn tb-more${moreOpen ? ' on' : ''}`}
            title="더보기"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMoreOpen((v) => !v)}
          >
            ⋮
          </button>
          {moreOpen && (
            <>
              <div className="tb-more-back" onClick={() => setMoreOpen(false)} />
              <div className="tb-more-panel">{hidden}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
