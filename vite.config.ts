import { defineConfig } from 'vite';

export default defineConfig({
  // 0.0.0.0 so a phone or the Beam Pro on the same LAN can open it; the CV all runs locally.
  server: { host: '0.0.0.0', port: 8081, open: false },
  build: { outDir: 'dist', sourcemap: true, target: 'esnext' },
  esbuild: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  base: './',
});
