import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Windows may lock Chromium/Electron profile files such as Cookies.
      // Watching them crashes Vite with EBUSY and takes down `npm run dev`.
      ignored: [
        '**/.cache/**',
        '**/.tools/**',
        '**/.workbuddy/**',
        '**/chrome-profile/**',
        '**/chrome-profile-*/**',
        '**/dist-electron/**',
        '**/files/**',
        '**/outputs/**',
        '**/tmp/**',
        '**/temp/**'
      ]
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
