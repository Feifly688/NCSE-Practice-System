import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ConfigProvider, Spin } from 'antd';
import { AuthProvider } from './contexts/AuthContext';
import MainLayout from './layouts/MainLayout';
import AdminLayout from './layouts/AdminLayout';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import ErrorBoundary from './components/ErrorBoundary';
import Home from './pages/Home';

// 首屏核心页面同步加载，其余按需加载
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
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

export default function App() {
  return (
    <ErrorBoundary>
    <ConfigProvider theme={theme}>
      <BrowserRouter>
        <AuthProvider>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route element={<MainLayout />}>
                <Route path="/" element={<Home />} />
                <Route path="/login" element={<Login />} />
                <Route path="/register" element={<Register />} />
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
