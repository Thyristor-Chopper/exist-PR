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

export default function RecapPanel({ code, isHost = false }: { code: string; isHost?: boolean }) {
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

  return (
    <section className="hub-section hub-recap-card">
      <div className="hub-section-title">
        <SparklesIcon size={15} /> AI 회의 정리
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
          통화가 끝나면 AI가 채팅에서 결정과 할 일을 정리해 여기에 둬요 — 참석하지 못한
          팀원에게도 자동으로 전달됩니다.
        </div>
      ) : (
        <div className="hub-recap-list">
          {shown.map((r) => (
            <div key={r.id} className="hub-recap">
              <div className="hub-recap-head">
                <span className="hub-recap-summary">{r.summary}</span>
                <span className="hub-recap-time">{relTime(r.ts)}</span>
              </div>

              {r.decisions.length > 0 && (
                <ul className="hub-recap-decisions">
                  {r.decisions.map((d, i) => (
                    <li key={i}>
                      <CheckMarkIcon size={13} /> {d}
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

              {r.nextMeeting && (
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

              <div className="hub-recap-foot">
                참석 {r.attendees.length ? r.attendees.map((a) => dn(a)).join(', ') : '없음'}
                <span className={`hub-recap-src${r.source === 'ai' ? ' ai' : ''}`}>
                  {r.source === 'ai' ? 'AI 분석' : '규칙 정리'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
