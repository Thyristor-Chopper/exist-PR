import { useEffect, useRef, useState } from 'react';

/* 손 서명 패드 — 종이 회람판의 디지털화. 클릭보다 무거운 의사표시 (마우스·터치).
 * 인수인계 서명 + 🔴 작업 전 확인 필수 결정에 사용 — "중요도에 비례한 마찰" */
export default function SignPad({
  onConfirm,
  onCancel,
  title = '서명 — 마우스나 손가락으로 이름을 적어주세요',
  fluid = false,
}: {
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
  title?: string;
  /** 모바일 — 패드가 담긴 컨테이너 폭을 꽉 채움 (기본 320×110은 데스크탑 그대로) */
  fluid?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);
  // 논리 크기 — fluid면 마운트 시 컨테이너 폭으로 한 번 측정 (그리는 도중 리사이즈로 지워지지 않게)
  const [dim, setDim] = useState({ w: 320, h: 110 });

  useEffect(() => {
    if (!fluid) return;
    const el = wrapRef.current;
    if (!el) return;
    // 패드 padding 12×2 + border 2 만큼 뺀 내용 폭 — 폰에서 가로 꽉, 세로는 손가락 서명하기 적당하게
    const w = Math.max(240, Math.floor(el.clientWidth - 26));
    setDim({ w, h: 140 });
  }, [fluid]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = dim.w * dpr;
    canvas.height = dim.h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1f2937'; // 잉크색 고정 — 서명 칩은 양 테마 모두 밝은 배경
  }, [dim.w, dim.h]);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    // max-width:100% 등으로 표시 크기가 논리 크기와 다를 때 좌표 보정
    const sx = rect.width > 0 ? dim.w / rect.width : 1;
    const sy = rect.height > 0 ? dim.h / rect.height : 1;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  return (
    <div ref={wrapRef} className={`ho-signpad${fluid ? ' fluid' : ''}`}>
      <div className="ho-signpad-title">{title}</div>
      <canvas
        ref={canvasRef}
        className="ho-sign-canvas"
        style={{ width: dim.w, height: dim.h, touchAction: 'none' }}
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* 캡처 불가 환경(합성 이벤트 등) — 캡처 없이도 그리기는 동작 */
          }
          drawing.current = true;
          const p = pos(e);
          const ctx = e.currentTarget.getContext('2d')!;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const p = pos(e);
          const ctx = e.currentTarget.getContext('2d')!;
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          if (!dirty) setDirty(true);
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
      />
      <div className="ho-signpad-actions">
        <button
          type="button"
          className="ho-sign-clear"
          onClick={() => {
            const canvas = canvasRef.current!;
            const ctx = canvas.getContext('2d')!;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            setDirty(false);
          }}
        >
          다시 쓰기
        </button>
        <span style={{ flex: 1 }} />
        <button type="button" className="ho-cancel" onClick={onCancel}>
          취소
        </button>
        <button
          type="button"
          className="ho-publish"
          disabled={!dirty}
          onClick={() => {
            // 저장 크기 절약 — 절반 해상도로 축소해서 내보냄 (~2-5KB)
            const src = canvasRef.current!;
            const out = document.createElement('canvas');
            out.width = 240;
            out.height = Math.max(1, Math.floor((dim.h / dim.w) * 240)); // 비율 유지 (기본 320×110 → 240×82)
            out.getContext('2d')!.drawImage(src, 0, 0, out.width, out.height);
            onConfirm(out.toDataURL('image/png'));
          }}
        >
          서명 완료
        </button>
      </div>
    </div>
  );
}
