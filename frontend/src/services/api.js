import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 30000, // 普通请求 30 秒超时
});

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
        // 未登录或 token 过期 → 跳转登录
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        window.location.href = '/login';
      }
      // 403 不再跳转登录，由调用方处理（通常会显示错误消息）
    }
    return Promise.reject(err);
  }
);

export default api;
