import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useDisplayName } from '../names';
import { CheckMarkIcon, SparklesIcon, ListIcon } from './Icons';

/*
 * 회의 기록 아카이브 — 기록 탭의 [회의] 세그먼트.
 * 새 데이터가 아니라 기존 recap의 시간순 아카이브 뷰: "어떤 회의에서 무엇이 나왔나"를 훑는 곳.
 * (최신 회의의 실행 흐름은 대시보드 ①열이, 아카이브 탐색은 여기가 맡는 분업)
 */

interface RecapAction {
  assignee: string | null;
  title: string;
}

interface Recap {
  id: number;
  summary: string;
  decisions: string[];
  whys?: string[];
  alts?: string[][];
  actions: RecapAction[];
  attendees: string[];
  source: string;
  ts: number;
}

function dateLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}
function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const SRC_LABEL: Record<string, string> = {
  ai: 'AI 정리',
  rule: '규칙 정리',
  manual: '직접 기록',
  auto: 'AI 자동 기록',
};

export default function MeetingArchive({
  code,
  focusRecapId,
  onFocusHandled,
}: {
  code: string;
  /** 원장·일정에서 "정리 보기"로 점프해 온 대상 — 펼치고 스크롤 + 하이라이트 */
  focusRecapId?: number | null;
  onFocusHandled?: () => void;
}) {
  const dn = useDisplayName();
  const [recaps, setRecaps] = useState<Recap[] | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [flashId, setFlashId] = useState<number | null>(null);

  const load = useCallback(() => {
    void api<Recap[]>(`/api/meetings/${code}/recaps`)
      .then(setRecaps)
      .catch(() => setRecaps([]));
  }, [code]);
  useEffect(load, [load]);

  // 점프 착지 — 대상 카드 펼치고 스크롤 + 2초 하이라이트
  useEffect(() => {
    if (focusRecapId == null || recaps === null) return;
    setOpen((prev) => new Set(prev).add(focusRecapId));
    setFlashId(focusRecapId);
    const t = setTimeout(() => {
      document
        .querySelector(`[data-archive-id="${focusRecapId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
    const t2 = setTimeout(() => {
      setFlashId(null);
      onFocusHandled?.();
    }, 2600);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRecapId, recaps === null]);

  const q = query.trim();
  const shown = (recaps ?? []).filter(
    (r) =>
      !q ||
      r.summary.includes(q) ||
      r.decisions.some((d) => d.includes(q)) ||
      r.actions.some((a) => a.title.includes(q)),
  );

  // 날짜별 그룹 (최신 먼저 — 서버가 최신순)
  const groups: { label: string; items: Recap[] }[] = [];
  for (const r of shown) {
    const label = dateLabel(r.ts);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(r);
    else groups.push({ label, items: [r] });
  }

  return (
    <div className="ma-wrap">
      <div className="ma-head">
        <p className="ma-sub">
          통화·채팅이 끝날 때마다 AI가 남긴 회의 기록이 시간순으로 쌓여요 — 아무도 회의록을 쓰지
          않았습니다
        </p>
        <input
          className="ledger-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="회의 기록 검색"
        />
      </div>

      {recaps === null ? (
        <div className="ledger-empty">
          <p>불러오는 중…</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="ledger-empty">
          <SparklesIcon size={36} />
          <p>{q ? `"${q}" 결과가 없어요` : '아직 회의 기록이 없어요'}</p>
          {!q && <span>통화가 끝나거나 대시보드에서 '지금 정리하기'를 누르면 여기에 쌓여요.</span>}
        </div>
      ) : (
        <div className="ma-list">
          {groups.map((g) => (
            <div key={g.label} className="ma-group">
              <div className="ledger-date">{g.label}</div>
              {g.items.map((r) => {
                const isOpen = open.has(r.id);
                return (
                  <div
                    key={r.id}
                    className={`ma-card${flashId === r.id ? ' recap-flash' : ''}`}
                    data-archive-id={r.id}
                  >
                    <button
                      className="ma-card-head"
                      onClick={() =>
                        setOpen((prev) => {
                          const next = new Set(prev);
                          if (next.has(r.id)) next.delete(r.id);
                          else next.add(r.id);
                          return next;
                        })
                      }
                    >
                      <span className="ma-time">{timeLabel(r.ts)}</span>
                      <span className="ma-summary">{r.summary}</span>
                      <span className="ma-counts">
                        {r.decisions.length > 0 && (
                          <b>
                            <CheckMarkIcon size={11} /> {r.decisions.length}
                          </b>
                        )}
                        {r.actions.length > 0 && (
                          <b>
                            <ListIcon size={11} /> {r.actions.length}
                          </b>
                        )}
                        <i>{SRC_LABEL[r.source] ?? r.source}</i>
                      </span>
                    </button>
                    {isOpen && (
                      <div className="ma-body">
                        {r.decisions.length > 0 && (
                          <ul className="hub-recap-decisions">
                            {r.decisions.map((d, i) => (
                              <li key={i}>
                                <CheckMarkIcon size={13} /> {d}
                                {r.whys?.[i] && <div className="hub-recap-why">배경 · {r.whys[i]}</div>}
                                {(r.alts?.[i]?.length ?? 0) > 0 &&
                                  r.alts![i].map((a, j) => (
                                    <div key={j} className="hub-recap-why recap-alt">
                                      검토된 대안 · {a}
                                    </div>
                                  ))}
                              </li>
                            ))}
                          </ul>
                        )}
                        {r.actions.length > 0 && (
                          <div className="ma-actions">
                            {r.actions.map((a, i) => (
                              <div key={i} className="hub-recap-action">
                                <span className={`hub-recap-assignee${a.assignee ? '' : ' none'}`}>
                                  {a.assignee ? dn(a.assignee) : '담당 미정'}
                                </span>
                                {a.title}
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="ma-foot">
                          참석 {r.attendees.length ? r.attendees.map((a) => dn(a)).join(', ') : '기록 없음'}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
