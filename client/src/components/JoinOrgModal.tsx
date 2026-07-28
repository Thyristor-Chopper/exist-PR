import { useEffect, useState } from 'react';
import { api } from '../api';
import { MailIcon } from './Icons';
import { useOrgStore } from '../orgStore';

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 조직 가입 신청 — 가입코드 입력 → 관리자 승인 대기 */
export default function JoinOrgModal({ open, onClose }: Props) {
  const load = useOrgStore((s) => s.load);
  const [code, setCode] = useState('');
  const [done, setDone] = useState<string | null>(null); // 신청한 조직 이름

  useEffect(() => {
    if (!open) return;
    setCode('');
    setDone(null);
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
    if (!code.trim()) return;
    try {
      const res = await api<{ orgName: string }>('/api/orgs/join', {
        method: 'POST',
        body: { joinCode: code },
      });
      await load();
      setDone(res.orgName);
    } catch {
      /* 전역 토스트 (이미 멤버/대기중/없는 코드 등) */
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <>
            <div className="modal-head"><MailIcon size={16} /> 가입 신청을 보냈어요</div>
            <div className="modal-sub">
              <b>{done}</b> 관리자가 승인하면 조직 그룹에 참여할 수 있어요.
            </div>
            <div className="modal-actions">
              <button className="modal-primary" onClick={onClose}>
                확인
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="modal-head">조직 가입하기</div>
            <div className="modal-sub">관리자에게 받은 가입코드를 입력하세요</div>
            <label className="modal-label">
              가입코드
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="예: ABCD-2345"
                autoFocus
                style={{ textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="modal-cancel" onClick={onClose}>
                취소
              </button>
              <button type="submit" className="modal-primary" disabled={!code.trim()}>
                신청
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
