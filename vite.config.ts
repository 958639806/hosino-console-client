import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    proxy: { '/mock-api': { target: 'http://127.0.0.1:4174', rewrite: path => path.replace(/^\/mock-api/, '') } },
  },
  build: { target: 'es2022' },
});
