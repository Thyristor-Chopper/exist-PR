import { useState } from 'react';
import { CheckMarkIcon } from './Icons';

/** 1회용 복구 코드 표시 — 가입/재설정 직후 단 한 번만 보여줌 */
export default function RecoveryCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard 권한 없음 — 수동 복사 */
    }
  }

  return (
    <div className="recovery-wrap">
      <div className="recovery-title">🔑 복구 코드</div>
      <div className="recovery-desc">
        비밀번호를 잊었을 때 이 코드로 재설정할 수 있어요.
        <br />
        <b>지금 단 한 번만 표시됩니다.</b> 안전한 곳에 보관하세요.
      </div>
      <div className="recovery-box">{code}</div>
      <button type="button" className="recovery-copy" onClick={copy}>
        {copied ? <><CheckMarkIcon size={12} /> 복사됨</> : '복사하기'}
      </button>
    </div>
  );
}
