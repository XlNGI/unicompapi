import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  define: {
    // Production builds use the guarded Thread-first renderer by default.
    // VITE_UNICOMP_THREAD_FIRST=0 remains an explicit rollback build switch.
    'import.meta.env.VITE_UNICOMP_THREAD_FIRST': JSON.stringify(process.env.VITE_UNICOMP_THREAD_FIRST ?? '1')
  },
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
