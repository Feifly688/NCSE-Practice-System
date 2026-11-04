import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * 日夜模式（参照粉笔的配色）。
 *
 * 粉笔的深色配色实测（styles-*.css 的 dark 段）：
 *   页面底 #1b1d26 / 卡片底 #23252f / 正文 #e8e9ed / 次要 #9a9eab
 *   主色在深色下提亮为 #5b8cff，选中底 rgba(91,140,255,.16)
 *
 * 三种模式：light（强制日间）/ dark（强制夜间）/ system（跟随系统）
 */

const STORAGE_KEY = 'ncse_theme';

export const THEMES = {
  light: {
    name: 'light',
    isDark: false,
    // 页面层级
    pageBg: '#f7f9fc',
    cardBg: '#ffffff',
    cardBgAlt: '#f2f5fb',
    // 文字
    text: '#292a2d',
    textSub: '#3c464f',
    textWeak: '#868ea8',
    textInverse: '#ffffff',
    // 品牌色
    primary: '#385dca',
    primaryLight: '#3c7cfc',
    selectedBg: '#edf6ff',
    selectedBorder: '#cbdfff',
    // 描边
    border: '#e8ecf3',
    cardBorder: '#f0f3fa',
    divider: '#eef1f6',
    // 语义色
    success: '#52c41a',
    warning: '#faad14',
    error: '#ff4d4f',
    accent: '#ffbc22',
    // 遮罩
    mask: 'rgba(0,0,0,0.45)',
    shadow: '0 12px 30px rgba(15, 23, 42, 0.06)',
  },
  dark: {
    name: 'dark',
    isDark: true,
    pageBg: '#1b1d26',
    cardBg: '#23252f',
    cardBgAlt: '#2b2e3a',
    text: '#e8e9ed',
    textSub: '#c3c6d0',
    textWeak: '#9a9eab',
    textInverse: '#1b1d26',
    primary: '#5b8cff',
    primaryLight: '#7aa2ff',
    selectedBg: 'rgba(91,140,255,0.16)',
    selectedBorder: 'rgba(91,140,255,0.42)',
    border: '#333644',
    cardBorder: '#383b49',
    divider: '#2f3240',
    success: '#5ec46a',
    warning: '#e8b339',
    error: '#f06a6a',
    accent: '#ffbc22',
    mask: 'rgba(0,0,0,0.62)',
    shadow: '0 12px 30px rgba(0,0,0,0.36)',
  },
};

const ThemeContext = createContext(null);

function readStoredTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch (e) { /* 隐私模式可能禁写 */ }
  return null; // null = 用户从未主动选过，此时可采纳服务端偏好
}

function isLogin() {
  try { return !!localStorage.getItem('user'); } catch (e) { return false; }
}

function systemPrefersDark() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }) {
  // readStoredTheme 返回 null 表示用户没选过 —— 先按 system，等登录后采纳服务端偏好
  const [mode, setModeState] = useState(() => readStoredTheme() || 'system');
  const [systemDark, setSystemDark] = useState(systemPrefersDark);
  // 只有答题界面（/practice/do、/exam-papers/:id）会打开这个开关；
  // 其余页面恒定日间 —— 日夜模式不再全局生效。
  const [answerScope, setAnswerScope] = useState(false);

  // ① 登录状态下拉取服务端主题偏好：本机没主动选过才采纳（本机选择优先）
  useEffect(() => {
    if (readStoredTheme() || !isLogin()) return undefined;
    let cancelled = false;
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const t = j && j.user && j.user.theme;
        if (!cancelled && (t === 'light' || t === 'dark' || t === 'system')) {
          setModeState(t);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // ② 跟随系统时监听系统主题变化
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e) => setSystemDark(e.matches);
    if (mq.addEventListener) {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  // 非答题界面一律日间；答题界面才应用用户选择的主题
  const effective = answerScope ? resolved : 'light';

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (e) { /* 忽略 */ }
    const t = THEMES[effective];
    if (answerScope) {
      document.documentElement.setAttribute('data-theme', effective);
      document.body.style.backgroundColor = t.pageBg;
      document.body.style.color = t.text;
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      document.body.style.backgroundColor = '#f7f9fc';
      document.body.style.color = '#292a2d';
    }
    document.documentElement.style.colorScheme = effective;
  }, [mode, effective, answerScope]);

  /** 切主题：写本机 + 登录状态下静默上报服务端（换设备也生效） */
  const setMode = (next) => {
    setModeState(next);
    if (isLogin()) {
      fetch('/api/auth/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ mode: next }),
      }).catch(() => {});
    }
  };

  const value = useMemo(() => ({
    mode,
    resolved,
    isDark: effective === 'dark',
    tokens: THEMES[effective],
    setMode,
    setAnswerScope,
    toggle: () => setMode(resolved === 'dark' ? 'light' : 'dark'),
  }), [mode, resolved, effective]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return ctx;
}

export default ThemeContext;
