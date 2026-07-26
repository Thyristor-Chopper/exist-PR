import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ForgotPage from './pages/ForgotPage';
import DashboardPage from './pages/DashboardPage';
import MeetingRoomPage from './pages/MeetingRoomPage';
import OrgChartPage from './pages/OrgChartPage';
import JoinPage from './pages/JoinPage';
import ErrorToasts from './components/ErrorToasts';
import { useLoadNames } from './names';

function Protected({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  return token ? children : <Navigate to="/login" replace />;
}

export default function App() {
  useLoadNames(); // 표시 이름 디렉터리 — 아이디 대신 이름으로 보여주기 위한 전역 맵
  return (
    <BrowserRouter>
      <ErrorToasts />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        {/* 초대 링크 — 로그인 여부를 스스로 판단하므로 Protected 밖 */}
        <Route path="/join/org/:code" element={<JoinPage org />} />
        <Route path="/join/:code" element={<JoinPage />} />
        <Route
          path="/"
          element={
            <Protected>
              <DashboardPage />
            </Protected>
          }
        />
        <Route
          path="/meeting/:code"
          element={
            <Protected>
              <MeetingRoomPage />
            </Protected>
          }
        />
        <Route
          path="/org/:id"
          element={
            <Protected>
              <OrgChartPage />
            </Protected>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
