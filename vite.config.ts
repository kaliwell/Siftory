import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import path from 'path'

export default defineConfig({
  // Prevent Vite from scanning release/build artifacts
  server: {
    watch: {
      ignored: [
        '**/release/**',
        '**/dist/**',
        '**/dist-electron/**',
        '**/node_modules/**',
        '**/backup/**',
        '**/cppbackup/**',
      ],
    },
  },
  build: {
    rollupOptions: {
      // Exclude release artifacts from build scanning
      external: [],
    },
  },
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(args) {
          args.reload()
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      {
        entry: 'electron/thumbnailGpuPreload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            rollupOptions: {
              external: ['electron'],
              output: {
                entryFileNames: 'thumbnailGpuPreload.js',
              },
            },
          },
        },
      },
      {
        entry: 'electron/assetCategoryFeedbackWorker.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            emptyOutDir: false,
            rollupOptions: {
              output: {
                entryFileNames: 'assetCategoryFeedbackWorker.js',
              },
            },
          },
        },
      },
    ]),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
