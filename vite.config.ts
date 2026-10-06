import { defineConfig } from 'vite';

// Relative asset paths so the build works from any subpath (e.g. GitHub Pages /sim/).
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
