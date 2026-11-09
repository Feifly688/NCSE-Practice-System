import React, { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ConfigProvider, Spin, theme as antdTheme } from 'antd';
import { AuthProvider } from './contexts/AuthContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import MainLayout from './layouts/MainLayout';
import AdminLayout from './layouts/AdminLayout';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import GuestRoute from './components/GuestRoute';
import ErrorBoundary from './components/ErrorBoundary';
import AuthModal from './components/AuthModal';

// 全部页面按需加载：落地页的重组件已在页内再做二次 lazy，
// 这里拆成路由级 chunk，避免把首页的 antd 组件也压进主入口。
const Home = lazy(() => import('./pages/Home'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Practice = lazy(() => import('./pages/Practice'));
const SpecialPractice = lazy(() => import('./pages/SpecialPractice'));
const History = lazy(() => import('./pages/History'));
const Report = lazy(() => import('./pages/Report'));
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
const ExamPaperList = lazy(() => import('./pages/ExamPaperList'));
const ExamPaperTake = lazy(() => import('./pages/ExamPaperTake'));

/**
 * antd 主题跟随日夜模式。
 * 放在 App 内部的一个小组件里，因为它需要读 useTheme() 的上下文。
 */
function ThemedApp() {
  const { tokens, isDark } = useTheme();
  const antdThemeConfig = {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: tokens.primary,
      colorInfo: tokens.primaryLight,
      colorSuccess: tokens.success,
      colorWarning: tokens.warning,
      colorError: tokens.error,
      colorTextBase: tokens.text,
      colorBgBase: tokens.cardBg,
      colorBgLayout: tokens.pageBg,
      borderRadius: 8,
      fontFamily: '"Noto Sans SC", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    },
    components: {
      Card: { colorBgContainer: tokens.cardBg },
      Layout: { bodyBg: tokens.pageBg, headerBg: tokens.cardBg },
      Table: { colorBgContainer: tokens.cardBg },
    },
  };
  return (
    <ConfigProvider theme={antdThemeConfig}>
      <BrowserRouter>
        <AuthProvider>
          {/* 弹窗仅服务于非首页入口（如顶部导航的登录按钮）；
              首页改用内嵌卡片，不再叠加遮罩 */}
          <AuthModal />

          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route element={<MainLayout />}>
                {/* 首页（深色落地页，MainLayout 内部有 isHome 分支特殊处理） */}
                <Route path="/" element={<GuestRoute><Home /></GuestRoute>} />
                <Route path="/login" element={<AuthRedirect />} />
                <Route path="/register" element={<AuthRedirect />} />
                <Route path="/dashboard" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
                {/* 专项练习：粉笔题库式的分类导航 + 自定义刷题 */}
                <Route path="/practice" element={<ProtectedRoute><SpecialPractice /></ProtectedRoute>} />
                {/* 单题练习（答题页）：支持 ?pool/?categories/?count 等分类刷题参数 */}
                <Route path="/practice/do" element={<ProtectedRoute><Practice /></ProtectedRoute>} />
                <Route path="/history" element={<ProtectedRoute><History /></ProtectedRoute>} />
                {/* 学习报告：按时间窗的做题量/正确率趋势与六模块能力 */}
                <Route path="/report" element={<ProtectedRoute><Report /></ProtectedRoute>} />
                <Route path="/wrong-book" element={<ProtectedRoute><WrongBook /></ProtectedRoute>} />
                <Route path="/favorites" element={<ProtectedRoute><Favorites /></ProtectedRoute>} />
                <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
                <Route path="/leaderboard" element={<ProtectedRoute><Leaderboard /></ProtectedRoute>} />
                {/* 整卷真题：列表与在线阅览/答题 */}
                <Route path="/exam-papers" element={<ProtectedRoute><ExamPaperList /></ProtectedRoute>} />
                <Route path="/exam-papers/:id" element={<ProtectedRoute><ExamPaperTake /></ProtectedRoute>} />
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
  );
}

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
    <ThemeProvider>
      <ErrorBoundary>
        <ThemedApp />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
