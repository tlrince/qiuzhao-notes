import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __APP_TARGET__: JSON.stringify(mode === 'desktop' ? 'macos' : 'web'),
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
  build: { outDir: 'web-dist' },
  server: { strictPort: true },
}));
