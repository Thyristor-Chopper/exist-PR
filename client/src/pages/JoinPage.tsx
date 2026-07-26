import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuthStore } from '../store';

/*
 * 초대 링크 랜딩 — /join/:code
 * 코드를 저장해두고 로그인(또는 대시보드)으로 보내면,
 * DashboardPage가 마운트될 때 자동으로 그룹에 참여시키고 열어준다.
 * 로그인·회원가입을 거쳐 와도 sessionStorage에 코드가 남아 있어 이어진다.
 */
export default function JoinPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (code?.trim()) {
      sessionStorage.setItem('exist:pending-join', code.trim().toUpperCase());
    }
    navigate(token ? '/' : '/login', { replace: true });
  }, [code, token, navigate]);

  return null;
}
