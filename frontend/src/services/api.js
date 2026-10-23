import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 30000, // 普通请求 30 秒超时
});

// token 过期事件：拦截器无法直接操作 React 状态，通过 DOM 事件通知 AuthContext
export const AUTH_EXPIRED_EVENT = 'ncse:auth-expired';

// request interceptor: attach token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// response interceptor: handle 401/403
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response) {
      const { status } = err.response;
      if (status === 401) {
        // 区分「从未登录」与「登录态失效」：
        // 前者静默清理（访客浏览），后者派发事件提示用户重新登录。
        const hadToken = !!localStorage.getItem('token');
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        if (hadToken) {
          window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
        }
      }
      // 403 不再跳转登录，由调用方处理（通常会显示错误消息）
    }
    return Promise.reject(err);
  }
);

export default api;
