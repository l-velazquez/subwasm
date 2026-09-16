import { defineConfig } from 'vite';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  // Keep FFmpeg's worker import visible to Vite instead of collapsing the
  // package into an optimized dependency whose relative worker URL is lost.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
