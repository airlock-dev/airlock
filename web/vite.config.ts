import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'url';

const backend = process.env.AIRLOCK_WEB_BACKEND ?? 'http://127.0.0.1:4177';
const proxied = [
  '/api',
  '/events',
  '/approve',
  '/deny',
  '/version',
  '/approval-preview',
  '/classic',
];

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [preact()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
  server: {
    proxy: Object.fromEntries(
      proxied.map((path) => [path, { target: backend, changeOrigin: true }])
    ),
  },
});
