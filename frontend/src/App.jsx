import React from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { AuthProvider } from './contexts/AuthContext';
import MainLayout from './layouts/MainLayout';
import AdminLayout from './layouts/AdminLayout';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import Home from './pages/Home';
import Login from './pages/Login';
import Register from './pages/Register';
import Dashboard from './pages/Dashboard';
import Practice from './pages/Practice';
import History from './pages/History';
import WrongBook from './pages/WrongBook';
import Favorites from './pages/Favorites';
import Profile from './pages/Profile';
import Leaderboard from './pages/Leaderboard';
import AdminHome from './pages/admin/AdminHome';
import Questions from './pages/admin/Questions';
import Users from './pages/admin/Users';
import Generate from './pages/admin/Generate';
import Articles from './pages/admin/Articles';
import NotFound from './pages/NotFound';
import ErrorBoundary from './components/ErrorBoundary';

const theme = {
  token: {
    colorPrimary: '#1D4ED8',
    borderRadius: 8,
    colorBgContainer: '#ffffff',
  },
};

export default function App() {
  return (
    <ErrorBoundary>
    <ConfigProvider theme={theme}>
      <BrowserRouter>
        <AuthProvider>
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
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ConfigProvider>
    </ErrorBoundary>
  );
}