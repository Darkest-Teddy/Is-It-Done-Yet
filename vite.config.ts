import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

/**
 * Two ways to reach this from a headset, and they want opposite transport settings.
 *
 * OVER LAN (default): `getUserMedia` needs a secure context and a LAN IP does not get
 * `localhost`'s exemption, so HTTPS is required. The cert is self-signed, so the Quest browser
 * shows an interstitial that must be accepted by hand every time the origin is new -- browser
 * automation cannot dismiss it. Without HTTPS the camera list silently comes back empty and
 * reads as "no cameras" rather than "insecure origin". See DECISIONS.md #11.
 *
 * OVER USB (`npm run dev:usb`): with `adb reverse tcp:8081 tcp:8081` the headset reaches this
 * as `http://localhost:8081`, which IS a secure context on plain HTTP. HTTPS there would only
 * add a cert warning for nothing, so it is turned off.
 */
const useHttps = process.env['VITE_HTTPS'] !== '0';

export default defineConfig({
  plugins: useHttps ? [basicSsl()] : [],

  // 0.0.0.0 so the headset on the same LAN can open it; the CV all runs locally.
  server: { host: '0.0.0.0', port: 8081, open: false },
  build: { outDir: 'dist', sourcemap: true, target: 'esnext' },
  esbuild: { target: 'esnext' },
  optimizeDeps: {
    esbuildOptions: { target: 'esnext' },
    // Load-bearing, do not remove. Without it the Havok .wasm request falls through to the SPA
    // HTML fallback, so WebAssembly.instantiate receives `<!do` instead of the wasm magic
    // number. The resulting promise never resolves AND never rejects: World.create hangs
    // forever and the app is a blank canvas with an empty console. See DECISIONS.md #11.
    exclude: ['@babylonjs/havok'],
  },
  base: './',
});
