import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import { useDisplayName } from '../names';
import { CheckMarkIcon, SparklesIcon, AlertIcon, ListIcon, BulbIcon, RefreshIcon } from './Icons';

/*
 * 교대 인수인계 — "주간조가 겪은 것을 야간조가 정확히 아는가"의 화면.
 * AI가 이번 조 기록에서 고정 4섹션 초안을 만들고(강제 입력 0), 조장이 다듬어 발행,
 * 다음 조는 작업 전에 서명(수신 확인). 형식 통일 + 도달 증명 + 검색 가능.
 */

interface Sections {
  issues: string[];
  changes: string[];
  pending: string[];
  notes: string[];
}

interface Handover {
  id: number;
  author: string;
  shiftLabel: string;
  sections: Sections;
  source: string;
  ts: number;
  acks: { username: string; ts: number }[];
}

const SECTION_META: { key: keyof Sections; label: string; Icon: typeof AlertIcon }[] = [
  { key: 'issues', label: '설비·작업 이상', Icon: AlertIcon },
  { key: 'changes', label: '변경 사항', Icon: RefreshIcon },
  { key: 'pending', label: '미완료 조치', Icon: ListIcon },
  { key: 'notes', label: '다음 조 유의사항', Icon: BulbIcon },
];

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function HandoverPanel({
  code,
  embedded = false,
}: {
  code: string;
  /** 기록(결정) 탭 안에 세그먼트로 렌더 — 제목 헤더는 바깥(ledger-head)이 가지므로 숨김 */
  embedded?: boolean;
}) {
  const user = useAuthStore((s) => s.user);
  const dn = useDisplayName();
  const [list, setList] = useState<Handover[] | null>(null);
  // 작성 모달 — AI 초안을 섹션별 textarea(줄 단위 항목)로 다듬는다
  const [editing, setEditing] = useState<null | { sections: Record<keyof Sections, string>; source: string }>(null);
  const [shiftLabel, setShiftLabel] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const load = useCallback(() => {
    void api<Handover[]>(`/api/meetings/${code}/handovers`)
      .then(setList)
      .catch(() => setList([]));
  }, [code]);
  useEffect(load, [load]);

  async function startDraft() {
    setDrafting(true);
    try {
      const d = await api<{ sections: Sections; source: string }>(
        `/api/meetings/${code}/handovers/draft`,
        { method: 'POST', body: {} },
      );
      setEditing({
        sections: {
          issues: d.sections.issues.join('\n'),
          changes: d.sections.changes.join('\n'),
          pending: d.sections.pending.join('\n'),
          notes: d.sections.notes.join('\n'),
        },
        source: d.source,
      });
      // 시간대 기반 기본 라벨 제안 — 사용자는 자유롭게 수정
      const h = new Date().getHours();
      setShiftLabel(h < 7 ? '야간조 → 주간조' : h < 15 ? '주간조 → 오후조' : '오후조 → 야간조');
    } catch {
      /* 전역 토스트 */
    } finally {
      setDrafting(false);
    }
  }

  async function publish() {
    if (!editing || publishing) return;
    const toArr = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
    setPublishing(true);
    try {
      await api(`/api/meetings/${code}/handovers`, {
        method: 'POST',
        body: {
          shiftLabel,
          source: editing.source,
          sections: {
            issues: toArr(editing.sections.issues),
            changes: toArr(editing.sections.changes),
            pending: toArr(editing.sections.pending),
            notes: toArr(editing.sections.notes),
          },
        },
      });
      setEditing(null);
      load();
    } catch {
      /* 전역 토스트 */
    } finally {
      setPublishing(false);
    }
  }

  async function ack(h: Handover) {
    setList((prev) =>
      (prev ?? []).map((x) =>
        x.id === h.id
          ? { ...x, acks: [...x.acks, { username: user?.username ?? '', ts: Date.now() }] }
          : x,
      ),
    );
    await api(`/api/meetings/${code}/handovers/${h.id}/ack`, { method: 'POST', body: {} }).catch(
      () => load(),
    );
  }

  return (
    <div className={`ho-wrap${embedded ? ' embedded' : ''}`}>
      <div className="ho-head">
        <div>
          {!embedded && <h3 className="ho-title">교대 인수인계</h3>}
          <p className="ho-sub">
            이번 조의 기록에서 AI가 초안을 만들어요 — 다듬어 발행하면 다음 조가 작업 전에
            서명합니다
          </p>
        </div>
        <button className="ho-new" onClick={() => void startDraft()} disabled={drafting}>
          <SparklesIcon size={14} /> {drafting ? '초안 만드는 중…' : '인수인계 작성'}
        </button>
      </div>

      {editing && (
        <div className="ho-editor">
          <div className="ho-editor-top">
            <input
              className="ho-shift"
              value={shiftLabel}
              onChange={(e) => setShiftLabel(e.target.value)}
              placeholder="교대 (예: 주간조 → 야간조)"
              maxLength={40}
            />
            <span className="ho-src">
              {editing.source === 'ai' ? 'AI 초안 — 다듬어 주세요' : '기록 기반 초안'}
            </span>
          </div>
          {SECTION_META.map(({ key, label, Icon }) => (
            <label key={key} className="ho-sec-edit">
              <span className="ho-sec-label">
                <Icon size={13} /> {label}
              </span>
              <textarea
                value={editing.sections[key]}
                onChange={(e) =>
                  setEditing((prev) =>
                    prev ? { ...prev, sections: { ...prev.sections, [key]: e.target.value } } : prev,
                  )
                }
                placeholder="한 줄에 하나씩 (없으면 비워두세요)"
                rows={Math.max(2, editing.sections[key].split('\n').length)}
              />
            </label>
          ))}
          <div className="ho-editor-actions">
            <button className="ho-cancel" onClick={() => setEditing(null)}>
              취소
            </button>
            <button className="ho-publish" onClick={() => void publish()} disabled={publishing}>
              {publishing ? '발행 중…' : '발행 — 다음 조에 전달'}
            </button>
          </div>
        </div>
      )}

      {list === null ? (
        <div className="ho-empty">불러오는 중…</div>
      ) : list.length === 0 && !editing ? (
        <div className="ho-empty">
          아직 인수인계가 없어요. 조가 끝날 때 <b>인수인계 작성</b>을 누르면 이번 조의 기록으로
          AI가 초안을 만들어요.
        </div>
      ) : (
        <div className="ho-list">
          {list.map((h) => {
            const mine = h.acks.some((a) => a.username === user?.username);
            const isAuthor = h.author === user?.username;
            return (
              <div key={h.id} className="ho-card">
                <div className="ho-card-head">
                  <span className="ho-shift-badge">{h.shiftLabel || '인수인계'}</span>
                  <span className="ho-meta">
                    {dn(h.author)} · {timeLabel(h.ts)}
                  </span>
                </div>
                {SECTION_META.map(({ key, label, Icon }) =>
                  h.sections[key].length === 0 ? null : (
                    <div key={key} className="ho-sec">
                      <div className="ho-sec-head">
                        <Icon size={12} /> {label}
                      </div>
                      <ul>
                        {h.sections[key].map((it, i) => (
                          <li key={i}>{it}</li>
                        ))}
                      </ul>
                    </div>
                  ),
                )}
                <div className="ho-card-foot">
                  <span className="ho-acks" title={h.acks.map((a) => dn(a.username)).join(', ')}>
                    <CheckMarkIcon size={12} /> 확인 {h.acks.length}명
                    {h.acks.length > 0 && (
                      <span className="ho-ack-names">
                        {' '}
                        — {h.acks.map((a) => dn(a.username)).join(', ')}
                      </span>
                    )}
                  </span>
                  {!mine && !isAuthor && (
                    <button className="ho-ack-btn" onClick={() => void ack(h)}>
                      확인했어요 — 작업 전 서명
                    </button>
                  )}
                  {mine && <span className="ho-signed">서명 완료</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
