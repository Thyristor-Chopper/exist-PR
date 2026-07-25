import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '../store';
import { DownloadIcon } from './Icons';
import ColorGrid from './ColorGrid';

const COLS = 26; // A..Z
const ROWS = 60;

function colLetter(i: number): string {
  return String.fromCharCode(65 + i); // 0->A
}
function cellKey(r: number, c: number): string {
  return `${colLetter(c)}${r + 1}`; // A1 style (1-indexed row)
}
function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^([A-Z])(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) return null;
  const c = m[1].charCodeAt(0) - 65;
  const r = parseInt(m[2], 10) - 1;
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return null;
  return { r, c };
}

// 범위(A1:B3)의 셀 값들을 순회
function rangeValues(
  a: string,
  b: string,
  cells: Y.Map<unknown>,
  seen: Set<string>,
): { nums: number[]; raws: string[] } {
  const ra = parseRef(a);
  const rb = parseRef(b);
  const nums: number[] = [];
  const raws: string[] = [];
  if (!ra || !rb) return { nums, raws };
  for (let r = Math.min(ra.r, rb.r); r <= Math.max(ra.r, rb.r); r++) {
    for (let c = Math.min(ra.c, rb.c); c <= Math.max(ra.c, rb.c); c++) {
      const k = cellKey(r, c);
      const s = evalCell(cells.get(k) as string, cells, new Set(seen), k);
      raws.push(s);
      const v = parseFloat(s);
      if (!isNaN(v) && s.trim() !== '') nums.push(v);
    }
  }
  return { nums, raws };
}

// 조건 매칭 (">5", "<=3", "=foo", "foo")
function matchCriteria(val: string, crit: string): boolean {
  crit = crit.trim().replace(/^["']|["']$/g, '');
  const m = /^(>=|<=|<>|>|<|=)?(.*)$/.exec(crit);
  const op = m?.[1] ?? '=';
  const target = (m?.[2] ?? '').trim();
  const vn = parseFloat(val);
  const tn = parseFloat(target);
  const bothNum = !isNaN(vn) && !isNaN(tn);
  switch (op) {
    case '>': return bothNum && vn > tn;
    case '<': return bothNum && vn < tn;
    case '>=': return bothNum && vn >= tn;
    case '<=': return bothNum && vn <= tn;
    case '<>': return val !== target;
    default: return bothNum ? vn === tn : val === target;
  }
}

/** 수식 평가 — Excel형 함수/연산자 지원. 셀 참조 재귀 평가(사이클 가드). */
function evalCell(
  raw: string | undefined,
  cells: Y.Map<unknown>,
  seen: Set<string>,
  key: string,
): string {
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string' || raw[0] !== '=') return String(raw);
  if (seen.has(key)) return '#순환';
  seen.add(key);
  try {
    let expr = raw.slice(1);
    // 1) 조건 범위 함수: COUNTIF/SUMIF(range, criteria)
    expr = expr.replace(
      /\b(COUNTIF|SUMIF)\s*\(\s*([A-Za-z]\d+)\s*:\s*([A-Za-z]\d+)\s*,\s*("[^"]*"|[^),]+)\s*(?:,\s*([A-Za-z]\d+)\s*:\s*([A-Za-z]\d+)\s*)?\)/gi,
      (_m, fn: string, a: string, b: string, crit: string, sa?: string, sb?: string) => {
        const { raws } = rangeValues(a, b, cells, seen);
        const sumRange = sa && sb ? rangeValues(sa, sb, cells, seen).raws : raws;
        let count = 0;
        let sum = 0;
        raws.forEach((v, idx) => {
          if (matchCriteria(v, crit)) {
            count++;
            const n = parseFloat(sumRange[idx]);
            if (!isNaN(n)) sum += n;
          }
        });
        return fn.toUpperCase() === 'COUNTIF' ? String(count) : String(sum);
      },
    );
    // 2) 집계 범위 함수
    expr = expr.replace(
      /\b(SUM|AVERAGE|AVG|MIN|MAX|COUNT|COUNTA|PRODUCT|MEDIAN)\s*\(\s*([A-Za-z]\d+)\s*:\s*([A-Za-z]\d+)\s*\)/gi,
      (_m, fn: string, a: string, b: string) => {
        const { nums, raws } = rangeValues(a, b, cells, seen);
        const sum = nums.reduce((s, n) => s + n, 0);
        switch (fn.toUpperCase()) {
          case 'SUM': return String(sum);
          case 'AVERAGE':
          case 'AVG': return nums.length ? String(sum / nums.length) : '0';
          case 'MIN': return nums.length ? String(Math.min(...nums)) : '0';
          case 'MAX': return nums.length ? String(Math.max(...nums)) : '0';
          case 'COUNT': return String(nums.length);
          case 'COUNTA': return String(raws.filter((s) => s.trim() !== '').length);
          case 'PRODUCT': return String(nums.reduce((s, n) => s * n, 1));
          case 'MEDIAN': {
            if (!nums.length) return '0';
            const sorted = [...nums].sort((x, y) => x - y);
            const mid = Math.floor(sorted.length / 2);
            return String(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
          }
        }
        return '0';
      },
    );
    // 문자열 리터럴 보호 (셀참조/연산자 치환이 문자열 내부를 건드리지 않게)
    const strs: string[] = [];
    expr = expr.replace(/"[^"]*"/g, (m) => {
      strs.push(m);
      return `\x00${strs.length - 1}\x00`;
    });
    // 3) 단일 셀 참조 → 값(숫자면 숫자, 아니면 따옴표 문자열, 빈칸은 0)
    expr = expr.replace(/\b[A-Za-z]\d+\b/g, (ref) => {
      const rf = parseRef(ref.toUpperCase());
      if (!rf) return ref; // 함수명 등은 보존
      const k = cellKey(rf.r, rf.c);
      const s = evalCell(cells.get(k) as string, cells, new Set(seen), k);
      if (s.trim() === '') return '0';
      const n = parseFloat(s);
      return !isNaN(n) && /^-?[\d.]+$/.test(s.trim()) ? s : JSON.stringify(s);
    });
    // 4) 연산자 변환: <> → !=, = → == (>=,<= 보호), & → 문자열 결합
    expr = expr
      .replace(/>=/g, '@GE@')
      .replace(/<=/g, '@LE@')
      .replace(/<>/g, '!=')
      .replace(/(?<![=!<>])=(?!=)/g, '==')
      .replace(/@GE@/g, '>=')
      .replace(/@LE@/g, '<=')
      .replace(/&/g, '+');
    // 문자열 복원
    expr = expr.replace(/\x00(\d+)\x00/g, (_m, i) => strs[+i]);
    if (expr.trim() === '') return '';
    // 5) 스칼라 함수 스코프와 함께 평가
    const fns = [
      'IF', 'AND', 'OR', 'NOT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'ABS', 'SQRT',
      'POWER', 'MOD', 'INT', 'IFERROR', 'CONCAT', 'CONCATENATE', 'LEN', 'LEFT',
      'RIGHT', 'MID', 'UPPER', 'LOWER', 'TRIM', 'MINF', 'MAXF', 'SUMF',
      'TODAY', 'NOW', 'DATE', 'YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'DATEDIF',
    ];
    const fmtDate = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const impl: Record<string, unknown> = {
      IF: (c: unknown, t: unknown, f: unknown = false) => (c ? t : f),
      AND: (...a: unknown[]) => a.every(Boolean),
      OR: (...a: unknown[]) => a.some(Boolean),
      NOT: (a: unknown) => !a,
      ROUND: (x: number, n = 0) => Math.round(x * 10 ** n) / 10 ** n,
      ROUNDUP: (x: number, n = 0) => Math.ceil(x * 10 ** n) / 10 ** n,
      ROUNDDOWN: (x: number, n = 0) => Math.floor(x * 10 ** n) / 10 ** n,
      ABS: Math.abs,
      SQRT: Math.sqrt,
      POWER: (x: number, y: number) => x ** y,
      MOD: (x: number, y: number) => x % y,
      INT: Math.floor,
      IFERROR: (v: unknown, fb: unknown) => (typeof v === 'number' && !isFinite(v)) || v == null || (typeof v === 'string' && v[0] === '#') ? fb : v,
      CONCAT: (...a: unknown[]) => a.map(String).join(''),
      CONCATENATE: (...a: unknown[]) => a.map(String).join(''),
      LEN: (s: unknown) => String(s).length,
      LEFT: (s: unknown, n = 1) => String(s).slice(0, n),
      RIGHT: (s: unknown, n = 1) => String(s).slice(-n),
      MID: (s: unknown, start: number, len: number) => String(s).substr(start - 1, len),
      UPPER: (s: unknown) => String(s).toUpperCase(),
      LOWER: (s: unknown) => String(s).toLowerCase(),
      TRIM: (s: unknown) => String(s).trim(),
      MINF: (...a: number[]) => Math.min(...a),
      MAXF: (...a: number[]) => Math.max(...a),
      SUMF: (...a: number[]) => a.reduce((s, n) => s + (Number(n) || 0), 0),
      TODAY: () => fmtDate(new Date()),
      NOW: () => {
        const d = new Date();
        return `${fmtDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      },
      DATE: (y: number, m: number, d: number) => fmtDate(new Date(y, m - 1, d)),
      YEAR: (s: unknown) => new Date(String(s)).getFullYear(),
      MONTH: (s: unknown) => new Date(String(s)).getMonth() + 1,
      DAY: (s: unknown) => new Date(String(s)).getDate(),
      WEEKDAY: (s: unknown) => new Date(String(s)).getDay() + 1, // 1=일요일 (엑셀 기본)
      DATEDIF: (a: unknown, b: unknown, unit: unknown = 'D') => {
        const d1 = new Date(String(a)).getTime();
        const d2 = new Date(String(b)).getTime();
        const days = Math.floor((d2 - d1) / 86400000);
        const u = String(unit).toUpperCase();
        return u === 'M' ? Math.floor(days / 30) : u === 'Y' ? Math.floor(days / 365) : days;
      },
    };
    // 남은 MIN(/MAX(/SUM(/COUNT( 스칼라 인자형 → MINF 등으로
    expr = expr.replace(/\bMIN\s*\(/gi, 'MINF(').replace(/\bMAX\s*\(/gi, 'MAXF(').replace(/\bSUM\s*\(/gi, 'SUMF(');
    // eslint-disable-next-line no-new-func
    const result = Function(...fns, `"use strict"; return (${expr});`)(...fns.map((f) => impl[f]));
    if (result === '' || result == null) return '';
    if (typeof result === 'number') {
      if (!isFinite(result)) return '#오류';
      return String(Math.round(result * 1e10) / 1e10);
    }
    if (typeof result === 'boolean') return result ? 'TRUE' : 'FALSE';
    return String(result);
  } catch {
    return '#오류';
  }
}

const COLORS = ['#30a46c', '#e5484d', '#f76808', '#4f7cff', '#8e4ec6', '#0091ff', '#d6409f'];

/* 구글 시트식 툴바 아이콘 — 16px stroke 미니 세트 */
const SI = ({ children }: { children: React.ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);
const SUndo = () => <SI><path d="M6 3 3 6l3 3" /><path d="M3 6h6.5a3.5 3.5 0 0 1 0 7H6" /></SI>;
const SRedo = () => <SI><path d="m10 3 3 3-3 3" /><path d="M13 6H6.5a3.5 3.5 0 0 0 0 7H10" /></SI>;
const SPaint = () => <SI><path d="M10.5 1.5 3.6 8.4a1.2 1.2 0 0 0 0 1.7l2.3 2.3a1.2 1.2 0 0 0 1.7 0L14.5 5.5z" /><path d="m8 4 4 4" /><path d="M13.8 10.5s1.2 1.6 1.2 2.5a1.2 1.2 0 0 1-2.4 0c0-.9 1.2-2.5 1.2-2.5Z" fill="currentColor" stroke="none" /></SI>;
const SBorder = () => <SI><rect x="2" y="2" width="12" height="12" rx="1" /><line x1="8" y1="2" x2="8" y2="14" /><line x1="2" y1="8" x2="14" y2="8" /></SI>;
const SMerge = () => <SI><rect x="1.5" y="3" width="13" height="10" rx="1" /><path d="m5.5 6 2 2-2 2" /><path d="m10.5 6-2 2 2 2" /></SI>;
const SSearch = () => <SI><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></SI>;
const SSort = () => <SI><path d="M5 3v10M5 13l-2-2M5 13l2-2" /><path d="M11 13V3M11 3 9 5M11 3l2 2" /></SI>;
const SFilter = () => <SI><path d="M2 3h12l-4.5 5.2V13l-3 1.5V8.2Z" /></SI>;
const SCf = () => <SI><rect x="2" y="2" width="12" height="12" rx="1.5" /><path d="M2 2h6v12H2z" fill="currentColor" stroke="none" opacity="0.5" /></SI>;
const SChart = () => <SI><line x1="4" y1="13" x2="4" y2="8" /><line x1="8" y1="13" x2="8" y2="4" /><line x1="12" y1="13" x2="12" y2="10" /><line x1="2" y1="14" x2="14" y2="14" /></SI>;
const SFreeze = () => <SI><rect x="2" y="2" width="12" height="12" rx="1" /><path d="M2 6h12" /><rect x="2.6" y="2.6" width="10.8" height="2.9" fill="currentColor" stroke="none" opacity="0.55" /></SI>;
const SRowCol = () => <SI><rect x="2" y="2" width="12" height="12" rx="1" /><line x1="8" y1="2" x2="8" y2="14" /><line x1="2" y1="8" x2="14" y2="8" /><path d="M8 8h6v6H8z" fill="currentColor" stroke="none" opacity="0.4" /></SI>;

interface SheetMeta {
  id: string;
  name: string;
  ord: number;
  cellsKey: string;
}

interface CellStyle {
  b?: boolean; // 굵게
  i?: boolean; // 기울임
  color?: string; // 글자색
  bg?: string; // 채우기
  align?: 'left' | 'center' | 'right';
  bt?: boolean; // 테두리 상/우/하/좌
  br?: boolean;
  bb?: boolean;
  bl?: boolean;
  fmt?: 'won' | 'pct' | 'comma'; // 숫자 서식
  dec?: number; // 소수점 자릿수
}

/** 숫자 서식 적용 — 값이 숫자일 때만 (₩1,234 / 12.3% / 1,234.5) */
function formatDisplay(s: string, sty: CellStyle): string {
  if (!sty.fmt && sty.dec === undefined) return s;
  if (s.trim() === '') return s;
  const n = parseFloat(s);
  if (isNaN(n) || !/^-?[\d.]+(e-?\d+)?$/i.test(s.trim())) return s;
  const dec = sty.dec;
  if (sty.fmt === 'pct') {
    const v = n * 100;
    const txt = dec !== undefined ? v.toFixed(dec) : String(Math.round(v * 100) / 100);
    return txt + '%';
  }
  let txt = dec !== undefined ? n.toFixed(dec) : String(n);
  if (sty.fmt === 'won' || sty.fmt === 'comma') {
    const [int, fr] = txt.split('.');
    const withComma = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    txt = fr ? `${withComma}.${fr}` : withComma;
  }
  return sty.fmt === 'won' ? '₩' + txt : txt;
}

interface MergeRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

interface CFRule {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
  op: '>' | '<' | '=' | 'contains';
  value: string;
  color: string;
}


const EMPTY_STYLE: CellStyle = {}; // 빈 셀 공용 ref (memo 안정화)

const CHART_COLORS = ['#21c818', '#4f7cff', '#f76808', '#e5484d', '#8e4ec6', '#0091ff', '#f5a524'];

/** 선택 범위로 SVG 차트 그리기 (막대/선/원) */
function renderChart(
  type: 'bar' | 'line' | 'pie',
  labels: string[],
  series: { name: string; data: number[] }[],
): React.ReactNode {
  const W = 600;
  const H = 340;
  const pad = { l: 46, r: 16, t: 16, b: 50 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  if (type === 'pie') {
    const data = series[0]?.data ?? [];
    const total = data.reduce((s, n) => s + Math.max(0, n), 0) || 1;
    let ang = -Math.PI / 2;
    const cx = W / 2;
    const cy = pad.t + ih / 2;
    const rad = Math.min(iw, ih) / 2 - 4;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%">
        {data.map((v, i) => {
          const frac = Math.max(0, v) / total;
          const a2 = ang + frac * 2 * Math.PI;
          const x1 = cx + rad * Math.cos(ang);
          const y1 = cy + rad * Math.sin(ang);
          const x2 = cx + rad * Math.cos(a2);
          const y2 = cy + rad * Math.sin(a2);
          const large = frac > 0.5 ? 1 : 0;
          const d = `M${cx},${cy} L${x1},${y1} A${rad},${rad} 0 ${large} 1 ${x2},${y2} Z`;
          ang = a2;
          return <path key={i} d={d} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke="var(--surface)" strokeWidth="1.5" />;
        })}
        {labels.map((l, i) => (
          <g key={i} transform={`translate(${16}, ${24 + i * 18})`}>
            <rect width="11" height="11" rx="2" fill={CHART_COLORS[i % CHART_COLORS.length]} />
            <text x="16" y="10" fontSize="12" fill="var(--text)">{l} ({data[i] ?? 0})</text>
          </g>
        ))}
      </svg>
    );
  }

  const allVals = series.flatMap((s) => s.data);
  const maxV = Math.max(1, ...allVals);
  const minV = Math.min(0, ...allVals);
  const range = maxV - minV || 1;
  const yOf = (v: number) => pad.t + ih - ((v - minV) / range) * ih;
  const n = labels.length;
  const groupW = iw / Math.max(1, n);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%">
      {/* 축 */}
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ih} stroke="var(--border)" />
      <line x1={pad.l} y1={pad.t + ih} x2={pad.l + iw} y2={pad.t + ih} stroke="var(--border)" />
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
        const v = minV + range * f;
        const y = yOf(v);
        return (
          <g key={i}>
            <line x1={pad.l} y1={y} x2={pad.l + iw} y2={y} stroke="var(--border)" strokeDasharray="2 3" opacity="0.5" />
            <text x={pad.l - 6} y={y + 4} fontSize="10" textAnchor="end" fill="var(--text-sub)">
              {Math.round(v * 100) / 100}
            </text>
          </g>
        );
      })}
      {/* 데이터 */}
      {type === 'bar'
        ? series.map((s, si) =>
            s.data.map((v, i) => {
              const bw = (groupW * 0.7) / series.length;
              const x = pad.l + i * groupW + groupW * 0.15 + si * bw;
              const y = yOf(v);
              const y0 = yOf(0);
              return (
                <rect key={`${si}-${i}`} x={x} y={Math.min(y, y0)} width={bw} height={Math.abs(y0 - y)} fill={CHART_COLORS[si % CHART_COLORS.length]} rx="1.5" />
              );
            }),
          )
        : series.map((s, si) => {
            const pts = s.data
              .map((v, i) => `${pad.l + i * groupW + groupW / 2},${yOf(v)}`)
              .join(' ');
            return <polyline key={si} points={pts} fill="none" stroke={CHART_COLORS[si % CHART_COLORS.length]} strokeWidth="2.5" strokeLinejoin="round" />;
          })}
      {/* x 라벨 */}
      {labels.map((l, i) => (
        <text key={i} x={pad.l + i * groupW + groupW / 2} y={pad.t + ih + 16} fontSize="11" textAnchor="middle" fill="var(--text-sub)">
          {l.length > 8 ? l.slice(0, 7) + '…' : l}
        </text>
      ))}
      {/* 범례 */}
      {series.length > 1 &&
        series.map((s, i) => (
          <g key={i} transform={`translate(${pad.l + i * 90}, ${H - 8})`}>
            <rect width="10" height="10" rx="2" fill={CHART_COLORS[i % CHART_COLORS.length]} />
            <text x="14" y="9" fontSize="11" fill="var(--text)">{s.name}</text>
          </g>
        ))}
    </svg>
  );
}

interface SheetCellProps {
  r: number;
  c: number;
  value: string;
  style: CellStyle;
  colSpan?: number;
  rowSpan?: number;
  active: boolean;
  inRange: boolean;
  inFill: boolean;
  fillHandle: boolean;
  isFormula: boolean;
  cfBg?: string;
  editing: boolean;
  editValue: string;
  editRef: React.RefObject<HTMLInputElement | null>;
  onDown: (r: number, c: number, shift: boolean) => void;
  onEnter: (r: number, c: number) => void;
  onDbl: (r: number, c: number) => void;
  onEditChange: (r: number, c: number, v: string) => void;
  onEditKey: (r: number, c: number, e: React.KeyboardEvent) => void;
  onEditBlur: () => void;
  onFillStart: () => void;
}

/** 메모이즈된 셀 — 자기 props가 바뀔 때만 리렌더 (드래그 시 1560칸 전체 리렌더 방지) */
const SheetCell = memo(function SheetCell({
  r,
  c,
  value,
  style: sty,
  colSpan,
  rowSpan,
  active,
  inRange,
  inFill,
  fillHandle,
  isFormula,
  cfBg,
  editing,
  editValue,
  editRef,
  onDown,
  onEnter,
  onDbl,
  onEditChange,
  onEditKey,
  onEditBlur,
  onFillStart,
}: SheetCellProps) {
  const cellStyle: React.CSSProperties = {
    fontWeight: sty.b ? 700 : undefined,
    fontStyle: sty.i ? 'italic' : undefined,
    color: sty.color || undefined,
    background: cfBg || sty.bg || undefined,
    textAlign: sty.align,
    borderTop: sty.bt ? '2px solid var(--text)' : undefined,
    borderRight: sty.br ? '2px solid var(--text)' : undefined,
    borderBottom: sty.bb ? '2px solid var(--text)' : undefined,
    borderLeft: sty.bl ? '2px solid var(--text)' : undefined,
  };
  return (
    <td
      colSpan={colSpan}
      rowSpan={rowSpan}
      style={cellStyle}
      className={`${active ? 'sel' : ''}${inRange ? ' inrange' : ''}${inFill ? ' infill' : ''}${isFormula ? ' formula' : ''}`}
      onMouseDown={(e) => {
        if (!editing) onDown(r, c, e.shiftKey);
      }}
      onMouseEnter={() => onEnter(r, c)}
      onDoubleClick={() => onDbl(r, c)}
    >
      {editing ? (
        <input
          ref={editRef}
          className="sheet-cell-input"
          value={editValue}
          onChange={(e) => onEditChange(r, c, e.target.value)}
          onBlur={onEditBlur}
          onKeyDown={(e) => onEditKey(r, c, e)}
        />
      ) : (
        <span className="sheet-cell-val">{value}</span>
      )}
      {fillHandle && !editing && (
        <span
          className="sheet-fillhandle"
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onFillStart();
          }}
        />
      )}
    </td>
  );
});

/** Yjs 기반 협업 스프레드시트 — 여러 시트(하단 탭), roomId 단위 공유 */
export default function SheetEditor({ roomId }: { roomId: string }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const ydocRef = useRef<Y.Doc | null>(null);
  const sheetsMapRef = useRef<Y.Map<{ name: string; ord: number; cellsKey: string }> | null>(null);
  const cellsRef = useRef<Y.Map<unknown> | null>(null);
  const stylesRef = useRef<Y.Map<CellStyle> | null>(null);
  const mergesRef = useRef<Y.Array<MergeRange> | null>(null);
  const undoRef = useRef<Y.UndoManager | null>(null);
  const clipRef = useRef<{ rows: number; cols: number; cells: { v: string; s: CellStyle }[][] } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const cfRef = useRef<Y.Array<CFRule> | null>(null);
  const [cfRules, setCfRules] = useState<CFRule[]>([]);
  const [filter, setFilter] = useState<{ col: number; text: string } | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [cfForm, setCfForm] = useState<{ op: CFRule['op']; value: string; color: string } | null>(null);
  const [chart, setChart] = useState<{ type: 'bar' | 'line' | 'pie' } | null>(null);
  const [merges, setMerges] = useState<MergeRange[]>([]);
  const [menu, setMenu] = useState<'fill' | 'text' | 'border' | 'merge' | 'rowcol' | 'sort' | null>(null);
  const [, bump] = useState(0);
  const [contentVer, setContentVer] = useState(0); // 셀 값 변경 버전 (값 메모이즈용)
  const rafRef = useRef(0);
  const pendingSelRef = useRef<{ r: number; c: number } | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [peers, setPeers] = useState(1);
  const [sheets, setSheets] = useState<SheetMeta[]>([]);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [renamingSheet, setRenamingSheet] = useState<{ id: string; name: string } | null>(null);
  const [sel, setSel] = useState<{ r: number; c: number }>({ r: 0, c: 0 }); // 활성(포커스) 셀
  const [anchor, setAnchor] = useState<{ r: number; c: number }>({ r: 0, c: 0 }); // 선택 시작점
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);
  // 행높이·열너비 (Yjs 공유) — 키 'c:3'|'r:5' → px
  const dimsRef = useRef<Y.Map<number> | null>(null);
  const [dims, setDims] = useState<Record<string, number>>({});
  const [freeze, setFreeze] = useState(false); // 틀 고정 (첫 데이터 행)
  // 채우기 핸들 드래그
  const fillingRef = useRef<MergeRange | null>(null);
  const [fillPrev, setFillPrev] = useState<MergeRange | null>(null);
  const fillPrevRef = useRef<MergeRange | null>(null);
  fillPrevRef.current = fillPrev;

  // 드래그 종료 (그리드 밖에서 마우스 떼도 처리) + 채우기 핸들 확정
  useEffect(() => {
    const up = () => {
      draggingRef.current = false;
      if (fillingRef.current) {
        const src = fillingRef.current;
        const target = fillPrevRef.current;
        fillingRef.current = null;
        setFillPrev(null);
        if (target) applyFillRef.current(src, target);
      }
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  function selectCell(r: number, c: number) {
    setAnchor({ r, c });
    setSel({ r, c });
  }

  useEffect(() => {
    const ydoc = new Y.Doc();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const provider = new WebsocketProvider(`${proto}://${location.host}/yjs`, roomId, ydoc, {
      params: { token: token ?? '' },
    });
    const sheetsMap = ydoc.getMap<{ name: string; ord: number; cellsKey: string }>('sheets');
    ydocRef.current = ydoc;
    sheetsMapRef.current = sheetsMap;
    setStatus(provider.wsconnected ? 'connected' : 'connecting');

    const syncSheets = () => {
      const list: SheetMeta[] = [];
      sheetsMap.forEach((v, id) => list.push({ id, name: v.name, ord: v.ord, cellsKey: v.cellsKey }));
      list.sort((a, b) => a.ord - b.ord);
      setSheets(list);
      setActiveSheetId((cur) => (cur && list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null));
    };
    sheetsMap.observe(syncSheets);
    syncSheets();

    provider.on('sync', (isSynced: boolean) => {
      if (isSynced && sheetsMap.size === 0) {
        const legacy = ydoc.getMap('cells'); // 기존 단일시트 데이터 보존
        const id = crypto.randomUUID();
        sheetsMap.set(id, {
          name: '시트1',
          ord: 1,
          cellsKey: legacy.size > 0 ? 'cells' : `cells:${id}`,
        });
      }
    });

    const onStatus = (e: { status: 'connecting' | 'connected' | 'disconnected' }) =>
      setStatus(e.status);
    provider.on('status', onStatus);
    const onAwareness = () => setPeers(provider.awareness.getStates().size || 1);
    provider.awareness.on('change', onAwareness);
    const color = COLORS[(user?.id ?? 0) % COLORS.length];
    provider.awareness.setLocalStateField('user', { name: user?.username ?? '익명', color });

    return () => {
      sheetsMap.unobserve(syncSheets);
      provider.off('status', onStatus);
      provider.awareness.off('change', onAwareness);
      provider.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      sheetsMapRef.current = null;
      cellsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, token]);

  // 활성 시트의 셀 맵 바인딩
  const activeSheet = sheets.find((s) => s.id === activeSheetId) ?? null;
  useEffect(() => {
    const ydoc = ydocRef.current;
    if (!ydoc || !activeSheet) return;
    const cells = ydoc.getMap(activeSheet.cellsKey);
    const styles = ydoc.getMap<CellStyle>(`${activeSheet.cellsKey}:style`);
    const mergeArr = ydoc.getArray<MergeRange>(`${activeSheet.cellsKey}:merge`);
    const cfArr = ydoc.getArray<CFRule>(`${activeSheet.cellsKey}:cf`);
    const dimMap = ydoc.getMap<number>(`${activeSheet.cellsKey}:dim`);
    cellsRef.current = cells;
    stylesRef.current = styles;
    mergesRef.current = mergeArr;
    cfRef.current = cfArr;
    dimsRef.current = dimMap;
    const um = new Y.UndoManager([cells, styles, mergeArr], { captureTimeout: 350 });
    undoRef.current = um;
    setMerges(mergeArr.toArray());
    setCfRules(cfArr.toArray());
    setDims(dimMap.toJSON() as Record<string, number>);
    setContentVer((n) => n + 1);
    const onCells = () => setContentVer((n) => n + 1);
    const onStyles = () => bump((n) => n + 1);
    const onMerges = () => setMerges(mergeArr.toArray());
    const onCf = () => setCfRules(cfArr.toArray());
    const onDims = () => setDims(dimMap.toJSON() as Record<string, number>);
    cells.observe(onCells);
    styles.observe(onStyles);
    mergeArr.observe(onMerges);
    cfArr.observe(onCf);
    dimMap.observe(onDims);
    return () => {
      cells.unobserve(onCells);
      styles.unobserve(onStyles);
      mergeArr.unobserve(onMerges);
      cfArr.unobserve(onCf);
      dimMap.unobserve(onDims);
      um.destroy();
    };
  }, [activeSheet?.cellsKey]);

  function raw(r: number, c: number): string {
    return (cellsRef.current?.get(cellKey(r, c)) as string) ?? '';
  }
  function display(r: number, c: number): string {
    const cells = cellsRef.current;
    if (!cells) return '';
    const k = cellKey(r, c);
    return evalCell(cells.get(k) as string, cells, new Set(), k);
  }
  function setCell(r: number, c: number, value: string) {
    const cells = cellsRef.current;
    if (!cells) return;
    const k = cellKey(r, c);
    if (value === '') cells.delete(k);
    else cells.set(k, value);
  }

  // ── 스타일 / 병합 ──
  function styleOf(r: number, c: number): CellStyle {
    return stylesRef.current?.get(cellKey(r, c)) ?? EMPTY_STYLE;
  }
  function curRange(): MergeRange {
    return {
      r1: Math.min(anchor.r, sel.r),
      c1: Math.min(anchor.c, sel.c),
      r2: Math.max(anchor.r, sel.r),
      c2: Math.max(anchor.c, sel.c),
    };
  }
  function patchStyleRange(fn: (cur: CellStyle) => CellStyle) {
    const st = stylesRef.current;
    if (!st) return;
    const { r1, c1, r2, c2 } = curRange();
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        const k = cellKey(r, c);
        const next = fn(st.get(k) ?? {});
        const cleaned = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined && v !== false && v !== ''));
        if (Object.keys(cleaned).length === 0) st.delete(k);
        else st.set(k, cleaned as CellStyle);
      }
  }
  function toggleBI(key: 'b' | 'i') {
    const { r1, c1 } = curRange();
    const on = !styleOf(r1, c1)[key];
    patchStyleRange((cur) => ({ ...cur, [key]: on || undefined }));
  }
  function setAlign(align: 'left' | 'center' | 'right') {
    patchStyleRange((cur) => ({ ...cur, align }));
  }
  function setFill(bg: string) {
    patchStyleRange((cur) => ({ ...cur, bg: bg || undefined }));
    setMenu(null);
  }
  function setTextColor(color: string) {
    patchStyleRange((cur) => ({ ...cur, color }));
    setMenu(null);
  }
  function applyBorder(mode: 'all' | 'outer' | 'none') {
    const st = stylesRef.current;
    if (!st) return;
    const { r1, c1, r2, c2 } = curRange();
    for (let r = r1; r <= r2; r++)
      for (let c = c1; c <= c2; c++) {
        const k = cellKey(r, c);
        const cur = { ...(st.get(k) ?? {}) };
        if (mode === 'none') {
          delete cur.bt;
          delete cur.br;
          delete cur.bb;
          delete cur.bl;
        } else if (mode === 'all') {
          cur.bt = cur.br = cur.bb = cur.bl = true;
        } else {
          // outer: 가장자리만
          if (r === r1) cur.bt = true;
          if (r === r2) cur.bb = true;
          if (c === c1) cur.bl = true;
          if (c === c2) cur.br = true;
        }
        const cleaned = Object.fromEntries(Object.entries(cur).filter(([, v]) => v !== undefined && v !== false && v !== ''));
        if (Object.keys(cleaned).length === 0) st.delete(k);
        else st.set(k, cleaned as CellStyle);
      }
  }
  function mergeSel() {
    const arr = mergesRef.current;
    if (!arr) return;
    const range = curRange();
    if (range.r1 === range.r2 && range.c1 === range.c2) return; // 단일 셀
    // 겹치는 기존 병합 제거
    unmergeSel();
    // 좌상단 외 값 비우기
    for (let r = range.r1; r <= range.r2; r++)
      for (let c = range.c1; c <= range.c2; c++) {
        if (r === range.r1 && c === range.c1) continue;
        setCell(r, c, '');
      }
    mergesRef.current?.push([range]);
  }
  function unmergeSel() {
    const arr = mergesRef.current;
    if (!arr) return;
    const { r1, c1, r2, c2 } = curRange();
    const all = arr.toArray();
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      const overlap = !(m.c2 < c1 || m.c1 > c2 || m.r2 < r1 || m.r1 > r2);
      if (overlap) arr.delete(i, 1);
    }
  }
  // (r,c)를 덮는 병합 반환
  function mergeCovering(r: number, c: number): MergeRange | null {
    for (const m of merges) {
      if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) return m;
    }
    return null;
  }

  // ── 숫자 서식 ──
  function setNumFmt(fmt: CellStyle['fmt'] | 'clear' | 'dec+' | 'dec-') {
    patchStyleRange((cur) => {
      if (fmt === 'clear') return { ...cur, fmt: undefined, dec: undefined };
      if (fmt === 'dec+') return { ...cur, dec: Math.min((cur.dec ?? 0) + 1, 8) };
      if (fmt === 'dec-') {
        const next = (cur.dec ?? 2) - 1;
        return { ...cur, dec: next <= 0 ? 0 : next };
      }
      return { ...cur, fmt };
    });
    if (fmt !== 'dec+' && fmt !== 'dec-') setMenu(null);
  }

  // ── 채우기 핸들 ──
  /** 상대 참조 이동 (채우기용) — 범위 밖은 #REF */
  function shiftRel(f: string, dr: number, dc: number): string {
    return f.replace(/\b([A-Za-z])(\d+)\b/g, (m, col: string, row: string) => {
      const ref = parseRef(`${col}${row}`.toUpperCase());
      if (!ref) return m;
      const nc = ref.c + dc;
      const nr = ref.r + dr;
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) return '#REF';
      return String.fromCharCode(65 + nc) + (nr + 1);
    });
  }
  function applyFill(src: MergeRange, target: MergeRange) {
    const cells = cellsRef.current;
    const styles = stylesRef.current;
    const ydoc = ydocRef.current;
    if (!cells || !styles || !ydoc) return;
    const down = target.r1 > src.r2; // 아니면 오른쪽 채우기
    undoRef.current?.stopCapturing();
    ydoc.transact(() => {
      if (down) {
        for (let c = src.c1; c <= src.c2; c++) {
          const srcVals: string[] = [];
          for (let r = src.r1; r <= src.r2; r++) srcVals.push(raw(r, c));
          const nums = srcVals.map((v) => parseFloat(v));
          const numericSeq =
            srcVals.length >= 2 &&
            srcVals.every((v, i) => v.trim() !== '' && !isNaN(nums[i]) && v[0] !== '=');
          const step = numericSeq ? nums[nums.length - 1] - nums[nums.length - 2] : 0;
          for (let r = target.r1; r <= target.r2; r++) {
            const k = r - src.r1;
            const si = k % srcVals.length;
            const srcR = src.r1 + si;
            const v = srcVals[si];
            let nv = v;
            if (v[0] === '=') nv = shiftRel(v, r - srcR, 0);
            else if (numericSeq) nv = String(nums[nums.length - 1] + step * (r - src.r2));
            setCell(r, c, nv);
            const s = stylesRef.current?.get(cellKey(srcR, c));
            if (s && Object.keys(s).length) styles.set(cellKey(r, c), { ...s });
            else styles.delete(cellKey(r, c));
          }
        }
      } else {
        for (let r = src.r1; r <= src.r2; r++) {
          const srcVals: string[] = [];
          for (let c = src.c1; c <= src.c2; c++) srcVals.push(raw(r, c));
          const nums = srcVals.map((v) => parseFloat(v));
          const numericSeq =
            srcVals.length >= 2 &&
            srcVals.every((v, i) => v.trim() !== '' && !isNaN(nums[i]) && v[0] !== '=');
          const step = numericSeq ? nums[nums.length - 1] - nums[nums.length - 2] : 0;
          for (let c = target.c1; c <= target.c2; c++) {
            const k = c - src.c1;
            const si = k % srcVals.length;
            const srcC = src.c1 + si;
            const v = srcVals[si];
            let nv = v;
            if (v[0] === '=') nv = shiftRel(v, 0, c - srcC);
            else if (numericSeq) nv = String(nums[nums.length - 1] + step * (c - src.c2));
            setCell(r, c, nv);
            const s = stylesRef.current?.get(cellKey(r, srcC));
            if (s && Object.keys(s).length) styles.set(cellKey(r, c), { ...s });
            else styles.delete(cellKey(r, c));
          }
        }
      }
    });
    // 채운 영역까지 선택 확장 (엑셀과 동일)
    setAnchor({ r: src.r1, c: src.c1 });
    setSel({ r: Math.max(src.r2, target.r2), c: Math.max(src.c2, target.c2) });
  }
  const applyFillRef = useRef(applyFill);
  applyFillRef.current = applyFill;

  // ── 행높이·열너비 ──
  function colW(c: number): number {
    return dims[`c:${c}`] ?? 96;
  }
  function rowH(r: number): number {
    return dims[`r:${r}`] ?? 26;
  }
  function startColResize(c: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colW(c);
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(40, Math.round(startW + ev.clientX - startX));
      setDims((d) => ({ ...d, [`c:${c}`]: w }));
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const w = Math.max(40, Math.round(startW + ev.clientX - startX));
      dimsRef.current?.set(`c:${c}`, w);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  function startRowResize(r: number, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = rowH(r);
    const onMove = (ev: MouseEvent) => {
      const h = Math.max(20, Math.round(startH + ev.clientY - startY));
      setDims((d) => ({ ...d, [`r:${r}`]: h }));
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const h = Math.max(20, Math.round(startH + ev.clientY - startY));
      dimsRef.current?.set(`r:${r}`, h);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ── 복사 / 잘라내기 / 붙여넣기 ──
  function copyRange(cut: boolean) {
    const cells = cellsRef.current;
    const styles = stylesRef.current;
    const ydoc = ydocRef.current;
    if (!cells || !styles) return;
    const { r1, c1, r2, c2 } = curRange();
    const block: { v: string; s: CellStyle }[][] = [];
    const tsv: string[] = [];
    for (let r = r1; r <= r2; r++) {
      const row: { v: string; s: CellStyle }[] = [];
      const tline: string[] = [];
      for (let c = c1; c <= c2; c++) {
        row.push({ v: raw(r, c), s: { ...styleOf(r, c) } });
        tline.push(display(r, c));
      }
      block.push(row);
      tsv.push(tline.join('\t'));
    }
    clipRef.current = { rows: r2 - r1 + 1, cols: c2 - c1 + 1, cells: block };
    navigator.clipboard?.writeText(tsv.join('\n')).catch(() => {});
    if (cut && ydoc) {
      ydoc.transact(() => {
        for (let r = r1; r <= r2; r++)
          for (let c = c1; c <= c2; c++) {
            setCell(r, c, '');
            styles.delete(cellKey(r, c));
          }
      });
    }
  }
  function paste() {
    const clip = clipRef.current;
    const cells = cellsRef.current;
    const styles = stylesRef.current;
    const ydoc = ydocRef.current;
    if (!clip || !cells || !styles || !ydoc) return;
    const { r, c } = sel;
    undoRef.current?.stopCapturing();
    ydoc.transact(() => {
      for (let dr = 0; dr < clip.rows; dr++)
        for (let dc = 0; dc < clip.cols; dc++) {
          const tr = r + dr;
          const tc = c + dc;
          if (tr >= ROWS || tc >= COLS) continue;
          const src = clip.cells[dr][dc];
          setCell(tr, tc, src.v);
          const k = cellKey(tr, tc);
          if (Object.keys(src.s).length) styles.set(k, { ...src.s });
          else styles.delete(k);
        }
    });
  }

  // ── 행/열 삽입·삭제 (수식 참조 보정 포함) ──
  function shiftFormula(f: string, type: 'row' | 'col', at: number, delta: number): string {
    return f.replace(/([A-Za-z])(\d+)/g, (m, col: string, row: string) => {
      const ci = col.toUpperCase().charCodeAt(0) - 65;
      const ri = parseInt(row, 10) - 1;
      if (ci < 0 || ci >= COLS || ri < 0) return m;
      const idx = type === 'row' ? ri : ci;
      let nidx = idx;
      if (delta < 0) {
        if (idx === at) return '#REF';
        if (idx > at) nidx = idx - 1;
      } else if (idx >= at) {
        nidx = idx + delta;
      }
      const nci = type === 'col' ? nidx : ci;
      const nri = type === 'row' ? nidx : ri;
      if (nci < 0 || nri < 0 || nci >= COLS) return '#REF';
      return String.fromCharCode(65 + nci) + (nri + 1);
    });
  }
  function structural(type: 'row' | 'col', at: number, delta: number) {
    const cells = cellsRef.current;
    const styles = stylesRef.current;
    const mg = mergesRef.current;
    const ydoc = ydocRef.current;
    if (!cells || !styles || !mg || !ydoc) return;
    const cellEntries = [...cells.entries()];
    const styleEntries = [...styles.entries()];
    undoRef.current?.stopCapturing();
    ydoc.transact(() => {
      cells.clear();
      styles.clear();
      const place = (map: Y.Map<unknown>, entries: [string, unknown][], isCell: boolean) => {
        for (const [k, v] of entries) {
          const ref = parseRef(k);
          if (!ref) continue;
          let { r, c } = ref;
          if (delta < 0) {
            if (type === 'row') {
              if (r === at) continue;
              if (r > at) r -= 1;
            } else {
              if (c === at) continue;
              if (c > at) c -= 1;
            }
          } else if (type === 'row') {
            if (r >= at) r += 1;
          } else if (c >= at) {
            c += 1;
          }
          let val = v;
          if (isCell && typeof v === 'string' && v[0] === '=') val = shiftFormula(v, type, at, delta);
          map.set(cellKey(r, c), val);
        }
      };
      place(cells, cellEntries as [string, unknown][], true);
      place(styles as unknown as Y.Map<unknown>, styleEntries as [string, unknown][], false);
      const newMerges: MergeRange[] = [];
      for (const m of mg.toArray()) {
        let { r1, c1, r2, c2 } = m;
        if (delta < 0) {
          if (type === 'row') {
            if (r1 > at) r1--;
            if (r2 >= at) r2--;
            if (r2 < r1) continue;
          } else {
            if (c1 > at) c1--;
            if (c2 >= at) c2--;
            if (c2 < c1) continue;
          }
        } else if (type === 'row') {
          if (r1 >= at) r1++;
          if (r2 >= at) r2++;
        } else {
          if (c1 >= at) c1++;
          if (c2 >= at) c2++;
        }
        newMerges.push({ r1, c1, r2, c2 });
      }
      mg.delete(0, mg.length);
      if (newMerges.length) mg.push(newMerges);
    });
  }

  function doReplaceAll() {
    const cells = cellsRef.current;
    const ydoc = ydocRef.current;
    if (!cells || !ydoc || !findText) return;
    ydoc.transact(() => {
      cells.forEach((v, k) => {
        if (typeof v === 'string' && v.includes(findText)) {
          cells.set(k, v.split(findText).join(replaceText));
        }
      });
    });
  }

  function usedBounds() {
    let maxR = 0;
    let maxC = 0;
    cellsRef.current?.forEach((_v, k) => {
      const ref = parseRef(k);
      if (ref) {
        maxR = Math.max(maxR, ref.r);
        maxC = Math.max(maxC, ref.c);
      }
    });
    return { maxR, maxC };
  }

  // ── 정렬 ──
  function sortRange(desc: boolean) {
    const cells = cellsRef.current;
    const styles = stylesRef.current;
    const ydoc = ydocRef.current;
    if (!cells || !styles || !ydoc) return;
    const rg = curRange();
    const { maxR, maxC } = usedBounds();
    const multi = rg.r1 !== rg.r2 || rg.c1 !== rg.c2;
    const R1 = multi ? rg.r1 : 0;
    const R2 = multi ? rg.r2 : maxR;
    const C1 = multi ? rg.c1 : 0;
    const C2 = multi ? rg.c2 : maxC;
    const keyCol = Math.min(Math.max(sel.c, C1), C2);
    const rowsArr: { key: string; cells: { v: string; s: CellStyle }[] }[] = [];
    for (let r = R1; r <= R2; r++) {
      const cellsRow: { v: string; s: CellStyle }[] = [];
      for (let c = C1; c <= C2; c++) cellsRow.push({ v: raw(r, c), s: { ...styleOf(r, c) } });
      rowsArr.push({ key: display(r, keyCol), cells: cellsRow });
    }
    rowsArr.sort((a, b) => {
      const an = parseFloat(a.key);
      const bn = parseFloat(b.key);
      const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : a.key.localeCompare(b.key);
      return desc ? -cmp : cmp;
    });
    undoRef.current?.stopCapturing();
    ydoc.transact(() => {
      for (let i = 0; i < rowsArr.length; i++) {
        const r = R1 + i;
        for (let j = 0; j < rowsArr[i].cells.length; j++) {
          const c = C1 + j;
          const src = rowsArr[i].cells[j];
          setCell(r, c, src.v);
          const k = cellKey(r, c);
          if (Object.keys(src.s).length) styles.set(k, src.s);
          else styles.delete(k);
        }
      }
    });
  }

  // ── 조건부 서식 ──
  function addCfRule(op: CFRule['op'], value: string, color: string) {
    const arr = cfRef.current;
    if (!arr) return;
    const { r1, c1, r2, c2 } = curRange();
    arr.push([{ r1, c1, r2, c2, op, value, color }]);
    setCfForm(null);
  }
  function clearCf() {
    cfRef.current?.delete(0, cfRef.current.length);
  }
  function cfBgFor(r: number, c: number, value: string): string | undefined {
    for (const rule of cfRules) {
      if (r < rule.r1 || r > rule.r2 || c < rule.c1 || c > rule.c2) continue;
      const vn = parseFloat(value);
      const tn = parseFloat(rule.value);
      let ok = false;
      if (rule.op === 'contains') ok = value.includes(rule.value);
      else if (rule.op === '=') ok = !isNaN(vn) && !isNaN(tn) ? vn === tn : value === rule.value;
      else if (!isNaN(vn) && !isNaN(tn)) ok = rule.op === '>' ? vn > tn : vn < tn;
      if (ok) return rule.color;
    }
    return undefined;
  }

  // ── 필터 ──
  function rowHidden(r: number, valueGrid: string[][]): boolean {
    if (!filter || !filter.text || r === 0) return false;
    const v = (valueGrid[r]?.[filter.col] ?? '').toLowerCase();
    return !v.includes(filter.text.toLowerCase());
  }

  // ── 차트 데이터 (선택 범위) ──
  function chartData(): { labels: string[]; series: { name: string; data: number[] }[] } {
    const rg = curRange();
    const labels: string[] = [];
    const series: { name: string; data: number[] }[] = [];
    const hasLabelCol = rg.c2 > rg.c1;
    const labelCol = rg.c1;
    const dataC1 = hasLabelCol ? rg.c1 + 1 : rg.c1;
    for (let r = rg.r1; r <= rg.r2; r++) labels.push(hasLabelCol ? display(r, labelCol) || `${r + 1}` : `${r + 1}`);
    for (let c = dataC1; c <= rg.c2; c++) {
      const data: number[] = [];
      for (let r = rg.r1; r <= rg.r2; r++) {
        const n = parseFloat(display(r, c));
        data.push(isNaN(n) ? 0 : n);
      }
      series.push({ name: colLetter(c), data });
    }
    return { labels, series };
  }

  function startEdit(r: number, c: number, initial?: string) {
    selectCell(r, c);
    setEditing({ r, c, value: initial ?? raw(r, c) });
    setTimeout(() => editRef.current?.focus(), 0);
  }
  function commitEdit(move: 'down' | 'right' | null) {
    if (!editing) return;
    setCell(editing.r, editing.c, editing.value);
    const { r, c } = editing;
    setEditing(null);
    if (move === 'down') selectCell(Math.min(r + 1, ROWS - 1), c);
    else if (move === 'right') selectCell(r, Math.min(c + 1, COLS - 1));
  }

  function clearRange() {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) setCell(r, c, '');
  }

  function newSheet() {
    const map = sheetsMapRef.current;
    if (!map) return;
    const ord = sheets.reduce((m, s) => Math.max(m, s.ord), 0) + 1;
    const id = crypto.randomUUID();
    map.set(id, { name: `시트${ord}`, ord, cellsKey: `cells:${id}` });
    setActiveSheetId(id);
    selectCell(0, 0);
  }
  function deleteSheet(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const map = sheetsMapRef.current;
    if (!map || sheets.length <= 1) return;
    if (!confirm('이 시트를 삭제할까요? (실시간 공유)')) return;
    const sh = sheets.find((s) => s.id === id);
    if (sh) ydocRef.current?.getMap(sh.cellsKey).clear();
    map.delete(id);
    if (id === activeSheetId) setActiveSheetId(sheets.find((s) => s.id !== id)?.id ?? null);
  }
  function commitSheetRename() {
    const map = sheetsMapRef.current;
    if (renamingSheet && map) {
      const name = renamingSheet.name.trim();
      const cur = map.get(renamingSheet.id);
      if (name && cur) map.set(renamingSheet.id, { ...cur, name });
    }
    setRenamingSheet(null);
  }

  function onGridKey(e: React.KeyboardEvent) {
    if (editing) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); if (e.shiftKey) undoRef.current?.redo(); else undoRef.current?.undo(); return; }
      if (k === 'y') { e.preventDefault(); undoRef.current?.redo(); return; }
      if (k === 'c') { e.preventDefault(); copyRange(false); return; }
      if (k === 'x') { e.preventDefault(); copyRange(true); return; }
      if (k === 'v') { e.preventDefault(); paste(); return; }
      if (k === 'f') { e.preventDefault(); setFindOpen(true); return; }
      return;
    }
    const { r, c } = sel;
    const shift = e.shiftKey;
    const move = (nr: number, nc: number) => {
      setSel({ r: nr, c: nc });
      if (!shift) setAnchor({ r: nr, c: nc });
    };
    if (e.key === 'ArrowUp') { move(Math.max(0, r - 1), c); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { move(Math.min(ROWS - 1, r + 1), c); e.preventDefault(); }
    else if (e.key === 'Enter') { selectCell(Math.min(ROWS - 1, r + 1), c); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { move(r, Math.max(0, c - 1)); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { move(r, Math.min(COLS - 1, c + 1)); e.preventDefault(); }
    else if (e.key === 'Tab') { selectCell(r, Math.min(COLS - 1, c + 1)); e.preventDefault(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { clearRange(); e.preventDefault(); }
    else if (e.key === 'F2') { startEdit(r, c); e.preventDefault(); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { startEdit(r, c, e.key); e.preventDefault(); }
  }

  function exportCsv() {
    const cells = cellsRef.current;
    if (!cells) return;
    // 사용된 범위 탐색
    let maxR = 0;
    let maxC = 0;
    cells.forEach((_v, k) => {
      const ref = parseRef(k);
      if (ref) {
        maxR = Math.max(maxR, ref.r);
        maxC = Math.max(maxC, ref.c);
      }
    });
    const rows: string[] = [];
    for (let r = 0; r <= maxR; r++) {
      const cols: string[] = [];
      for (let c = 0; c <= maxC; c++) {
        const v = display(r, c);
        cols.push(/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      }
      rows.push(cols.join(','));
    }
    const csv = '﻿' + rows.join('\r\n'); // BOM(엑셀 한글)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${roomId.replace(/^sheet-/, 'sheet_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 진짜 .xlsx (Open XML zip) — 모든 시트 포함, 값은 평가 결과 */
  async function exportXlsx() {
    const ydoc = ydocRef.current;
    if (!ydoc || !sheets.length) return;
    const { default: JSZip } = await import('jszip');
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const zip = new JSZip();
    const sheetXmls = sheets.map((sh) => {
      const cells = ydoc.getMap(sh.cellsKey);
      const dimMap = ydoc.getMap<number>(`${sh.cellsKey}:dim`);
      let maxR = 0;
      let maxC = 0;
      cells.forEach((_v, k) => {
        const ref = parseRef(k);
        if (ref) {
          maxR = Math.max(maxR, ref.r);
          maxC = Math.max(maxC, ref.c);
        }
      });
      const cols: string[] = [];
      for (let c = 0; c <= maxC; c++) {
        const w = dimMap.get(`c:${c}`);
        if (w) cols.push(`<col min="${c + 1}" max="${c + 1}" width="${(w / 7).toFixed(1)}" customWidth="1"/>`);
      }
      const rows: string[] = [];
      for (let r = 0; r <= maxR; r++) {
        const rcells: string[] = [];
        for (let c = 0; c <= maxC; c++) {
          const k = cellKey(r, c);
          const v = evalCell(cells.get(k) as string, cells, new Set(), k);
          if (v === '') continue;
          if (/^-?\d+(\.\d+)?$/.test(v.trim())) {
            rcells.push(`<c r="${k}"><v>${v.trim()}</v></c>`);
          } else {
            rcells.push(`<c r="${k}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`);
          }
        }
        if (rcells.length) rows.push(`<row r="${r + 1}">${rcells.join('')}</row>`);
      }
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols.length ? `<cols>${cols.join('')}</cols>` : ''}<sheetData>${rows.join('')}</sheetData></worksheet>`;
    });
    const sheetEntries = sheets.map((sh, i) => ({
      name: sh.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || `시트${i + 1}`,
      rid: `rId${i + 1}`,
      file: `sheet${i + 1}.xml`,
    }));
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheetEntries.map((s) => `<Override PartName="/xl/worksheets/${s.file}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    );
    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    );
    zip.file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="${s.rid}"/>`).join('')}</sheets></workbook>`,
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetEntries.map((s) => `<Relationship Id="${s.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${s.file}"/>`).join('')}</Relationships>`,
    );
    sheetXmls.forEach((xml, i) => zip.file(`xl/worksheets/${sheetEntries[i].file}`, xml));
    const blob = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${roomId.replace(/^sheet-/, 'sheet_')}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 메모이즈 셀에 넘길 안정적 콜백 (ref로 최신 상태 참조 → 매 렌더 동일 함수 ref)
  const cellApiRef = useRef<{
    down: (r: number, c: number, shift: boolean) => void;
    enter: (r: number, c: number) => void;
    dbl: (r: number, c: number) => void;
    editChange: (r: number, c: number, v: string) => void;
    editKey: (r: number, c: number, e: React.KeyboardEvent) => void;
    editBlur: () => void;
    fillStart: () => void;
  }>(null!);
  cellApiRef.current = {
    down: (r, c, shift) => {
      if (editing) commitEdit(null);
      if (shift) setSel({ r, c });
      else selectCell(r, c);
      draggingRef.current = true;
    },
    enter: (r, c) => {
      // 채우기 핸들 드래그 중 — 아래/오른쪽 방향으로 미리보기 범위 계산
      if (fillingRef.current) {
        const s = fillingRef.current;
        const dDown = r - s.r2;
        const dRight = c - s.c2;
        let fp: MergeRange | null = null;
        if (dDown > 0 && dDown >= dRight) fp = { r1: s.r2 + 1, c1: s.c1, r2: r, c2: s.c2 };
        else if (dRight > 0) fp = { r1: s.r1, c1: s.c2 + 1, r2: s.r2, c2: c };
        setFillPrev(fp);
        return;
      }
      if (!draggingRef.current || editing) return;
      pendingSelRef.current = { r, c };
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          const p = pendingSelRef.current;
          if (p) setSel(p);
        });
      }
    },
    fillStart: () => {
      fillingRef.current = curRange();
      setFillPrev(null);
    },
    dbl: (r, c) => startEdit(r, c),
    editChange: (r, c, v) => setEditing({ r, c, value: v }),
    editKey: (_r, _c, e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitEdit('down'); }
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit('right'); }
      else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
    },
    editBlur: () => commitEdit(null),
  };
  const cbDown = useCallback((r: number, c: number, s: boolean) => cellApiRef.current.down(r, c, s), []);
  const cbEnter = useCallback((r: number, c: number) => cellApiRef.current.enter(r, c), []);
  const cbDbl = useCallback((r: number, c: number) => cellApiRef.current.dbl(r, c), []);
  const cbEditChange = useCallback((r: number, c: number, v: string) => cellApiRef.current.editChange(r, c, v), []);
  const cbEditKey = useCallback((r: number, c: number, e: React.KeyboardEvent) => cellApiRef.current.editKey(r, c, e), []);
  const cbEditBlur = useCallback(() => cellApiRef.current.editBlur(), []);
  const cbFillStart = useCallback(() => cellApiRef.current.fillStart(), []);

  // 표시값 메모이즈 — 셀 값이 바뀔 때만 재계산(드래그 선택 중엔 재사용)
  const valueGrid = useMemo(() => {
    const g: string[][] = [];
    for (let r = 0; r < ROWS; r++) {
      const row: string[] = [];
      for (let c = 0; c < COLS; c++) row.push(display(r, c));
      g.push(row);
    }
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentVer, activeSheet?.cellsKey]);

  const statusLabel =
    status === 'connected' ? '실시간 연결됨' : status === 'connecting' ? '연결 중…' : '연결 끊김';
  const activeRaw = raw(sel.r, sel.c);
  const r1 = Math.min(anchor.r, sel.r);
  const r2 = Math.max(anchor.r, sel.r);
  const c1 = Math.min(anchor.c, sel.c);
  const c2 = Math.max(anchor.c, sel.c);
  const multi = r1 !== r2 || c1 !== c2;

  return (
    <div className="sheet-editor">
      <div className="sheet-bar">
        <div className="sheet-cellref">
          {multi ? `${cellKey(r1, c1)}:${cellKey(r2, c2)}` : cellKey(sel.r, sel.c)}
        </div>
        <span className="sheet-fx" aria-hidden>fx</span>
        <input
          className="sheet-formula"
          value={editing ? editing.value : activeRaw}
          placeholder="값 또는 =수식 (예: =SUM(A1:A5))"
          onChange={(e) =>
            setEditing({ r: sel.r, c: sel.c, value: e.target.value })
          }
          onFocus={() => !editing && setEditing({ r: sel.r, c: sel.c, value: activeRaw })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commitEdit('down'); (e.target as HTMLInputElement).blur(); }
            else if (e.key === 'Escape') setEditing(null);
          }}
        />
        <div className="sheet-right">
          <button className="sheet-csv" onClick={exportCsv} title="CSV로 내보내기">
            <DownloadIcon size={15} /> CSV
          </button>
          <button className="sheet-csv" onClick={() => void exportXlsx()} title="엑셀 파일로 내보내기">
            <DownloadIcon size={15} /> XLSX
          </button>
          <span className="code-doc-peers">{peers}명 참여</span>
          <span className={`code-doc-status ${status}`}>
            <i /> {statusLabel}
          </span>
        </div>
      </div>

      {/* 서식 툴바 — 구글 시트식 알약 스트립 */}
      <div className="sheet-toolbar">
        <button className="sht-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => undoRef.current?.undo()} title="실행 취소 (Ctrl+Z)">
          <SUndo />
        </button>
        <button className="sht-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => undoRef.current?.redo()} title="다시 실행 (Ctrl+Y)">
          <SRedo />
        </button>
        <span className="sht-sep" />
        {/* 숫자 서식 — 시트처럼 직접 버튼 */}
        <button className={`sht-btn${styleOf(sel.r, sel.c).fmt === 'won' ? ' on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => setNumFmt(styleOf(sel.r, sel.c).fmt === 'won' ? 'clear' : 'won')} title="통화 서식">
          ₩
        </button>
        <button className={`sht-btn${styleOf(sel.r, sel.c).fmt === 'pct' ? ' on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => setNumFmt(styleOf(sel.r, sel.c).fmt === 'pct' ? 'clear' : 'pct')} title="백분율 서식">
          %
        </button>
        <button className={`sht-btn${styleOf(sel.r, sel.c).fmt === 'comma' ? ' on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => setNumFmt(styleOf(sel.r, sel.c).fmt === 'comma' ? 'clear' : 'comma')} title="천 단위 콤마">
          ,
        </button>
        <button className="sht-btn wide" onMouseDown={(e) => e.preventDefault()} onClick={() => setNumFmt('dec-')} title="소수점 줄이기">
          .0−
        </button>
        <button className="sht-btn wide" onMouseDown={(e) => e.preventDefault()} onClick={() => setNumFmt('dec+')} title="소수점 늘리기">
          .00＋
        </button>
        <span className="sht-sep" />
        <button className={`sht-btn${styleOf(sel.r, sel.c).b ? ' on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => toggleBI('b')} title="굵게">
          <b>B</b>
        </button>
        <button className={`sht-btn${styleOf(sel.r, sel.c).i ? ' on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => toggleBI('i')} title="기울임">
          <i>I</i>
        </button>
        <div className="sht-pop-wrap">
          <button className="sht-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === 'text' ? null : 'text')} title="글자 색">
            <span className="doc-colorA" style={{ ['--c' as string]: styleOf(sel.r, sel.c).color ?? 'var(--text)' }}>A</span>
          </button>
          {menu === 'text' && (
            <>
              <div className="sht-back" onClick={() => setMenu(null)} />
              <div className="sht-pop">
                <ColorGrid
                  value={styleOf(sel.r, sel.c).color}
                  noneLabel="기본"
                  onPick={(c) => setTextColor(c)}
                />
              </div>
            </>
          )}
        </div>
        <div className="sht-pop-wrap">
          <button className="sht-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === 'fill' ? null : 'fill')} title="채우기 색">
            <SPaint />
          </button>
          {menu === 'fill' && (
            <>
              <div className="sht-back" onClick={() => setMenu(null)} />
              <div className="sht-pop">
                <ColorGrid
                  value={styleOf(sel.r, sel.c).bg}
                  noneLabel="채우기 없음"
                  onPick={(c) => setFill(c)}
                />
              </div>
            </>
          )}
        </div>
        <div className="sht-pop-wrap">
          <button className="sht-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === 'border' ? null : 'border')} title="테두리">
            <SBorder />
          </button>
          {menu === 'border' && (
            <>
              <div className="sht-back" onClick={() => setMenu(null)} />
              <div className="sht-pop sht-pop-border">
                <button onClick={() => { applyBorder('all'); setMenu(null); }}>모든 테두리</button>
                <button onClick={() => { applyBorder('outer'); setMenu(null); }}>바깥 테두리</button>
                <button onClick={() => { applyBorder('none'); setMenu(null); }}>테두리 없음</button>
              </div>
            </>
          )}
        </div>
        <div className="sht-pop-wrap">
          <button className="sht-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === 'merge' ? null : 'merge')} title="셀 병합">
            <SMerge />
          </button>
          {menu === 'merge' && (
            <>
              <div className="sht-back" onClick={() => setMenu(null)} />
              <div className="sht-pop sht-pop-border">
                <button onClick={() => { mergeSel(); setMenu(null); }}>선택 영역 병합</button>
                <button onClick={() => { unmergeSel(); setMenu(null); }}>병합 해제</button>
              </div>
            </>
          )}
        </div>
        <span className="sht-sep" />
        {(['left', 'center', 'right'] as const).map((a) => (
          <button
            key={a}
            className={`sht-btn${styleOf(sel.r, sel.c).align === a ? ' on' : ''}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setAlign(a)}
            title={a === 'left' ? '왼쪽 정렬' : a === 'center' ? '가운데 정렬' : '오른쪽 정렬'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <line x1="1" y1="3" x2="13" y2="3" />
              <line x1={a === 'left' ? 1 : a === 'center' ? 3.2 : 5.5} y1="7" x2={a === 'left' ? 8.5 : a === 'center' ? 10.8 : 13} y2="7" />
              <line x1="1" y1="11" x2="13" y2="11" />
            </svg>
          </button>
        ))}
        <span className="sht-sep" />
        <div className="sht-pop-wrap">
          <button className="sht-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === 'rowcol' ? null : 'rowcol')} title="행·열 삽입/삭제">
            <SRowCol />
          </button>
          {menu === 'rowcol' && (
            <>
              <div className="sht-back" onClick={() => setMenu(null)} />
              <div className="sht-pop sht-pop-border">
                <button onClick={() => { structural('row', sel.r, 1); setMenu(null); }}>위에 행 삽입</button>
                <button onClick={() => { structural('row', sel.r, -1); setMenu(null); }}>행 삭제</button>
                <button onClick={() => { structural('col', sel.c, 1); setMenu(null); }}>왼쪽에 열 삽입</button>
                <button onClick={() => { structural('col', sel.c, -1); setMenu(null); }}>열 삭제</button>
              </div>
            </>
          )}
        </div>
        <div className="sht-pop-wrap">
          <button className="sht-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setMenu(menu === 'sort' ? null : 'sort')} title="정렬">
            <SSort />
          </button>
          {menu === 'sort' && (
            <>
              <div className="sht-back" onClick={() => setMenu(null)} />
              <div className="sht-pop sht-pop-border">
                <button onClick={() => { sortRange(false); setMenu(null); }}>오름차순 정렬</button>
                <button onClick={() => { sortRange(true); setMenu(null); }}>내림차순 정렬</button>
              </div>
            </>
          )}
        </div>
        <button className={`sht-btn${filter ? ' on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => { setFilterOpen((v) => !v); if (!filterOpen) setFilter({ col: sel.c, text: '' }); }} title="필터">
          <SFilter />
        </button>
        <button className={`sht-btn${cfRules.length ? ' on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => setCfForm(cfForm ? null : { op: '>', value: '', color: '#ffc9c9' })} title="조건부 서식">
          <SCf />
        </button>
        <button className="sht-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setChart({ type: 'bar' })} title="차트 만들기">
          <SChart />
        </button>
        <button className={`sht-btn${freeze ? ' on' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => setFreeze((v) => !v)} title="첫 행 틀 고정">
          <SFreeze />
        </button>
        <button className="sht-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setFindOpen((v) => !v)} title="찾기·바꾸기 (Ctrl+F)">
          <SSearch />
        </button>
      </div>

      {filterOpen && (
        <div className="sheet-find">
          <span className="sheet-find-label">필터 열</span>
          <select
            value={filter?.col ?? sel.c}
            onChange={(e) => setFilter({ col: +e.target.value, text: filter?.text ?? '' })}
          >
            {Array.from({ length: COLS }, (_, c) => (
              <option key={c} value={c}>{colLetter(c)}</option>
            ))}
          </select>
          <input
            placeholder="포함할 값 (비우면 전체)"
            value={filter?.text ?? ''}
            onChange={(e) => setFilter({ col: filter?.col ?? sel.c, text: e.target.value })}
            autoFocus
          />
          <button className="sheet-find-close" onClick={() => { setFilter(null); setFilterOpen(false); }}>
            해제 ✕
          </button>
        </div>
      )}

      {cfForm && (
        <div className="sheet-find">
          <span className="sheet-find-label">선택 영역이</span>
          <select value={cfForm.op} onChange={(e) => setCfForm({ ...cfForm, op: e.target.value as CFRule['op'] })}>
            <option value=">">보다 큼 &gt;</option>
            <option value="<">보다 작음 &lt;</option>
            <option value="=">같음 =</option>
            <option value="contains">포함</option>
          </select>
          <input
            placeholder="값"
            value={cfForm.value}
            onChange={(e) => setCfForm({ ...cfForm, value: e.target.value })}
          />
          {['#ffc9c9', '#d3f9d8', '#fff3bf', '#a5d8ff', '#d0bfff'].map((col) => (
            <button
              key={col}
              className="sht-swatch"
              style={{ background: col, outline: cfForm.color === col ? '2px solid var(--green)' : undefined }}
              onClick={() => setCfForm({ ...cfForm, color: col })}
            />
          ))}
          <button onClick={() => addCfRule(cfForm.op, cfForm.value, cfForm.color)}>규칙 추가</button>
          {cfRules.length > 0 && (
            <button className="sheet-find-close" onClick={clearCf}>전체 해제 ({cfRules.length})</button>
          )}
        </div>
      )}

      {findOpen && (
        <div className="sheet-find">
          <input
            placeholder="찾기"
            value={findText}
            onChange={(e) => setFindText(e.target.value)}
            autoFocus
          />
          <input
            placeholder="바꾸기"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
          />
          <button onClick={doReplaceAll}>모두 바꾸기</button>
          <button className="sheet-find-close" onClick={() => setFindOpen(false)}>
            ✕
          </button>
        </div>
      )}

      <div className="sheet-scroll" tabIndex={0} onKeyDown={onGridKey}>
        <table className={`sheet-grid${freeze ? ' freeze' : ''}`}>
          <colgroup>
            <col style={{ width: 44 }} />
            {Array.from({ length: COLS }, (_, c) => (
              <col key={c} style={{ width: colW(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sheet-corner" />
              {Array.from({ length: COLS }, (_, c) => (
                <th key={c} className={c >= c1 && c <= c2 ? 'sel' : ''} style={{ width: colW(c), minWidth: colW(c) }}>
                  {colLetter(c)}
                  <span className="sheet-grip-c" onMouseDown={(e) => startColResize(c, e)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: ROWS }, (_, r) => (
              <tr
                key={r}
                style={rowHidden(r, valueGrid) ? { display: 'none' } : { height: rowH(r) }}
              >
                <th className={`sheet-rownum${r >= r1 && r <= r2 ? ' sel' : ''}`}>
                  {r + 1}
                  <span className="sheet-grip-r" onMouseDown={(e) => startRowResize(r, e)} />
                </th>
                {Array.from({ length: COLS }, (_, c) => {
                  const cov = mergeCovering(r, c);
                  // 병합 영역의 좌상단이 아니면 렌더 안 함
                  if (cov && !(cov.r1 === r && cov.c1 === c)) return null;
                  const isEditing = !!editing && editing.r === r && editing.c === c;
                  const sty = styleOf(r, c);
                  return (
                    <SheetCell
                      key={c}
                      r={r}
                      c={c}
                      cfBg={cfRules.length ? cfBgFor(r, c, valueGrid[r]?.[c] ?? '') : undefined}
                      value={formatDisplay(valueGrid[r]?.[c] ?? '', sty)}
                      style={sty}
                      colSpan={cov ? cov.c2 - cov.c1 + 1 : undefined}
                      rowSpan={cov ? cov.r2 - cov.r1 + 1 : undefined}
                      active={sel.r === r && sel.c === c}
                      inRange={multi && r >= r1 && r <= r2 && c >= c1 && c <= c2}
                      inFill={
                        !!fillPrev &&
                        r >= fillPrev.r1 &&
                        r <= fillPrev.r2 &&
                        c >= fillPrev.c1 &&
                        c <= fillPrev.c2
                      }
                      fillHandle={r === r2 && c === c2 && !fillPrev}
                      isFormula={raw(r, c)[0] === '='}
                      editing={isEditing}
                      editValue={isEditing ? editing!.value : ''}
                      editRef={editRef}
                      onDown={cbDown}
                      onEnter={cbEnter}
                      onDbl={cbDbl}
                      onEditChange={cbEditChange}
                      onEditKey={cbEditKey}
                      onEditBlur={cbEditBlur}
                      onFillStart={cbFillStart}
                    />
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 하단 시트 탭 (엑셀식) */}
      <div className="sheet-tabbar">
        {sheets.map((s) => (
          <div
            key={s.id}
            className={`sheet-tab${s.id === activeSheetId ? ' active' : ''}`}
            onClick={() => {
              setActiveSheetId(s.id);
              selectCell(0, 0);
            }}
            onDoubleClick={() => setRenamingSheet({ id: s.id, name: s.name })}
            title="더블클릭하면 이름 변경"
          >
            {renamingSheet?.id === s.id ? (
              <input
                className="sheet-tab-input"
                autoFocus
                value={renamingSheet.name}
                onChange={(e) => setRenamingSheet({ id: s.id, name: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitSheetRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitSheetRename();
                  else if (e.key === 'Escape') setRenamingSheet(null);
                }}
              />
            ) : (
              <span className="sheet-tab-name">{s.name}</span>
            )}
            {sheets.length > 1 && (
              <button className="sheet-tab-close" onClick={(e) => deleteSheet(s.id, e)} title="삭제">
                ×
              </button>
            )}
          </div>
        ))}
        <button className="sheet-newtab" title="새 시트" onClick={newSheet}>
          +
        </button>
      </div>

      {chart && (() => {
        const { labels, series } = chartData();
        const empty = series.length === 0 || series.every((s) => s.data.every((v) => v === 0));
        return (
          <div className="sheet-chart-overlay" onClick={() => setChart(null)}>
            <div className="sheet-chart" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-chart-head">
                <div className="sheet-chart-types">
                  {(['bar', 'line', 'pie'] as const).map((t) => (
                    <button
                      key={t}
                      className={chart.type === t ? 'on' : ''}
                      onClick={() => setChart({ type: t })}
                    >
                      {t === 'bar' ? '막대' : t === 'line' ? '선' : '원'}
                    </button>
                  ))}
                </div>
                <span className="sheet-chart-range">
                  {cellKey(Math.min(anchor.r, sel.r), Math.min(anchor.c, sel.c))}:
                  {cellKey(Math.max(anchor.r, sel.r), Math.max(anchor.c, sel.c))}
                </span>
                <button className="sheet-chart-close" onClick={() => setChart(null)}>✕</button>
              </div>
              <div className="sheet-chart-body">
                {empty ? (
                  <div className="sheet-chart-empty">숫자가 있는 범위를 선택한 뒤 차트를 열어보세요</div>
                ) : (
                  renderChart(chart.type, labels, series)
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
