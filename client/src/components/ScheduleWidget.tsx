import { useState, type CSSProperties } from 'react';
import { type Meeting } from './NowBar';
import Marquee from './Marquee';

/*
 * 홈 대시보드 '전체 일정' 위젯 — 작은 월간 달력 + 선택한 날의 하루 세로 타임라인.
 * 달력에서 날짜를 고르면 그 날의 일정이 시간순으로 세로 일직선(타임라인)에 표시된다.
 */

const WD = ['일', '월', '화', '수', '목', '금', '토'];
const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** 그룹(회의)별 고유색 — 황금각 회전으로 id마다 안정적인 색 (애플 캘린더의 캘린더 색 느낌) */
const groupColor = (id: number) => `hsl(${(id * 137.508) % 360} 62% 45%)`;

export default function ScheduleWidget({
  schedule,
  onOpen,
}: {
  schedule: Meeting[];
  onOpen: (code: string, title: string) => void;
}) {
  const today = new Date();
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [sel, setSel] = useState(new Date(today.getFullYear(), today.getMonth(), today.getDate()));

  // 현재 보고 있는 달에서 일정이 있는 날짜 → 그 날의 그룹 id들 (한 그룹뿐이면 그룹색 점)
  const evDays = new Map<number, Set<number>>();
  for (const s of schedule) {
    if (!s.starts_at) continue;
    const d = new Date(s.starts_at);
    if (d.getFullYear() !== view.y || d.getMonth() !== view.m) continue;
    if (!evDays.has(d.getDate())) evDays.set(d.getDate(), new Set());
    evDays.get(d.getDate())!.add(s.id);
  }

  // 달력 셀 구성
  const startDow = new Date(view.y, view.m, 1).getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const prevMonth = () => setView((v) => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 }));
  const nextMonth = () => setView((v) => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 }));

  const isToday = (d: number) =>
    view.y === today.getFullYear() && view.m === today.getMonth() && d === today.getDate();
  const isSel = (d: number) =>
    view.y === sel.getFullYear() && view.m === sel.getMonth() && d === sel.getDate();

  // 선택한 날짜의 일정 (시간순)
  const dayEvents = schedule
    .filter((s) => s.starts_at && ymd(new Date(s.starts_at)) === ymd(sel))
    .sort((a, b) => new Date(a.starts_at!).getTime() - new Date(b.starts_at!).getTime());

  const selLabel = `${sel.getMonth() + 1}월 ${sel.getDate()}일 (${WD[sel.getDay()]})`;

  return (
    <div className="schedw">
      {/* ── 미니 달력 ── */}
      <div style={calSide}>
        <div style={calHead}>
          <button style={navBtn} onClick={prevMonth} aria-label="이전 달">‹</button>
          <span style={calTitle}>{view.y}. {String(view.m + 1).padStart(2, '0')}</span>
          <button style={navBtn} onClick={nextMonth} aria-label="다음 달">›</button>
        </div>
        <div style={grid7}>
          {WD.map((w, i) => (
            <div key={w} style={{ ...wdCell, color: dowColor(i) }}>{w}</div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <span key={i} />;
            const selected = isSel(d);
            return (
              <button
                key={i}
                onClick={() => setSel(new Date(view.y, view.m, d))}
                style={{
                  ...dayCell,
                  background: selected ? 'var(--green)' : 'transparent',
                  color: selected
                    ? '#fff'
                    : isToday(d)
                      ? 'var(--green)'
                      : dowColor(i % 7),
                  fontWeight: selected || isToday(d) ? 700 : 400,
                }}
              >
                {d}
                {evDays.has(d) && (
                  <span
                    style={{
                      ...evDot,
                      background: selected
                        ? '#fff'
                        : evDays.get(d)!.size === 1
                          ? groupColor([...evDays.get(d)!][0])
                          : 'var(--green)',
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── 하루 세로 타임라인 ── */}
      <div style={tlSide}>
        <div style={tlLabel}>{selLabel}</div>
        {dayEvents.length === 0 ? (
          <div style={tlEmpty}>이 날 일정이 없어요</div>
        ) : (
          <div style={tlList}>
            <div style={tlLine} />
            {dayEvents.map((s) => {
              const t = new Date(s.starts_at!);
              return (
                <button key={s.occId ?? s.code} style={tlRow} onClick={() => onOpen(s.code, s.title)}>
                  <span style={tlTime}>
                    {s.allDay
                      ? '종일'
                      : t.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span style={tlDot}>
                    <span style={{ ...tlDotInner, background: groupColor(s.id) }} />
                  </span>
                  <Marquee className="schedw-tl-title">{s.title}</Marquee>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function dowColor(i: number) {
  return i === 0 ? '#e5484d' : i === 6 ? '#3b7cff' : 'var(--text)';
}

// 그리드 컨테이너(.schedw)는 index.css — 인라인이면 미디어쿼리가 못 건드림
const calSide: CSSProperties = {};
const calHead: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 8,
};
const calTitle: CSSProperties = { fontSize: 13.5, fontWeight: 700, color: 'var(--text)' };
const navBtn: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 7,
  border: 'none',
  background: 'var(--surface-2)',
  color: 'var(--text-sub)',
  fontSize: 16,
  lineHeight: 1,
  cursor: 'pointer',
};
const grid7: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 };
const wdCell: CSSProperties = {
  textAlign: 'center',
  fontSize: 11,
  fontWeight: 600,
  padding: '2px 0 4px',
};
const dayCell: CSSProperties = {
  position: 'relative',
  aspectRatio: '1',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  fontSize: 12.5,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const evDot: CSSProperties = {
  position: 'absolute',
  bottom: 3,
  left: '50%',
  transform: 'translateX(-50%)',
  width: 4,
  height: 4,
  borderRadius: '50%',
};

const tlSide: CSSProperties = { minWidth: 0 };
const tlLabel: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--text)',
  marginBottom: 10,
};
const tlEmpty: CSSProperties = { fontSize: 13, color: 'var(--text-sub)', padding: '8px 2px' };
const tlList: CSSProperties = {
  position: 'relative',
  maxHeight: 200,
  overflowY: 'auto',
};
// 원 중심 x = 행 패딩 2 + 시간칸 46(border-box, 패딩 포함) + 원 컨테이너 20/2 = 58 — 선(폭 2)은 57 시작
const tlLine: CSSProperties = {
  position: 'absolute',
  left: 57,
  top: 6,
  bottom: 6,
  width: 2,
  background: 'var(--border)',
};
const tlRow: CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  gap: 0,
  width: '100%',
  padding: '7px 2px',
  background: 'none',
  border: 'none',
  textAlign: 'left',
  cursor: 'pointer',
};
const tlTime: CSSProperties = {
  width: 46,
  flexShrink: 0,
  textAlign: 'right',
  paddingRight: 10,
  fontSize: 12,
  color: 'var(--text-sub)',
};
const tlDot: CSSProperties = {
  width: 20,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const tlDotInner: CSSProperties = {
  position: 'relative',
  zIndex: 1,
  width: 9,
  height: 9,
  borderRadius: '50%',
  background: 'var(--green)',
  border: '2px solid var(--surface)',
  boxSizing: 'content-box',
};
// 제목은 Marquee(.schedw-tl-title) — 잘림 대신 흐름 애니메이션
