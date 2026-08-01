import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import { useDisplayName } from '../names';
import { CheckMarkIcon, SparklesIcon, AlertIcon, ListIcon, BulbIcon, RefreshIcon } from './Icons';
// AlertIcon — 복명복창 대조 mismatch 배지에 사용

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
  /** 반복 점검 체크리스트 스냅샷 (발행 시점) */
  checks: { label: string; done: boolean }[];
  source: string;
  ts: number;
  acks: {
    username: string;
    ts: number;
    note: string | null;
    echoCheck: 'ok' | 'mismatch' | null;
    echoReason: string | null;
  }[];
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
  // AI 부족분 점검 — "작성자 주관에 따라 상세함이 달라진다"의 해법: 표준 강제 대신 검토 제안
  const [review, setReview] = useState<null | 'loading' | { section: keyof Sections; text: string }[]>(null);

  // 반복 점검 체크리스트 — 그룹별 정형 항목 (자유 서술과 달리 매 교대 반복되는 것)
  const [checkItems, setCheckItems] = useState<{ id: number; label: string }[]>([]);
  const [checkState, setCheckState] = useState<Record<number, boolean>>({});
  const [newCheck, setNewCheck] = useState('');

  const load = useCallback(() => {
    void api<Handover[]>(`/api/meetings/${code}/handovers`)
      .then(setList)
      .catch(() => setList([]));
    void api<{ id: number; label: string }[]>(`/api/meetings/${code}/handovers/checklist`, { silent: true })
      .then(setCheckItems)
      .catch(() => {});
  }, [code]);
  useEffect(load, [load]);

  async function addCheckItem() {
    const label = newCheck.trim();
    if (!label) return;
    setNewCheck('');
    try {
      await api(`/api/meetings/${code}/handovers/checklist`, { method: 'POST', body: { label } });
      load();
    } catch {
      /* 전역 토스트 */
    }
  }
  async function removeCheckItem(id: number) {
    setCheckItems((prev) => prev.filter((c) => c.id !== id));
    await api(`/api/meetings/${code}/handovers/checklist/${id}`, { method: 'DELETE' }).catch(() => load());
  }

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

  /** AI 점검 — 초안과 이번 조 기록을 대조해 빠진 항목 제안 */
  async function runReview() {
    if (!editing || review === 'loading') return;
    setReview('loading');
    const toArr = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
    try {
      const r = await api<{ suggestions: { section: keyof Sections; text: string }[] }>(
        `/api/meetings/${code}/handovers/review`,
        {
          method: 'POST',
          body: {
            sections: {
              issues: toArr(editing.sections.issues),
              changes: toArr(editing.sections.changes),
              pending: toArr(editing.sections.pending),
              notes: toArr(editing.sections.notes),
            },
          },
        },
      );
      setReview(r.suggestions);
    } catch {
      setReview(null);
    }
  }

  /** 제안 [추가] — 해당 섹션 끝에 한 줄 붙이고 제안 목록에서 제거 */
  function applySuggestion(s: { section: keyof Sections; text: string }) {
    setEditing((prev) =>
      prev
        ? {
            ...prev,
            sections: {
              ...prev.sections,
              [s.section]: (prev.sections[s.section] ? prev.sections[s.section] + '\n' : '') + s.text,
            },
          }
        : prev,
    );
    setReview((prev) => (Array.isArray(prev) ? prev.filter((x) => x !== s) : prev));
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
          checks: checkItems.map((it) => ({ label: it.label, done: !!checkState[it.id] })),
        },
      });
      setEditing(null);
      setReview(null);
      load();
    } catch {
      /* 전역 토스트 */
    } finally {
      setPublishing(false);
    }
  }

  // 복명복창 — 서명 직후 "내가 이해한 내용 한 줄"(선택) 입력, AI가 원본과 대조
  const [echoFor, setEchoFor] = useState<number | null>(null);
  const [echoText, setEchoText] = useState('');

  async function ack(h: Handover) {
    setList((prev) =>
      (prev ?? []).map((x) =>
        x.id === h.id
          ? {
              ...x,
              acks: [
                ...x.acks,
                { username: user?.username ?? '', ts: Date.now(), note: null, echoCheck: null, echoReason: null },
              ],
            }
          : x,
      ),
    );
    setEchoFor(h.id);
    setEchoText('');
    await api(`/api/meetings/${code}/handovers/${h.id}/ack`, { method: 'POST', body: {} }).catch(
      () => load(),
    );
  }

  /** 복명복창 저장 — 같은 ack 엔드포인트 재호출 (멱등 + 노트 갱신), AI 대조는 서버가 비동기로 */
  async function saveEcho(h: Handover) {
    const note = echoText.trim();
    setEchoFor(null);
    if (!note) return;
    await api(`/api/meetings/${code}/handovers/${h.id}/ack`, {
      method: 'POST',
      body: { note },
    }).catch(() => {});
    // 대조 결과(비동기)를 잠시 후 반영
    setTimeout(load, 4000);
    load();
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
          {/* 반복 점검 체크리스트 — 매 교대 반복되는 정형 항목 (자주 나오는 건 서술 대신 체크) */}
          <div className="ho-checklist">
            <span className="ho-sec-label">
              <ListIcon size={13} /> 반복 점검
            </span>
            {checkItems.length === 0 && (
              <span className="ho-check-empty">
                매 교대 반복되는 점검 항목을 등록해두세요 (예: 설비 알람 확인, 파라미터 확인)
              </span>
            )}
            {checkItems.map((it) => (
              <label key={it.id} className="ho-check-row">
                <input
                  type="checkbox"
                  checked={!!checkState[it.id]}
                  onChange={(e) => setCheckState((prev) => ({ ...prev, [it.id]: e.target.checked }))}
                />
                <span className="ho-check-label">{it.label}</span>
                <button
                  type="button"
                  className="ho-check-del"
                  title="항목 삭제 (그룹 공통)"
                  onClick={() => void removeCheckItem(it.id)}
                >
                  ×
                </button>
              </label>
            ))}
            <form
              className="ho-check-add"
              onSubmit={(e) => {
                e.preventDefault();
                void addCheckItem();
              }}
            >
              <input
                value={newCheck}
                onChange={(e) => setNewCheck(e.target.value)}
                placeholder="점검 항목 추가"
                maxLength={80}
              />
              <button type="submit" disabled={!newCheck.trim()}>
                추가
              </button>
            </form>
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
          {/* AI 점검 결과 — 기록엔 있는데 초안에 빠진 것 (한 클릭으로 채움) */}
          {Array.isArray(review) && review.length === 0 && (
            <div className="ho-review-ok">
              <CheckMarkIcon size={12} /> 이번 조 기록과 대조했어요 — 빠진 게 없어 보여요
            </div>
          )}
          {Array.isArray(review) && review.length > 0 && (
            <div className="ho-review">
              <div className="ho-review-head">
                <SparklesIcon size={12} /> 기록엔 있는데 초안에 없는 것
              </div>
              {review.map((s, i) => (
                <div key={i} className="ho-review-row">
                  <span className="ho-review-sec">
                    {SECTION_META.find((m) => m.key === s.section)?.label}
                  </span>
                  <span className="ho-review-text">{s.text}</span>
                  <button className="ho-review-add" onClick={() => applySuggestion(s)}>
                    + 추가
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="ho-editor-actions">
            <button
              className="ho-review-btn"
              onClick={() => void runReview()}
              disabled={review === 'loading'}
            >
              <SparklesIcon size={13} /> {review === 'loading' ? '점검 중…' : 'AI 점검 — 빠진 것 찾기'}
            </button>
            <span className="ho-actions-spacer" />
            <button
              className="ho-cancel"
              onClick={() => {
                setEditing(null);
                setReview(null);
              }}
            >
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
                {/* 반복 점검 결과 — 미점검이 한눈에 보이게 */}
                {h.checks.length > 0 && (
                  <div className="ho-sec">
                    <div className="ho-sec-head">
                      <ListIcon size={12} /> 반복 점검 (
                      {h.checks.filter((c) => c.done).length}/{h.checks.length})
                    </div>
                    <div className="ho-check-grid">
                      {h.checks.map((c, i) => (
                        <span key={i} className={`ho-check-chip${c.done ? ' done' : ''}`}>
                          {c.done ? '✓' : '○'} {c.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
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
                {/* 복명복창 — 수신자들이 자기 말로 남긴 이해와 AI 대조 결과 */}
                {h.acks.some((a) => a.note) && (
                  <div className="ho-echoes">
                    {h.acks
                      .filter((a) => a.note)
                      .map((a) => (
                        <div key={a.username} className="ho-echo-row">
                          <b>{dn(a.username)}</b> “{a.note}”
                          {a.echoCheck === 'ok' && (
                            <span className="ho-echo-ok">
                              <CheckMarkIcon size={11} /> 이해 일치
                            </span>
                          )}
                          {a.echoCheck === 'mismatch' && (
                            <span className="ho-echo-bad" title={a.echoReason ?? ''}>
                              <AlertIcon size={11} /> 해석 확인 필요{a.echoReason ? ` — ${a.echoReason}` : ''}
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                )}
                {echoFor === h.id && (
                  <form
                    className="ho-echo-form"
                    onSubmit={(ev) => {
                      ev.preventDefault();
                      void saveEcho(h);
                    }}
                  >
                    <input
                      autoFocus
                      value={echoText}
                      onChange={(e) => setEchoText(e.target.value)}
                      placeholder="내가 이해한 내용 한 줄 (선택) — AI가 원본과 대조해요"
                      maxLength={200}
                    />
                    <button type="submit">{echoText.trim() ? '남기기' : '건너뛰기'}</button>
                  </form>
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
