import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { getSocket } from '../lib/socket';
import { useDisplayName } from '../names';
import { SparklesIcon, CheckMarkIcon } from './Icons';

/*
 * P1 — 통화가 끝나면 AI가 채팅에서 뽑은 결정·할 일(recap)을 보여주는 패널.
 * 회의 허브 대시보드에 표시. recap 알림이 오면 실시간으로 새로고침된다.
 */

interface RecapAction {
  assignee: string | null;
  title: string;
}

interface NextMeeting {
  title: string;
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM
  registered?: boolean;
}

interface Recap {
  id: number;
  summary: string;
  decisions: string[];
  /** 결정별 배경 한 줄 (decisions와 인덱스 정렬, 없으면 '') */
  whys?: string[];
  /** 결정별 검토된 대안 ("대안 — 기각 사유", 없으면 빈 배열) */
  alts?: string[][];
  actions: RecapAction[];
  attendees: string[];
  nextMeeting: NextMeeting | null;
  source: string;
  ts: number;
}

/** "7/23 (수) 15:00" — 다음 회의 제안 표시용 */
function fmtNext(nm: NextMeeting): string {
  const dt = new Date(`${nm.date}T${nm.time ?? '00:00'}:00`);
  const wd = '일월화수목금토'[dt.getDay()];
  return `${dt.getMonth() + 1}/${dt.getDate()} (${wd})${nm.time ? ` ${nm.time}` : ''}`;
}

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export default function RecapPanel({
  code,
  isHost = false,
  part = 'all',
}: {
  code: string;
  isHost?: boolean;
  /** 3단 파이프라인 분할 렌더 — past=①지난 회의(정리·결정·할일), next=③다음 회의(제안·겹치는 시간)만 */
  part?: 'all' | 'past' | 'next';
}) {
  const dn = useDisplayName();
  const [recaps, setRecaps] = useState<Recap[]>([]);
  const [expanded, setExpanded] = useState(false); // 기본은 최신 1건만
  const [registering, setRegistering] = useState<number | null>(null); // 등록 중인 recap id
  const [running, setRunning] = useState(false); // 수동 정리 실행 중

  /** 통화 없이도 지금까지의 채팅을 즉시 정리 (호스트 전용) */
  async function runNow() {
    if (running) return;
    setRunning(true);
    try {
      const r = await api<{ id: number | null }>(`/api/meetings/${code}/recaps/run`, {
        method: 'POST',
      });
      if (r.id == null) {
        window.dispatchEvent(
          new CustomEvent('app:error', { detail: '정리할 새 기록이 부족해요 (채팅 2개 이상)' }),
        );
      } else {
        load();
      }
    } catch {
      /* 전역 토스트 */
    } finally {
      setRunning(false);
    }
  }

  const load = useCallback(() => {
    void api<Recap[]>(`/api/meetings/${code}/recaps`)
      .then(setRecaps)
      .catch(() => {});
  }, [code]);

  useEffect(load, [load]);

  // 이 회의의 recap 알림이 오면 즉시 갱신 (통화 종료 → 카드가 눈앞에서 생김)
  useEffect(() => {
    const socket = getSocket();
    function onNotify(n: { kind?: string; meeting?: { code?: string | null } }) {
      if (n.kind === 'recap' && n.meeting?.code === code) load();
    }
    socket.on('agent:notify', onNotify);
    return () => {
      socket.off('agent:notify', onNotify);
    };
  }, [code, load]);

  // "정리 보기" 점프 착지는 기록 탭 > 회의 아카이브가 맡는다 (8/2 이관) — 여기선 flash 미사용
  const flashId: number | null = null;

  // AI 겹침 시간 제안 (P1 ⑥ 업그레이드) — 명시적 합의가 없을 때 참가자 일정 기반 후보
  const [slots, setSlots] = useState<{ date: string; time: string; free: number; busy: string[] }[] | null>(null);
  const [slotTotal, setSlotTotal] = useState(0);
  const [slotState, setSlotState] = useState<'idle' | 'loading' | 'done'>('idle');

  async function findSlots() {
    if (slotState === 'loading') return;
    setSlotState('loading');
    try {
      const r = await api<{ total: number; slots: { date: string; time: string; free: number; busy: string[] }[] }>(
        `/api/meetings/${code}/schedule/suggest`,
      );
      setSlots(r.slots);
      setSlotTotal(r.total);
    } catch {
      setSlots([]);
    } finally {
      setSlotState('idle');
    }
  }

  /** 후보 슬롯 → 사람이 확정 — 일정 등록 (AI는 제안까지) */
  async function registerSlot(s: { date: string; time: string }) {
    try {
      await api(`/api/meetings/${code}/events`, {
        method: 'POST',
        body: { title: '다음 회의', date: s.date, time: s.time, is_call: true },
      });
      setSlotState('done');
    } catch {
      /* 전역 토스트 */
    }
  }

  /** AI 제안 → 사람이 확정 — 기존 일정 API로 등록하고 제안에 등록됨 표시 */
  async function registerNext(r: Recap) {
    const nm = r.nextMeeting;
    if (!nm || nm.registered || registering !== null) return;
    setRegistering(r.id);
    try {
      await api(`/api/meetings/${code}/events`, {
        method: 'POST',
        body: { title: nm.title, date: nm.date, time: nm.time, is_call: true },
      });
      await api(`/api/meetings/${code}/recaps/${r.id}/next-registered`, { method: 'POST' });
      load();
    } finally {
      setRegistering(null);
    }
  }

  const shown = expanded ? recaps : recaps.slice(0, 1);

  // part='next' — 최신 정리의 다음 회의 제안(합의·AI 겹침 시간)만 (파이프라인 ③번 카드용)
  if (part === 'next') {
    const r = recaps[0];
    if (!r) {
      return <div className="hub-section-empty">아직 다음 회의 제안이 없어요 — 회의 정리가 쌓이면 여기에 떠요</div>;
    }
    return (
      <div className="pipe-next-meeting">
        {r.nextMeeting ? (
          <div className="hub-recap-next">
            <span className="hub-recap-next-label">다음 회의 제안</span>
            <span className="hub-recap-next-when">
              {fmtNext(r.nextMeeting)} — {r.nextMeeting.title}
            </span>
            {r.nextMeeting.registered ? (
              <span className="hub-recap-next-done">
                <CheckMarkIcon size={12} /> 등록됨
              </span>
            ) : (
              <button
                className="hub-recap-next-btn"
                disabled={registering === r.id}
                onClick={() => void registerNext(r)}
              >
                {registering === r.id ? '등록 중…' : '일정 등록'}
              </button>
            )}
          </div>
        ) : (
          <div className="hub-recap-next suggest">
            <span className="hub-recap-next-label">다음 회의</span>
            {slotState === 'done' ? (
              <span className="hub-recap-next-done">
                <CheckMarkIcon size={12} /> 일정 등록됨
              </span>
            ) : slots === null ? (
              <button
                className="hub-recap-next-btn"
                disabled={slotState === 'loading'}
                onClick={() => void findSlots()}
                title="참가자 전원의 일정을 보고 모두 비는 시간을 찾아요"
              >
                {slotState === 'loading' ? (
                  '찾는 중…'
                ) : (
                  <>
                    <SparklesIcon size={13} /> 겹치는 시간 찾기
                  </>
                )}
              </button>
            ) : slots.length === 0 ? (
              <span className="hub-recap-slot-empty">다음 7일 평일에 빈 시간을 못 찾았어요</span>
            ) : (
              <span className="hub-recap-slots">
                {slots.map((s) => (
                  <button
                    key={`${s.date}${s.time}`}
                    className="hub-recap-slot"
                    onClick={() => void registerSlot(s)}
                    title={
                      s.free === slotTotal
                        ? '전원 가능 — 클릭하면 통화 일정으로 등록'
                        : `${s.busy.map((b) => dn(b)).join(', ')} 제외 가능`
                    }
                  >
                    {fmtNext({ title: '', date: s.date, time: s.time })}
                    <b>{s.free === slotTotal ? '전원 가능' : `${s.free}/${slotTotal}명`}</b>
                  </button>
                ))}
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="hub-section hub-recap-card">
      <div className="hub-section-title">
        <SparklesIcon size={15} /> <span className="hub-recap-title-txt">AI 회의 정리</span>
        {isHost && (
          <button
            className="hub-recap-run"
            disabled={running}
            onClick={() => void runNow()}
            title="통화 없이도 지금까지의 채팅을 정리해요"
          >
            {running ? '정리 중…' : '지금 정리하기'}
          </button>
        )}
        {recaps.length > 1 && (
          <button className="hub-recap-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? '접기' : `지난 정리 ${recaps.length - 1}건 더`}
          </button>
        )}
      </div>

      {recaps.length === 0 ? (
        <div className="hub-section-empty">
          아직 지난 회의 기록이 없어요. <b>통화하거나 채팅을 나눈 뒤 '지금 정리하기'</b>를 누르면
          AI가 결정·할 일을 정리해 여기에 둬요 — 참석하지 못한 팀원에게도 자동으로 전달됩니다.
        </div>
      ) : (
        <div className="hub-recap-list">
          {shown.map((r, idx) => (
            <div
              key={r.id}
              className={`hub-recap${flashId === r.id ? ' recap-flash' : ''}`}
              data-recap-id={r.id}
            >
              <div className="hub-recap-head">
                <span className="hub-recap-summary">{r.summary}</span>
                <span className="hub-recap-time">{relTime(r.ts)}</span>
              </div>

              {r.decisions.length > 0 && (
                <ul className="hub-recap-decisions">
                  {r.decisions.map((d, i) => (
                    <li key={i}>
                      <CheckMarkIcon size={13} /> {d}
                      {/* 결정 배경 — "왜 그렇게 됐는지"가 같이 남는다 (실무자 인터뷰 반영) */}
                      {r.whys?.[i] && <div className="hub-recap-why">배경 · {r.whys[i]}</div>}
                      {/* 검토된 대안 — 기각된 안까지 남아야 같은 검토를 반복하지 않는다 */}
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
                <div className="hub-recap-actions">
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

              {part !== 'past' && r.nextMeeting && (
                <div className="hub-recap-next">
                  <span className="hub-recap-next-label">다음 회의 제안</span>
                  <span className="hub-recap-next-when">
                    {fmtNext(r.nextMeeting)} — {r.nextMeeting.title}
                  </span>
                  {r.nextMeeting.registered ? (
                    <span className="hub-recap-next-done">
                      <CheckMarkIcon size={12} /> 등록됨
                    </span>
                  ) : (
                    <button
                      className="hub-recap-next-btn"
                      disabled={registering === r.id}
                      onClick={() => void registerNext(r)}
                    >
                      {registering === r.id ? '등록 중…' : '일정 등록'}
                    </button>
                  )}
                </div>
              )}

              {/* 회의 중 합의가 없었으면 — AI가 참가자 일정을 보고 겹치는 시간 후보 제안 (최신 정리에만) */}
              {part !== 'past' && !r.nextMeeting && idx === 0 && (
                <div className="hub-recap-next suggest">
                  <span className="hub-recap-next-label">다음 회의</span>
                  {slotState === 'done' ? (
                    <span className="hub-recap-next-done">
                      <CheckMarkIcon size={12} /> 일정 등록됨
                    </span>
                  ) : slots === null ? (
                    <button
                      className="hub-recap-next-btn"
                      disabled={slotState === 'loading'}
                      onClick={() => void findSlots()}
                      title="참가자 전원의 일정을 보고 모두 비는 시간을 찾아요"
                    >
                      {slotState === 'loading' ? (
                        '찾는 중…'
                      ) : (
                        <>
                          <SparklesIcon size={13} /> 겹치는 시간 찾기
                        </>
                      )}
                    </button>
                  ) : slots.length === 0 ? (
                    <span className="hub-recap-slot-empty">다음 7일 평일에 빈 시간을 못 찾았어요</span>
                  ) : (
                    <span className="hub-recap-slots">
                      {slots.map((s) => (
                        <button
                          key={`${s.date}${s.time}`}
                          className="hub-recap-slot"
                          onClick={() => void registerSlot(s)}
                          title={
                            s.free === slotTotal
                              ? '전원 가능 — 클릭하면 통화 일정으로 등록'
                              : `${s.busy.map((b) => dn(b)).join(', ')} 제외 가능`
                          }
                        >
                          {fmtNext({ title: '', date: s.date, time: s.time })}
                          <b>{s.free === slotTotal ? '전원 가능' : `${s.free}/${slotTotal}명`}</b>
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              )}

              <div className="hub-recap-foot">
                참석 {r.attendees.length ? r.attendees.map((a) => dn(a)).join(', ') : '없음'}
                <span className={`hub-recap-src${r.source === 'ai' || r.source === 'auto' ? ' ai' : ''}`}>
                  {r.source === 'ai'
                    ? 'AI 분석'
                    : r.source === 'auto'
                      ? 'AI 자동 기록'
                      : r.source === 'manual'
                        ? '직접 기록'
                        : '규칙 정리'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
