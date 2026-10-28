import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Pages のサブパス配信(kaozure.github.io/リポジトリ名/)でも動くよう相対パスで出力する
  base: './',
});
