import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

function devCspPlugin(): Plugin {
  return {
    name: 'emu8086-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      // Allow Vite React Fast Refresh inline preamble and HMR WebSocket only during local dev server
      return html.replace(
        "script-src 'self';",
        "script-src 'self' 'unsafe-inline';"
      ).replace(
        "connect-src 'self';",
        "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*;"
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), devCspPlugin()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@core': path.resolve(__dirname, 'src/core'),
      '@i18n': path.resolve(__dirname, 'src/i18n'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          docx: ['docx'],
        },
      },
    },
  },
});
