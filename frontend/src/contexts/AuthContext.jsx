import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import api from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('user');
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  const [loading, setLoading] = useState(false);
  const userRef = useRef(user);
  userRef.current = user;

  const isAuthenticated = !!user;
  const isAdmin = user?.role === 'admin';

  // 验证 token 是否仍然有效
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token && userRef.current) {
      api.get('/auth/me').catch(() => {
        // token 无效时 api.js 的 interceptor 会处理 401 跳转
        // 如果没跳转（如网络错误），清除本地状态
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setUser(null);
      });
    }
  }, []);

  async function login(email, password) {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email, password });
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      setUser(data.user);
      return data;
    } finally { setLoading(false); }
  }

  async function register(email, password, nickname) {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/register', { email, password, nickname });
      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));
      setUser(data.user);
      return data;
    } finally { setLoading(false); }
  }

  function logout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, setUser, loading, isAuthenticated, isAdmin, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
