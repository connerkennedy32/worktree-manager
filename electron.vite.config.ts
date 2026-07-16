import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    build: { rollupOptions: { external: ['node-pty', 'simple-git', 'chokidar'] } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs' } } },
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
