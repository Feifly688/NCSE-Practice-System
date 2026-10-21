import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

/**
 * 访客路由守卫：已登录用户禁止访问登录页（当前为首页）。
 *
 * 登录后的默认首页为仪表盘（/dashboard）：
 * - 已登录访问 / → replace 重定向到 /dashboard；
 * - 使用 replace 而非 push，浏览器历史中不留下登录页记录，
 *   登录后按"返回"不会退回到登录页（防回退）。
 */
export default function GuestRoute({ children }) {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace state={{ from: location.pathname }} />;
  }
  return children;
}
