import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import { getSocket } from '../lib/socket';
import { useDisplayName } from '../names';
import { CheckMarkIcon, SparklesIcon } from './Icons';

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
  attendees: string[];
  ts: number;
  acks: { username: string; ts: number }[];
}

function dateLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export default function DecisionLedger({ code }: { code: string }) {
  const user = useAuthStore((s) => s.user);
  const dn = useDisplayName();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [query, setQuery] = useState('');

  const load = useCallback(() => {
    void api<LedgerEntry[]>(`/api/meetings/${code}/decisions`)
      .then(setEntries)
      .catch(() => {});
  }, [code]);

  async function ack(e: LedgerEntry) {
    // 낙관적 반영 후 서버 기록
    setEntries((prev) =>
      prev.map((x) =>
        x.recapId === e.recapId && x.idx === e.idx
          ? { ...x, acks: [...x.acks, { username: user?.username ?? '', ts: Date.now() }] }
          : x,
      ),
    );
    await api(`/api/meetings/${code}/decisions/ack`, {
      method: 'POST',
      body: { recapId: e.recapId, idx: e.idx },
    }).catch(() => load());
  }

  useEffect(load, [load]);

  // 통화가 끝나고 새 recap이 생기면 원장도 즉시 갱신
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
          <CheckMarkIcon size={16} /> 결정 원장
          <span className="ledger-count">{entries.length}</span>
        </div>
        <input
          className="ledger-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="결정 검색"
        />
      </div>

      {entries.length === 0 ? (
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
                      <div className="ledger-decision">{e.decision}</div>
                      {e.why && <div className="ledger-why">배경 · {e.why}</div>}
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
                      </div>
                    </div>
                    {/* 수신 확인 — 회람 사인. 이미 확인했으면 상태 뱃지 */}
                    {acked ? (
                      <span className="ledger-ack done">확인함 ✓</span>
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
