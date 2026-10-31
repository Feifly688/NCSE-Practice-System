import axios from 'axios';
import { clearSession, getUser } from './authStorage';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  timeout: 30000, // 普通请求 30 秒超时
  // 凭据走服务端下发的 httpOnly Cookie：浏览器自动带上，JS 读不到，XSS 偷不走。
  // 跨站部署（前后端不同域）时必须开启，否则 Cookie 不会随请求发出。
  withCredentials: true,
});

// token 过期事件：拦截器无法直接操作 React 状态，通过 DOM 事件通知 AuthContext
export const AUTH_EXPIRED_EVENT = 'ncse:auth-expired';

// request interceptor: 预留扩展点（当前凭据由 Cookie 自动携带，无需手动加头）
api.interceptors.request.use((config) => config);

// response interceptor: handle 401/403
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response) {
      const { status } = err.response;
      if (status === 401) {
        // 区分「从未登录」与「登录态失效」：
        // 前者静默清理（访客浏览），后者派发事件提示用户重新登录。
        const hadSession = !!getUser();
        clearSession();
        if (hadSession) {
          window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
        }
      }
      // 403 不再跳转登录，由调用方处理（通常会显示错误消息）
    }
    return Promise.reject(err);
  }
);

export default api;
