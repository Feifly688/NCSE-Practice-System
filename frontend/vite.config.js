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
    // 注意不要手动指定 antd —— 那会把整个包打进一个 chunk，
    // 反而阻止 tree-shaking（DatePicker/Transfer/QRCode 等未用组件全被带入）。
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
