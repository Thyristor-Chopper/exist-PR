import { useEffect, useState } from 'react';
import { api } from '../api';
import { useOrgStore, type Org } from '../orgStore';
import { CheckMarkIcon } from './Icons';

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 조직 생성 — 생성하면 가입코드를 보여주고, 새 조직을 현재 컨텍스트로 전환 */
export default function CreateOrgModal({ open, onClose }: Props) {
  const load = useOrgStore((s) => s.load);
  const setCurrent = useOrgStore((s) => s.setCurrent);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<Org | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setCreated(null);
    setCopied(false);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const org = await api<Org>('/api/orgs', { method: 'POST', body: { name } });
      await load();
      setCurrent(org.id);
      setCreated(org);
    } catch {
      /* 전역 토스트 */
    }
  }

  async function copyCode() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.joinCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* 수동 */
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {created ? (
          <>
            <div className="modal-head">🏢 {created.name} 조직이 만들어졌어요</div>
            <div className="modal-sub">
              이 가입코드를 팀원에게 공유하세요. 신청이 오면 멤버 관리에서 승인할 수 있어요.
            </div>
            <div className="meeting-code-box" onClick={copyCode} title="클릭해서 복사">
              {created.joinCode}
            </div>
            <button className="modal-ghost" onClick={copyCode}>
              {copied ? <><CheckMarkIcon size={12} /> 복사됨</> : '가입코드 복사하기'}
            </button>
            <div className="modal-actions">
              <button className="modal-primary" onClick={onClose}>
                완료
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="modal-head">새 조직 만들기</div>
            <div className="modal-sub">회사·팀 단위로 그룹과 멤버를 관리해요</div>
            <label className="modal-label">
              조직 이름
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 런타임 주식회사"
                maxLength={40}
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={onClose}>
                취소
              </button>
              <button type="submit" className="modal-primary" disabled={!name.trim()}>
                만들기
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
