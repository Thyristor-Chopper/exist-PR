/** 할 일 마감(YYYY-MM-DD) → 표시 뱃지. 허브·nowbar 공용 */
export interface DueBadge {
  label: string;
  /** over=지남(빨강) / today=오늘 / soon=내일 / later=그 외 */
  cls: 'over' | 'today' | 'soon' | 'later';
}

export function dueBadge(due: string): DueBadge | null {
  const d = new Date(due.slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((d.getTime() - t0.getTime()) / 86_400_000);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  if (diff < 0) return { label: `${md} 지남`, cls: 'over' };
  if (diff === 0) return { label: '오늘', cls: 'today' };
  if (diff === 1) return { label: '내일', cls: 'soon' };
  return { label: md, cls: 'later' };
}
