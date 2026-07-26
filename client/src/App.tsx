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

function Protected({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  return token ? children : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <ErrorToasts />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/forgot" element={<ForgotPage />} />
        {/* 초대 링크 — 로그인 여부를 스스로 판단하므로 Protected 밖 */}
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
