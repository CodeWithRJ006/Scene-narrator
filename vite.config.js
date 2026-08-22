import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ command }) => {
  return {
    // Only use local SSL when running dev server, NOT during production build
    plugins: command === 'serve' ? [basicSsl()] : [],
    server: {
      host: true,
      port: 5173
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 1000
    }
  };
});
