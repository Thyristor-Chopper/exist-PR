import { useEffect, useRef, useState } from 'react';

/* 손 서명 패드 — 종이 회람판의 디지털화. 클릭보다 무거운 의사표시 (마우스·터치).
 * 인수인계 서명 + 🔴 작업 전 확인 필수 결정에 사용 — "중요도에 비례한 마찰" */
export default function SignPad({
  onConfirm,
  onCancel,
  title = '서명 — 마우스나 손가락으로 이름을 적어주세요',
}: {
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
  title?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 320 * dpr;
    canvas.height = 110 * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#1f2937'; // 잉크색 고정 — 서명 칩은 양 테마 모두 밝은 배경
  }, []);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  return (
    <div className="ho-signpad">
      <div className="ho-signpad-title">{title}</div>
      <canvas
        ref={canvasRef}
        className="ho-sign-canvas"
        style={{ width: 320, height: 110, touchAction: 'none' }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
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
            out.height = 82;
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
