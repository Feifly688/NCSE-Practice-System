import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000'
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // 分包：只拆 react 体系，其余交给 rollup 自动分割。
    // 注意不要手动指定 antd（对象式或函数式按路径分组都试过）：强制分组会
    // 阻碍 Rollup 跨 chunk 的 tree-shaking，实测 antd 块从 784 kB 涨到
    // 1071 kB、总体积增加约 450 kB，反而更差。首页重组件改用组件级 lazy。
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
    minify: 'esbuild',
    esbuild: {
      drop: ['console', 'debugger'],
    },
    chunkSizeWarningLimit: 700,
  },
});
