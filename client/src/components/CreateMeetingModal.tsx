import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useOrgStore, type OrgContext } from '../orgStore';
import { useDisplayName } from '../names';
import { useAuthStore } from '../store';
import { CloseIcon, CalendarIcon, CopyIcon, CheckMarkIcon, BuildingIcon } from './Icons';
import Avatar from './Avatar';

interface Person {
  username: string;
  avatar: string | null;
}

type Recur = 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly';
const RECUR_OPTS: { id: Recur; label: string }[] = [
  { id: 'none', label: '안 함' },
  { id: 'daily', label: '매일' },
  { id: 'weekly', label: '매주' },
  { id: 'biweekly', label: '격주' },
  { id: 'monthly', label: '매월' },
];

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  /** 일정 잡기 진입 — 열릴 때 일정 토글을 미리 켠다 */
  defaultSchedule?: boolean;
}

export default function CreateMeetingModal({ open, onClose, onCreated, defaultSchedule }: Props) {
  const navigate = useNavigate();
  const dn = useDisplayName();
  const orgs = useOrgStore((s) => s.orgs);
  const current = useOrgStore((s) => s.current);
  const [title, setTitle] = useState('');
  const [orgCtx, setOrgCtx] = useState<OrgContext>('personal');
  const [schedOn, setSchedOn] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [recur, setRecur] = useState<Recur>('none');
  const [invite, setInvite] = useState<Person[]>([]);
  const [pq, setPq] = useState('');
  const [results, setResults] = useState<Person[]>([]);
  const [searching, setSearching] = useState(false);
  const [created, setCreated] = useState<{ code: string; title: string; invited: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setOrgCtx(current);
    setSchedOn(!!defaultSchedule);
    setStart('');
    setEnd('');
    setRecur('none');
    setInvite([]);
    setPq('');
    setResults([]);
    setCreated(null);
    setCopied(false);
    setPhoto(null);
    setPhotoPreview(null);
  }, [open, current, defaultSchedule]);

  // 초대할 사람 검색 (디바운스)
  useEffect(() => {
    if (!open) return;
    const q = pq.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const orgParam = orgCtx === 'personal' ? '' : `&org=${orgCtx}`;
        const rows = await api<Person[]>(
          `/api/meetings/users/search?q=${encodeURIComponent(q)}${orgParam}`,
        );
        setResults(rows);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [pq, open, orgCtx]);

  // 조직(회의 위치)을 바꾸면 초대 후보가 달라지므로 선택 초기화
  const firstOrg = useRef(true);
  useEffect(() => {
    if (!open) return;
    if (firstOrg.current) {
      firstOrg.current = false;
      return;
    }
    setInvite([]);
    setPq('');
    setResults([]);
  }, [orgCtx, open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  function onPhotoPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f || !f.type.startsWith('image/')) return;
    setPhoto(f);
    setPhotoPreview(URL.createObjectURL(f));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const m = await api<{ code: string; title: string; invited: string[] }>('/api/meetings', {
        method: 'POST',
        body: {
          title,
          org_id: orgCtx === 'personal' ? null : orgCtx,
          starts_at: schedOn ? start || null : null,
          // 반복(정기 그룹)이면 종료 = 반복이 끝나는 날(recur_until)로 쓰고
          // 회차별 지속시간(ends_at)은 비운다. 단발 회의일 때만 종료가 그 회의의 끝.
          ends_at: schedOn && recur === 'none' ? end || null : null,
          recur: schedOn ? recur : 'none',
          recur_until: schedOn && recur !== 'none' ? end?.slice(0, 10) || null : null,
          invite: invite.map((p) => p.username),
        },
      });
      // 그룹 생성 직후 사진이 있으면 업로드 (호스트=생성자라 권한 OK)
      if (photo) {
        try {
          await fetch(`/api/meetings/${m.code}/thumbnail`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${useAuthStore.getState().token ?? ''}`,
              'Content-Type': photo.type,
            },
            body: photo,
          });
        } catch {
          /* 사진 실패해도 그룹 생성은 유지 */
        }
      }
      setCreated({ code: m.code, title, invited: m.invited?.length ?? 0 });
      onCreated();
    } catch {
      /* 전역 에러 토스트 */
    }
  }

  function addPerson(p: Person) {
    if (!invite.some((x) => x.username === p.username)) setInvite((v) => [...v, p]);
    setPq('');
    setResults([]);
  }
  function removePerson(username: string) {
    setInvite((v) => v.filter((x) => x.username !== username));
  }

  async function copyCode() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 수동 복사 */
    }
  }

  return (
    <div className="cm-overlay" onClick={onClose}>
      <div className="cm-modal" onClick={(e) => e.stopPropagation()}>
        {created ? (
          <div className="cm-done">
            <div className="cm-done-emoji">🎉</div>
            <h2 className="cm-done-title">그룹이 만들어졌어요</h2>
            <p className="cm-done-sub">
              {created.invited > 0
                ? `${created.invited}명을 초대했어요. 코드로도 참여할 수 있어요`
                : '팀원에게 코드를 공유하면 바로 참여할 수 있어요'}
            </p>
            <button className="cm-code" onClick={copyCode} title="클릭해서 복사">
              <span className="cm-code-val">{created.code}</span>
              <span className="cm-code-copy">
                {copied ? <CheckMarkIcon size={18} /> : <CopyIcon size={18} />}
              </span>
            </button>
            <div className="cm-footer">
              <button className="cm-btn ghost" onClick={onClose}>
                닫기
              </button>
              <button className="cm-btn primary" onClick={() => navigate(`/meeting/${created.code}`)}>
                지금 입장 →
              </button>
            </div>
          </div>
        ) : (
          <form className="cm-form" onSubmit={submit}>
            <div className="cm-header">
              <div className="cm-header-ic">
                <CalendarIcon size={22} />
              </div>
              <div className="cm-header-text">
                <h2>새 그룹 만들기</h2>
                <p>팀과 함께할 공간을 만들어요</p>
              </div>
              <button type="button" className="cm-x" onClick={onClose}>
                <CloseIcon size={18} />
              </button>
            </div>

            <div className="cm-body">
              <div className="cm-field">
                <span className="cm-field-label">그룹 이름</span>
                <input
                  className="cm-input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="예: 주간 스프린트 리뷰"
                  autoFocus
                />
              </div>

              <div className="cm-field">
                <span className="cm-field-label">
                  그룹 사진 <span className="cm-opt">(선택)</span>
                </span>
                <div className="cm-photo-row">
                  <button
                    type="button"
                    className="cm-photo-pick"
                    onClick={() => photoRef.current?.click()}
                  >
                    {photoPreview ? (
                      <img src={photoPreview} alt="" />
                    ) : (
                      <span className="cm-photo-plus">+</span>
                    )}
                  </button>
                  <input
                    ref={photoRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={onPhotoPick}
                  />
                  <div className="cm-photo-actions">
                    <button
                      type="button"
                      className="cm-photo-btn"
                      onClick={() => photoRef.current?.click()}
                    >
                      {photoPreview ? '변경' : '사진 선택'}
                    </button>
                    {photoPreview && (
                      <button
                        type="button"
                        className="cm-photo-btn ghost"
                        onClick={() => {
                          setPhoto(null);
                          setPhotoPreview(null);
                        }}
                      >
                        제거
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <div className="cm-field">
                <span className="cm-field-label">어디에 만들까요?</span>
                <div className="cm-orgs">
                  <button
                    type="button"
                    className={`cm-org${orgCtx === 'personal' ? ' on' : ''}`}
                    onClick={() => setOrgCtx('personal')}
                  >
                    <span className="cm-org-ic personal">👤</span>
                    <span className="cm-org-name">개인 그룹</span>
                  </button>
                  {orgs.map((o) => (
                    <button
                      type="button"
                      key={o.id}
                      className={`cm-org${orgCtx === o.id ? ' on' : ''}`}
                      onClick={() => setOrgCtx(o.id)}
                    >
                      <span className="cm-org-ic">
                        <BuildingIcon size={17} />
                      </span>
                      <span className="cm-org-name">{o.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="cm-field">
                <span className="cm-field-label">
                  사람 초대 <span className="cm-field-opt">선택</span>
                </span>
                {invite.length > 0 && (
                  <div className="cm-invited">
                    {invite.map((p) => (
                      <span className="cm-chip" key={p.username}>
                        <Avatar value={p.avatar} className="cm-chip-av" />
                        {dn(p.username)}
                        <button type="button" onClick={() => removePerson(p.username)}>
                          <CloseIcon size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="cm-search">
                  <input
                    className="cm-input"
                    value={pq}
                    onChange={(e) => setPq(e.target.value)}
                    placeholder="이름으로 검색해서 초대"
                  />
                  {pq.trim() && (
                    <div className="cm-results">
                      {searching && <div className="cm-results-empty">찾는 중…</div>}
                      {!searching &&
                        results.filter((r) => !invite.some((x) => x.username === r.username))
                          .length === 0 && <div className="cm-results-empty">검색 결과 없음</div>}
                      {results
                        .filter((r) => !invite.some((x) => x.username === r.username))
                        .map((r) => (
                          <button
                            type="button"
                            className="cm-result"
                            key={r.username}
                            onClick={() => addPerson(r)}
                          >
                            <Avatar value={r.avatar} className="cm-result-av" />
                            <span className="cm-result-name">{dn(r.username)}</span>
                            <span className="cm-result-add">+ 추가</span>
                          </button>
                        ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="cm-field">
                <button
                  type="button"
                  className="cm-sched-toggle"
                  onClick={() => setSchedOn((v) => !v)}
                >
                  <span className="cm-sched-label">
                    <CalendarIcon size={15} /> 일정 잡기
                    <span className="cm-sched-opt">선택</span>
                  </span>
                  <span className={`cm-switch${schedOn ? ' on' : ''}`}>
                    <i />
                  </span>
                </button>
                {schedOn && (
                  <div className="cm-sched">
                    <label className="cm-sched-row">
                      <span>{recur === 'none' ? '시작' : '시작일'}</span>
                      <input
                        type="datetime-local"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                      />
                    </label>
                    <label className="cm-sched-row">
                      <span>{recur === 'none' ? '종료' : '종료일'}</span>
                      <input
                        type="datetime-local"
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                      />
                    </label>

                    <div className="cm-recur">
                      <span className="cm-recur-label">반복</span>
                      <div className="cm-recur-opts">
                        {RECUR_OPTS.map((o) => (
                          <button
                            type="button"
                            key={o.id}
                            className={`cm-recur-chip${recur === o.id ? ' on' : ''}`}
                            onClick={() => setRecur(o.id)}
                          >
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {recur !== 'none' && (
                      <p className="cm-sched-hint">
                        {RECUR_OPTS.find((o) => o.id === recur)?.label} 반복돼요. 위 <b>종료일</b>까지
                        이어지고, 안 정하면 계속 반복해요. 세부 일정·통화는 만든 뒤 일정 탭에서
                        추가하면 돼요.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="cm-footer">
              <button type="button" className="cm-btn ghost" onClick={onClose}>
                취소
              </button>
              <button type="submit" className="cm-btn primary" disabled={!title.trim()}>
                그룹 만들기
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
