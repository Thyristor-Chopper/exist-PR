import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import { getSocket } from '../lib/socket';
import { useDisplayName } from '../names';
import { CheckMarkIcon, SparklesIcon, RefreshIcon } from './Icons';
import PillSeg from './PillSeg';
import HandoverPanel from './HandoverPanel';
import MeetingArchive from './MeetingArchive';
import SignPad from './SignPad';

/*
 * 결정 원장 — 이 그룹의 모든 통화 결정이 시간순으로 쌓이는 타임라인.
 * "결정이 사람이 아니라 조직에 남는다." 새 recap이 생기면 실시간 갱신.
 * 수신 확인(회람 사인): 각 결정에 "확인"을 남기면 누가 확인했는지 쌓인다.
 */

interface LedgerEntry {
  recapId: number;
  idx: number;
  decision: string;
  /** 결정 배경 한 줄 — 없으면 '' (실무자 인터뷰: 배경 유실이 진짜 페인) */
  why?: string;
  /** 검토됐지만 채택되지 않은 대안 ("대안 — 기각 사유") — 같은 검토의 반복 방지 */
  alts?: string[];
  /** 🔴 작업 전 확인 필수 — 확인 시 손 서명 요구 */
  critical?: boolean;
  attendees: string[];
  ts: number;
  acks: { username: string; ts: number; note?: string | null; signature?: string | null }[];
  /** 이 recap에서 파생된 할 일 — 결정이 실행됐는지 추적 */
  todos?: { title: string; done: number }[];
}

function dateLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

interface HistoryTopic {
  title: string;
  entries: { recapId: number; idx: number; decision: string; why: string; ts: number }[];
}

interface DecisionHistory {
  topics: HistoryTopic[];
  source: 'ai' | 'rule';
  generatedAt: number;
}

export default function DecisionLedger({ code }: { code: string }) {
  const user = useAuthStore((s) => s.user);
  const dn = useDisplayName();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [query, setQuery] = useState('');
  // 변경 이력 뷰 — 같은 주제 결정의 변천 (AI 그룹핑, 현직자 요구 "변경사항 이력 관리")
  // handover = 교대 인수인계, meetings = 회의 기록 아카이브 — "조직의 기록은 한 탭" (8/2)
  const [view, setView] = useState<'list' | 'history' | 'meetings' | 'handover'>('list');
  // 원장·일정의 "정리 보기" 점프 착지 — 회의 아카이브의 해당 카드
  const [focusRecapId, setFocusRecapId] = useState<number | null>(null);

  // 전역 검색·일정 다리의 인수인계 점프 — 기록 탭 진입 후 세그먼트를 인수인계로
  useEffect(() => {
    const open = () => setView('handover');
    window.addEventListener('exist:open-handover', open);
    // "정리 보기" — 회의 아카이브 세그먼트로 전환 + 대상 카드 포커스
    const focus = (e: Event) => {
      const d = (e as CustomEvent).detail as { code?: string; recapId?: number } | undefined;
      if (!d || d.code !== code || !d.recapId) return;
      setView('meetings');
      setFocusRecapId(d.recapId);
    };
    window.addEventListener('exist:archive-focus', focus);
    return () => {
      window.removeEventListener('exist:open-handover', open);
      window.removeEventListener('exist:archive-focus', focus);
    };
  }, [code]);
  const [hist, setHist] = useState<DecisionHistory | null>(null);
  const [histLoading, setHistLoading] = useState(false);

  async function openHistory() {
    setView('history');
    if (hist || histLoading) return;
    setHistLoading(true);
    try {
      setHist(await api<DecisionHistory>(`/api/meetings/${code}/decisions/history`));
    } catch {
      setHist({ topics: [], source: 'rule', generatedAt: Date.now() });
    } finally {
      setHistLoading(false);
    }
  }
  // 확인 직후 뜨는 "현장 한 줄(선택)" 입력 — 현직자 제안(확인 + 현장 피드백) 반영
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  // 🔴 결정 손 서명 — 중요도에 비례한 마찰 (일반 결정은 클릭 1회 유지)
  const [signFor, setSignFor] = useState<string | null>(null);

  const load = useCallback(() => {
    void api<LedgerEntry[]>(`/api/meetings/${code}/decisions`)
      .then(setEntries)
      .catch(() => {});
  }, [code]);

  async function ack(e: LedgerEntry, signature?: string) {
    if (e.critical && !signature) {
      // 작업 전 확인 필수 결정은 손 서명으로 — 종이 회람판처럼
      setSignFor(`${e.recapId}-${e.idx}`);
      return;
    }
    setSignFor(null);
    // 낙관적 반영 후 서버 기록
    setEntries((prev) =>
      prev.map((x) =>
        x.recapId === e.recapId && x.idx === e.idx
          ? {
              ...x,
              acks: [
                ...x.acks,
                { username: user?.username ?? '', ts: Date.now(), signature: signature ?? null },
              ],
            }
          : x,
      ),
    );
    setNoteFor(`${e.recapId}-${e.idx}`);
    setNoteText('');
    await api(`/api/meetings/${code}/decisions/ack`, {
      method: 'POST',
      body: { recapId: e.recapId, idx: e.idx, ...(signature ? { signature } : {}) },
    }).catch(() => load());
  }

  /** 현장 피드백 한 줄 저장 — 같은 ack 엔드포인트 재호출 (멱등 + 노트 갱신) */
  async function saveNote(e: LedgerEntry) {
    const note = noteText.trim();
    setNoteFor(null);
    if (!note) return;
    setEntries((prev) =>
      prev.map((x) =>
        x.recapId === e.recapId && x.idx === e.idx
          ? {
              ...x,
              acks: x.acks.map((a) => (a.username === user?.username ? { ...a, note } : a)),
            }
          : x,
      ),
    );
    await api(`/api/meetings/${code}/decisions/ack`, {
      method: 'POST',
      body: { recapId: e.recapId, idx: e.idx, note },
    }).catch(() => load());
  }

  useEffect(load, [load]);

  // 통화가 끝나고 새 recap이 생기면 원장도 즉시 갱신
  useEffect(() => {
    const socket = getSocket();
    function onNotify(n: { kind?: string; meeting?: { code?: string | null } }) {
      if (n.kind === 'recap' && n.meeting?.code === code) {
        load();
        setHist(null); // 새 결정이 생겼으니 이력도 다시 묶어야 함
      }
    }
    socket.on('agent:notify', onNotify);
    // 남이 확인(서명)한 순간 현황 즉시 갱신 — 회람 진행 상황이 새로고침 없이 맞게
    function onLedgerChanged(p: { code?: string } | undefined) {
      if (p?.code === code.toUpperCase()) load();
    }
    socket.on('ledger:changed', onLedgerChanged);
    return () => {
      socket.off('agent:notify', onNotify);
      socket.off('ledger:changed', onLedgerChanged);
    };
  }, [code, load]);

  const q = query.trim();
  const shown = q ? entries.filter((e) => e.decision.includes(q)) : entries;

  // 날짜별 그룹핑 (최신 먼저 — 서버가 최신순으로 줌)
  const groups: { label: string; items: LedgerEntry[] }[] = [];
  for (const e of shown) {
    const label = dateLabel(e.ts);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(e);
    else groups.push({ label, items: [e] });
  }

  return (
    <div className="ledger">
      <div className="ledger-head">
        <div className="ledger-title">
          {view === 'handover' ? (
            <>
              <RefreshIcon size={16} /> 교대 인수인계
            </>
          ) : view === 'meetings' ? (
            <>
              <SparklesIcon size={16} /> 회의 기록
            </>
          ) : (
            <>
              <CheckMarkIcon size={16} /> 결정 원장
              <span className="ledger-count">{entries.length}</span>
            </>
          )}
        </div>
        {/* 오른쪽 컨트롤 그룹 — [검색(목록 모드만)] [원장|변경 이력|인수인계]. 토글은 항상 맨 오른쪽 고정 */}
        <div className="ledger-head-right">
          {view === 'list' && (
            <input
              className="ledger-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="결정 검색"
            />
          )}
          <PillSeg
            className="ledger-view-seg"
            ariaLabel="기록 보기"
            options={[
              { key: 'list', label: '원장' },
              { key: 'history', label: '변경 이력' },
              { key: 'meetings', label: '회의' },
              { key: 'handover', label: '인수인계' },
            ]}
            value={view}
            onChange={(k) =>
              k === 'history' ? void openHistory() : setView(k as 'list' | 'meetings' | 'handover')
            }
          />
        </div>
      </div>

      {view === 'handover' ? (
        <HandoverPanel code={code} embedded />
      ) : view === 'meetings' ? (
        <MeetingArchive
          code={code}
          focusRecapId={focusRecapId}
          onFocusHandled={() => setFocusRecapId(null)}
        />
      ) : view === 'history' ? (
        histLoading || !hist ? (
          <div className="ledger-empty">
            <SparklesIcon size={36} />
            <p>이력을 정리하는 중…</p>
          </div>
        ) : hist.topics.length === 0 ? (
          <div className="ledger-empty">
            <p>아직 이력으로 묶을 결정이 없어요</p>
          </div>
        ) : (
          <div className="ledger-hist">
            <div className="ledger-hist-src">
              {hist.source === 'ai' ? 'AI가 같은 주제끼리 묶었어요' : '시간순 이력'}
            </div>
            {hist.topics.map((t, ti) => (
              <div key={ti} className="ledger-topic">
                <div className="ledger-topic-title">{t.title}</div>
                <div className="ledger-timeline">
                  {t.entries.map((e, ei) => {
                    const latest = ei === t.entries.length - 1;
                    return (
                      <div key={`${e.recapId}-${e.idx}`} className={`ledger-tl-item${latest ? ' latest' : ''}`}>
                        <span className="ledger-tl-dot" />
                        <div className="ledger-tl-body">
                          <div className="ledger-tl-date">
                            {dateLabel(e.ts)}
                            {latest && t.entries.length > 1 && <b className="ledger-tl-now">현재</b>}
                          </div>
                          <div className="ledger-tl-text">{e.decision}</div>
                          {e.why && <div className="ledger-why">배경 · {e.why}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )
      ) : null}

      {view !== 'list' ? null : entries.length === 0 ? (
        <div className="ledger-empty">
          <SparklesIcon size={36} />
          <p>아직 기록된 결정이 없어요</p>
          <span>
            통화가 끝나면 AI가 채팅에서 결정을 뽑아 여기에 쌓아요 — 누가 언제 합류해도 팀의 결정
            역사를 볼 수 있어요. 채팅에서 <b>@AI</b>를 불러 물어볼 수도 있어요.
          </span>
        </div>
      ) : shown.length === 0 ? (
        <div className="ledger-empty">
          <p>"{q}" 검색 결과가 없어요</p>
        </div>
      ) : (
        <div className="ledger-list">
          {groups.map((g) => (
            <div key={g.label} className="ledger-group">
              <div className="ledger-date">{g.label}</div>
              {g.items.map((e, i) => {
                const acked = e.acks.some((a) => a.username === user?.username);
                return (
                  <div key={`${e.recapId}-${i}`} className="ledger-item">
                    <span className="ledger-check">
                      <CheckMarkIcon size={14} />
                    </span>
                    <div className="ledger-body">
                      <div className="ledger-decision">
                        {e.critical && (
                          <span className="ledger-critical" title="확인 시 손 서명이 필요해요">
                            🔴 작업 전 확인 필수
                          </span>
                        )}
                        {e.decision}
                      </div>
                      {e.why && <div className="ledger-why">배경 · {e.why}</div>}
                      {(e.alts?.length ?? 0) > 0 && (
                        <div className="ledger-alts">
                          {e.alts!.map((a, i) => (
                            <div key={i} className="ledger-alt">
                              검토된 대안 · {a}
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="ledger-meta">
                        참석 {e.attendees.length ? e.attendees.map((a) => dn(a)).join(', ') : '기록 없음'}
                        {e.acks.length > 0 && (
                          <span
                            className="ledger-ack-list"
                            title={e.acks.map((a) => dn(a.username)).join(', ')}
                          >
                            {' '}
                            · 확인 {e.acks.length}명 ({e.acks.map((a) => dn(a.username)).join(', ')})
                          </span>
                        )}
                        {(e.todos ?? []).length > 0 && (
                          <span
                            className={`ledger-exec${e.todos!.every((t) => t.done) ? ' all-done' : ''}`}
                            title={e.todos!.map((t) => `${t.done ? '✓' : '·'} ${t.title}`).join('\n')}
                          >
                            {' '}
                            · 실행 {e.todos!.filter((t) => t.done).length}/{e.todos!.length}
                          </span>
                        )}
                        {/* 출처 회의록 점프 — "이 결정 전후로 무슨 얘기가 있었는지"로 가는 길 */}
                        <button
                          className="ledger-src-link"
                          onClick={() =>
                            window.dispatchEvent(
                              new CustomEvent('exist:goto-recap', {
                                detail: { code, recapId: e.recapId },
                              }),
                            )
                          }
                        >
                          정리 보기
                        </button>
                      </div>
                      {/* 손 서명 스트립 — 🔴 결정의 회람판 */}
                      {e.acks.some((a) => a.signature) && (
                        <div className="ho-signs ledger-signs">
                          {e.acks
                            .filter((a) => a.signature)
                            .map((a) => (
                              <span key={a.username} className="ho-sign-chip" title={dn(a.username)}>
                                <img src={a.signature!} alt={`${dn(a.username)} 서명`} />
                                <i>{dn(a.username)}</i>
                              </span>
                            ))}
                        </div>
                      )}
                      {/* 서명 패드 — 작업 전 확인 필수 결정의 확인 */}
                      {signFor === `${e.recapId}-${e.idx}` && (
                        <SignPad
                          onConfirm={(dataUrl) => void ack(e, dataUrl)}
                          onCancel={() => setSignFor(null)}
                        />
                      )}
                      {/* 현장 피드백 — 확인에 딸린 한 줄 ("반영 완료"/"라인에선 어려움" 등) */}
                      {e.acks.some((a) => a.note) && (
                        <div className="ledger-feedback">
                          {e.acks
                            .filter((a) => a.note)
                            .map((a) => (
                              <div key={a.username} className="ledger-feedback-row">
                                <b>{dn(a.username)}</b> {a.note}
                              </div>
                            ))}
                        </div>
                      )}
                      {noteFor === `${e.recapId}-${e.idx}` && (
                        <form
                          className="ledger-note-form"
                          onSubmit={(ev) => {
                            ev.preventDefault();
                            void saveNote(e);
                          }}
                        >
                          <input
                            autoFocus
                            value={noteText}
                            onChange={(ev) => setNoteText(ev.target.value)}
                            placeholder="현장 한 줄 남기기 (선택) — 예: 라인에 반영 완료"
                            maxLength={120}
                          />
                          <button type="submit">{noteText.trim() ? '남기기' : '건너뛰기'}</button>
                        </form>
                      )}
                    </div>
                    {/* 수신 확인 — 회람 사인. 이미 확인했으면 상태 뱃지 */}
                    {acked ? (
                      <span className="ledger-ack done">확인함 <CheckMarkIcon size={12} /></span>
                    ) : (
                      <button className="ledger-ack" onClick={() => void ack(e)}>
                        확인
                      </button>
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
