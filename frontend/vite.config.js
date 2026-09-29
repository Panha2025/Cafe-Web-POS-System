import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Vite uses BROWSER when opening its ready development URL.
// BROWSER=none disables automatic opening for unattended development.
if (!process.env.BROWSER) {
  if (process.platform === 'win32') {
    const chrome = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ]
      .filter(Boolean)
      .map((directory) => join(directory, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      .find(existsSync);
    process.env.BROWSER = chrome || 'none';
    if (!chrome) console.warn('Chrome was not found. Open http://127.0.0.1:5173 manually.');
  } else {
    process.env.BROWSER = process.platform === 'darwin' ? 'google chrome' : 'google-chrome';
  }
}

export default defineConfig({
  envDir: '..',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'service-worker.js',
      registerType: 'prompt',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,jpg,jpeg,webp}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  server: {
    port: 5173,
    strictPort: true,
    open: process.env.BROWSER !== 'none',
    proxy: { '/api': 'http://127.0.0.1:4000', '/uploads': 'http://127.0.0.1:4000' },
  },
});
