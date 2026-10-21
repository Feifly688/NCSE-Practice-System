import React, { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ConfigProvider, Spin } from 'antd';
import { AuthProvider } from './contexts/AuthContext';
import MainLayout from './layouts/MainLayout';
import AdminLayout from './layouts/AdminLayout';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import GuestRoute from './components/GuestRoute';
import ErrorBoundary from './components/ErrorBoundary';
import AuthModal from './components/AuthModal';
import Home from './pages/Home';

// 首屏核心页面同步加载，其余按需加载
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Practice = lazy(() => import('./pages/Practice'));
const History = lazy(() => import('./pages/History'));
const WrongBook = lazy(() => import('./pages/WrongBook'));
const Favorites = lazy(() => import('./pages/Favorites'));
const Profile = lazy(() => import('./pages/Profile'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const NotFound = lazy(() => import('./pages/NotFound'));
const AdminHome = lazy(() => import('./pages/admin/AdminHome'));
const Questions = lazy(() => import('./pages/admin/Questions'));
const Users = lazy(() => import('./pages/admin/Users'));
const Generate = lazy(() => import('./pages/admin/Generate'));
const Articles = lazy(() => import('./pages/admin/Articles'));
const ExamPapers = lazy(() => import('./pages/admin/ExamPapers'));

const theme = {
  token: {
    colorPrimary: '#1D4ED8',
    borderRadius: 8,
    colorBgContainer: '#ffffff',
  },
};

// 路由懒加载时的占位
function PageFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
      <Spin size="large" tip="加载中..." />
    </div>
  );
}

/**
 * 登录 / 注册已改为首页内嵌卡片，不再有独立页面。
 * 保留这两个路径做兼容：旧的 401 跳转、ProtectedRoute 重定向
 * 以及外部书签都会落到这里，直接返回首页 —— 未登录时首页
 * 本身就会展示登录卡片，无需再额外唤起弹窗。
 */
function AuthRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    navigate('/', { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <PageFallback />;
}

export default function App() {
  return (
    <ErrorBoundary>
    <ConfigProvider theme={theme}>
      <BrowserRouter>
        <AuthProvider>
          {/* 弹窗仅服务于非首页入口（如顶部导航的登录按钮）；
              首页改用内嵌卡片，不再叠加遮罩 */}
          <AuthModal />
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route element={<MainLayout />}>
                {/* 登录页（首页）：已登录用户由 GuestRoute 守卫重定向到仪表盘 */}
                <Route path="/" element={<GuestRoute><Home /></GuestRoute>} />
                <Route path="/login" element={<AuthRedirect />} />
                <Route path="/register" element={<AuthRedirect />} />
                <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
                <Route path="/practice" element={<ProtectedRoute><Practice /></ProtectedRoute>} />
                <Route path="/history" element={<ProtectedRoute><History /></ProtectedRoute>} />
                <Route path="/favorites" element={<ProtectedRoute><Favorites /></ProtectedRoute>} />
                <Route path="/wrong-book" element={<ProtectedRoute><WrongBook /></ProtectedRoute>} />
                <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
                <Route path="/leaderboard" element={<ProtectedRoute><Leaderboard /></ProtectedRoute>} />
                <Route path="*" element={<NotFound />} />
              </Route>
              <Route path="/admin" element={<AdminRoute><AdminLayout /></AdminRoute>}>
                <Route index element={<AdminHome />} />
                <Route path="questions" element={<Questions />} />
                <Route path="articles" element={<Articles />} />
                <Route path="users" element={<Users />} />
                <Route path="generate" element={<Generate />} />
                <Route path="exam-papers" element={<ExamPapers />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </Suspense>
        </AuthProvider>
      </BrowserRouter>
    </ConfigProvider>
    </ErrorBoundary>
  );
}
