import { useEffect, useState } from 'react';

// 断点与 antd Grid 保持一致
export const BREAKPOINTS = {
  xs: 480,    // 手机竖屏
  sm: 576,    // 手机横屏 / 小平板
  md: 768,    // 平板
  lg: 992,    // 小笔记本
  xl: 1200,   // 桌面
  xxl: 1600,  // 大屏
};

function getWidth() {
  return typeof window === 'undefined' ? BREAKPOINTS.xl : window.innerWidth;
}

function match(width) {
  return {
    isMobile: width < BREAKPOINTS.md,      // < 768 手机
    isTablet: width >= BREAKPOINTS.md && width < BREAKPOINTS.lg,
    isDesktop: width >= BREAKPOINTS.lg,
    isSmall: width < BREAKPOINTS.sm,       // < 576 超小屏
    width,
  };
}

/**
 * 响应式断点 hook。窗口尺寸变化时自动更新。
 * 用法: const { isMobile, isTablet, isDesktop } = useResponsive();
 */
export function useResponsive() {
  const [state, setState] = useState(() => match(getWidth()));

  useEffect(() => {
    let frame = null;
    const onResize = () => {
      // 用 rAF 节流，避免滚动时频繁重渲染
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = match(getWidth());
        setState((prev) => (prev.width === next.width ? prev : next));
      });
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return state;
}
