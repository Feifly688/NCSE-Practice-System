import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { message } from 'antd';
import api, { AUTH_EXPIRED_EVENT } from '../services/api';
import { fetchSessionPolicy, getTokenExpiry } from '../services/session';
import {
  getToken, getUser as readUser, setSession, updateUser, clearSession, isPersistent,
} from '../services/authStorage';

const AuthContext = createContext(null);

/** 会话策略（长/短有效期）兜底值：仅在后端策略接口不可用时使用 */
const FALLBACK_POLICY = {
  long: { expiresIn: '7d', ms: 7 * 24 * 3600 * 1000, label: '7 天' },
  short: { expiresIn: '2h', ms: 2 * 3600 * 1000, label: '2 小时' },
};

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => readUser());
  const [loading, setLoading] = useState(false);
  // 登录/注册弹窗状态：null 表示关闭，'login' / 'register' 表示当前标签页
  const [authModal, setAuthModal] = useState(null);
  // 会话有效期策略，由后端下发，避免前端硬编码文案与运维配置脱节
  const [sessionPolicy, setSessionPolicy] = useState(null);
  // 是否为持久化会话（登录时勾选了「记住我」），用于界面提示
  const [persistent, setPersistent] = useState(() => isPersistent());
  const userRef = useRef(user);
  userRef.current = user;

  const isAuthenticated = !!user;
  const isAdmin = user?.role === 'admin';

  function openAuth(mode = 'login') {
    setAuthModal(mode);
  }

  function closeAuth() {
    setAuthModal(null);
  }

  // 拉取会话有效期策略（失败时回退到默认文案，不阻塞登录）
  useEffect(() => {
    let alive = true;
    fetchSessionPolicy(api).then((policy) => {
      if (alive) setSessionPolicy(policy);
    });
    return () => { alive = false; };
  }, []);

  // 监听 token 失效事件：清理本地状态并提示用户重新登录
  // （axios 拦截器无法直接改 React 状态，通过 DOM 事件桥接）
  useEffect(() => {
    const handleExpired = () => {
      clearSession();
      setUser(null);
      setPersistent(false);
      message.warning('登录状态已失效，请重新登录');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, handleExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleExpired);
  }, []);

  // 验证 token 是否仍然有效
  useEffect(() => {
    const token = getToken();
    if (token && userRef.current) {
      api.get('/auth/me').catch(() => {
        // token 无效时拦截器会派发失效事件并清理存储；
        // 这里兜底处理网络错误等非 401 场景
        clearSession();
        setUser(null);
        setPersistent(false);
      });
    }
  }, []);

  /**
   * 登录。remember 同时决定两件事，二者必须一致才能形成闭环：
   *   - 服务端签发的 token 有效期（前端传参）
   *   - 浏览器存储位置（勾选 → localStorage；未勾选 → sessionStorage）
   */
  const login = useCallback(async (account, password, remember = true) => {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/login', { account, password, remember });
      setSession({ token: data.token, user: data.user }, remember);
      setUser(data.user);
      setPersistent(!!remember);
      return data;
    } finally { setLoading(false); }
  }, []);

  const register = useCallback(async (values, remember = true) => {
    setLoading(true);
    try {
      const { data } = await api.post('/auth/register', { ...values, remember });
      setSession({ token: data.token, user: data.user }, remember);
      setUser(data.user);
      setPersistent(!!remember);
      return data;
    } finally { setLoading(false); }
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
    setPersistent(false);
  }, []);

  /** 资料更新后同步落盘，保持原有存储位置不变 */
  const persistUser = useCallback((next) => {
    updateUser(next);
    setUser(next);
  }, []);

  return (
    <AuthContext.Provider value={{
      user, setUser: persistUser, loading, isAuthenticated, isAdmin,
      login, register, logout,
      authModal, openAuth, closeAuth,
      sessionPolicy: sessionPolicy || FALLBACK_POLICY,
      tokenExpiry: getTokenExpiry(getToken()),
      isPersistentSession: persistent,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
