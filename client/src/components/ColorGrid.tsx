/*
 * 파워포인트식 색 팔레트 — 기본색 한 줄 + 각 색의 밝기 변형 5단 (테마 색 그리드).
 * 발표·시트·문서 색 선택 드롭다운이 공용으로 쓴다.
 */

const BASES = [
  '#ffffff',
  '#1c2024',
  '#8a919b',
  '#e5484d',
  '#f76808',
  '#f5c518',
  '#21c818',
  '#0091ff',
  '#4f7cff',
  '#8e4ec6',
  '#d6409f',
];

/** hex 두 색 혼합 — w = other 비중 (0~1) */
function mix(hex: string, other: string, w: number): string {
  const p = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const a = p(hex);
  const b = p(other);
  const c = a.map((v, i) => Math.round(v * (1 - w) + b[i] * w));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 열별 변형 5단 — 흰색 열은 회색 단계, 검정 열은 밝은 회색 단계, 색상 열은 밝게 2 + 어둡게 2 */
function shadesOf(base: string): string[] {
  if (base === '#ffffff') return [0.05, 0.13, 0.22, 0.33, 0.5].map((w) => mix(base, '#000000', w));
  if (base === '#1c2024') return [0.72, 0.55, 0.4, 0.25, 0.12].map((w) => mix(base, '#ffffff', w));
  return [
    mix(base, '#ffffff', 0.6),
    mix(base, '#ffffff', 0.35),
    mix(base, '#000000', 0.15),
    mix(base, '#000000', 0.35),
    mix(base, '#000000', 0.55),
  ];
}

const SHADES = BASES.map(shadesOf);

export default function ColorGrid({
  value,
  onPick,
  noneLabel,
}: {
  value?: string;
  onPick: (color: string) => void;
  /** 있으면 맨 위에 "없음/기본" 지우기 버튼 노출 (onPick('')로 전달) */
  noneLabel?: string;
}) {
  const cell = (c: string, key: string) => (
    <button
      key={key}
      type="button"
      className={`cgrid-cell${value?.toLowerCase() === c.toLowerCase() ? ' on' : ''}`}
      style={{ background: c }}
      title={c}
      onClick={() => onPick(c)}
    />
  );
  return (
    <div className="cgrid">
      {noneLabel && (
        <button type="button" className="cgrid-none" onClick={() => onPick('')}>
          ⃠ {noneLabel}
        </button>
      )}
      <div className="cgrid-row base">{BASES.map((c, i) => cell(c, `b${i}`))}</div>
      {[0, 1, 2, 3, 4].map((r) => (
        <div key={r} className="cgrid-row">
          {SHADES.map((col, i) => cell(col[r], `s${i}-${r}`))}
        </div>
      ))}
    </div>
  );
}
