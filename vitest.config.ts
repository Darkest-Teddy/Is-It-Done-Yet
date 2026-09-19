import { defineConfig } from 'vitest/config';

// Deliberately separate from `vite.config.ts`: vitest would otherwise load the IWSDK dev plugin
// (emulator injection, headless browser, scene validation) just to run headless unit tests.
export default defineConfig({});
