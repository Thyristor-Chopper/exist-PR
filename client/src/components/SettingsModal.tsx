import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuthStore } from '../store';
import { useNameStore } from '../names';
import Avatar from './Avatar';
import { SunIcon, MoonIcon } from './Icons';

const AVATARS = ['🐧', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐰', '🦉', '🐢', '🐳', '🚀'];

interface Props {
  open: boolean;
  onClose: () => void;
  avatar: string;
  onAvatarChange: (a: string) => void;
}

export default function SettingsModal({ open, onClose, avatar, onAvatarChange }: Props) {
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saveDone, setSaveDone] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 계정 정보
  const [nameInput, setNameInput] = useState(user?.name ?? '');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');

  /** 저장 하나로 통합 — 비어있지 않은 필드만 반영, 새 비밀번호가 있으면 비밀번호도 변경 */
  async function saveAll(e: React.FormEvent) {
    e.preventDefault();
    setSaveError('');
    setSaveDone('');
    // 비밀번호를 바꾸려는 경우만 사전 검증
    if (next || confirm || current) {
      if (!next) return setSaveError('새 비밀번호를 입력해주세요');
      if (next.length < 8) return setSaveError('새 비밀번호는 8자 이상이어야 합니다');
      if (next !== confirm) return setSaveError('새 비밀번호가 서로 다릅니다');
      if (!current) return setSaveError('현재 비밀번호를 입력해주세요');
    }
    setSaving(true);
    try {
      const body: Record<string, string> = {};
      if (nameInput.trim()) body.name = nameInput.trim();
      if (email.trim()) body.email = email.trim();
      if (phone.trim()) body.phone = phone.trim();
      if (address.trim()) body.address = address.trim();
      if (Object.keys(body).length > 0) {
        const r = await api<{ ok: boolean; name?: string | null }>('/api/auth/me', {
          method: 'PATCH',
          body,
        });
        if (r.name !== undefined) {
          const u = useAuthStore.getState().user;
          if (u) useAuthStore.setState({ user: { ...u, name: r.name } });
        }
        void useNameStore.getState().load();
      }
      if (next) {
        await api('/api/auth/password', {
          method: 'POST',
          body: { currentPassword: current, newPassword: next },
        });
        setCurrent('');
        setNext('');
        setConfirm('');
        setSaveDone('✓ 저장됐어요 (비밀번호 변경 — 다른 기기 세션은 모두 로그아웃됨)');
      } else {
        setSaveDone('✓ 저장됐어요');
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '저장에 실패했습니다');
    } finally {
      setSaving(false);
    }
  }

  // 다크모드 — 모바일에선 헤더 토글이 없어서 여기서 변경 (.settings-theme는 모바일에서만 노출)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  function toggleTheme() {
    const nextDark = !dark;
    document.documentElement.classList.toggle('dark', nextDark);
    localStorage.setItem('exist:theme', nextDark ? 'dark' : 'light');
    setDark(nextDark);
  }

  // ⚠️ deps는 [open]만 — onClose(부모의 인라인 함수)를 넣으면 부모가 리렌더될 때마다
  // (시계·알림 등) 이 effect가 재실행돼 서버 값 프리필이 입력 중인 폼을 덮어쓴다.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    setCurrent('');
    setNext('');
    setConfirm('');
    setSaveError('');
    setSaveDone('');
    setNameInput(useAuthStore.getState().user?.name ?? '');
    // 저장된 연락처 정보 프리필 (열리는 순간 1회만)
    void api<{ name: string | null; email: string | null; phone: string | null; address: string | null }>(
      '/api/auth/me',
    ).then((me) => {
      setNameInput(me.name ?? '');
      setEmail(me.email ?? '');
      setPhone(me.phone ?? '');
      setAddress(me.address ?? '');
    }).catch(() => {});
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  async function pickAvatar(a: string) {
    onAvatarChange(a); // 낙관적 반영
    try {
      await api('/api/auth/me', { method: 'PATCH', body: { avatar: a } });
    } catch {
      /* 전역 토스트 */
    }
  }

  async function uploadPhoto(file: File) {
    if (!file.type.startsWith('image/')) {
      window.dispatchEvent(new CustomEvent('app:error', { detail: '이미지 파일만 올릴 수 있어요' }));
      return;
    }
    setUploading(true);
    try {
      const res = await fetch('/api/auth/avatar', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': file.type },
        body: file,
      });
      const data = (await res.json()) as { avatar?: string; error?: string };
      if (!res.ok || !data.avatar) throw new Error(data.error ?? '업로드 실패');
      onAvatarChange(data.avatar);
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent('app:error', {
          detail: err instanceof Error ? err.message : '사진 업로드에 실패했어요',
        }),
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">설정</div>
        <div className="settings-user">
          <Avatar value={avatar} className="settings-avatar" />
          <b>{user?.name || user?.username}</b>
          {user?.name && <span className="settings-username">@{user.username}</span>}
          {/* 모바일 전용 — 헤더 프로필 메뉴가 없어서 로그아웃이 여기 */}
          <button className="settings-logout" onClick={logout}>
            로그아웃
          </button>
        </div>

        <div className="settings-theme">
          <div className="settings-section">화면 테마</div>
          <button type="button" className="theme-row" onClick={toggleTheme}>
            <span className="theme-row-label">
              {dark ? <MoonIcon size={16} /> : <SunIcon size={16} />}
              {dark ? '다크 모드' : '라이트 모드'}
            </span>
            <span className={`theme-switch${dark ? ' on' : ''}`}>
              <span className="theme-knob" />
            </span>
          </button>
        </div>

        <div className="settings-section">프로필 사진</div>
        <div className="avatar-upload">
          <button
            className="avatar-upload-btn"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? '올리는 중…' : '📷 사진 업로드'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadPhoto(f);
              e.target.value = '';
            }}
          />
          <span className="avatar-upload-hint">JPG·PNG, 최대 5MB</span>
        </div>

        <div className="settings-section">이모지로 선택</div>
        <div className="avatar-grid">
          {AVATARS.map((a) => (
            <button
              key={a}
              className={`avatar-pick${a === avatar ? ' active' : ''}`}
              onClick={() => void pickAvatar(a)}
            >
              {a}
            </button>
          ))}
        </div>

        <div className="settings-section">계정 정보</div>
        <form onSubmit={saveAll}>
          <label className="modal-label">
            이름
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder="표시할 이름"
              maxLength={20}
            />
          </label>
          <label className="modal-label">
            이메일
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@mail.com"
              maxLength={80}
              autoComplete="email"
            />
          </label>
          <label className="modal-label">
            전화번호
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="010-0000-0000"
              maxLength={30}
              autoComplete="tel"
            />
          </label>
          <label className="modal-label">
            주소
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="주소"
              maxLength={120}
              autoComplete="street-address"
            />
          </label>

          <div className="settings-section">비밀번호 변경 (바꿀 때만 입력)</div>
          <label className="modal-label">
            현재 비밀번호
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label className="modal-label">
            새 비밀번호 (8자 이상)
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label className="modal-label">
            새 비밀번호 확인
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          {saveError && (
            <div className="error" style={{ color: '#d33', fontSize: 13 }}>{saveError}</div>
          )}
          {saveDone && (
            <div style={{ color: 'var(--green)', fontSize: 13, fontWeight: 700 }}>{saveDone}</div>
          )}
          <div className="modal-actions">
            <button type="button" className="modal-cancel" onClick={onClose}>
              닫기
            </button>
            <button type="submit" className="modal-primary" disabled={saving}>
              {saving ? '저장 중…' : '저장'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
