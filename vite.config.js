import { defineConfig } from 'vite';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// GitHub Pages serves this project below /subwasm/. Keep local development at
// the site root while making the production asset URLs work at that path.
const base = process.env.VITE_BASE_PATH || (process.env.GITHUB_ACTIONS ? '/subwasm/' : '/');

export default defineConfig({
  base,
  // Keep FFmpeg's worker import visible to Vite instead of collapsing the
  // package into an optimized dependency whose relative worker URL is lost.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  server: { headers: isolationHeaders },
  preview: { headers: isolationHeaders },
});
