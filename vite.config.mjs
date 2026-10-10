import { fileURLToPath } from 'node:url'
import { basename, dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { bundleProvenance } from './scripts/bundle-provenance.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ELECTRON_DEVELOPMENT_ARGS = ['.']
const RENDERER_VENDOR_PACKAGES = new Set([
  'react',
  'react-dom',
  'scheduler',
  'use-sync-external-store',
  'zustand',
])

function rendererManualChunks(moduleId) {
  const normalizedId = moduleId.replaceAll('\\', '/')
  const nodeModulesMarker = '/node_modules/'
  const markerIndex = normalizedId.lastIndexOf(nodeModulesMarker)
  if (markerIndex < 0) return undefined
  const packagePath = normalizedId.slice(markerIndex + nodeModulesMarker.length)
  const segments = packagePath.split('/')
  const packageName = segments[0]?.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0]
  return packageName && RENDERER_VENDOR_PACKAGES.has(packageName) ? 'react-vendor' : undefined
}

function startElectronDevelopment({ startup }) {
  void startup(ELECTRON_DEVELOPMENT_ARGS, {
    env: { ...process.env, FLOATING_CLOCK_REQUIRE_SANDBOX: '1' },
  })
}

function withSecureElectronStartup(entries) {
  return entries.map((entry) => ({
    ...entry,
    onstart: startElectronDevelopment,
    vite: {
      ...entry.vite,
      plugins: [
        ...(entry.vite?.plugins || []),
        bundleProvenance({
          rootDir: __dirname,
          buildId: `electron-${basename(entry.entry, '.ts')}`,
        }),
      ],
    },
  }))
}

export function termsDevelopmentCsp() {
  // Vite uses this same nonce for its React refresh preamble, injected scripts,
  // and dynamic CSS through meta[property=csp-nonce]. Packaged HTML stays strict.
  const nonce = randomBytes(32).toString('base64')
  return {
    name: 'siftory-terms-development-csp',
    apply: 'serve',
    config: () => ({ html: { cspNonce: nonce } }),
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        if (resolve(context.filename) !== resolve(__dirname, 'terms.html')) return
        return html
          .replace("script-src 'self';", `script-src 'self' 'nonce-${nonce}';`)
          .replace("style-src 'self';", `style-src 'self' 'nonce-${nonce}';`)
      },
    },
  }
}

export default defineConfig({
  server: {
    host: '127.0.0.1',
    watch: {
      ignored: [
        '**/release/**',
        '**/dist/**',
        '**/dist-electron/**',
        '**/node_modules/**',
        '**/backup/**',
        '**/cppbackup/**',
        '**/.venv-parity/**',
      ],
    },
  },
  build: {
    manifest: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        mediaPlayer: resolve(__dirname, 'media-player.html'),
        terms: resolve(__dirname, 'terms.html'),
      },
      external: [],
      output: {
        manualChunks: rendererManualChunks,
      },
    },
  },
  plugins: [
    bundleProvenance({ rootDir: __dirname, buildId: 'renderer' }),
    termsDevelopmentCsp(),
    react(),
    electron(
      withSecureElectronStartup([
        {
          entry: 'electron/main.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              // Must stay false: dev-mode entry builds race, and the main
              // bundle finishes last — emptying the outDir here deletes
              // preload.js and the worker bundles after they were written.
              emptyOutDir: false,
              rollupOptions: {
                external: [
                  'electron',
                  'ssh2',
                  'cpu-features',
                  'nan',
                  '@huggingface/transformers',
                  '@napi-rs/canvas',
                  'pdfjs-dist/legacy/build/pdf.mjs',
                  'sharp',
                  'onnxruntime-node',
                ],
              },
            },
          },
        },
        {
          entry: 'electron/preload.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                external: ['electron'],
              },
            },
          },
        },
        {
          entry: 'electron/endUserTermsPreload.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: { external: ['electron'] },
            },
          },
        },
        {
          entry: 'electron/mediaPlayerPreload.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                external: ['electron'],
                output: {
                  entryFileNames: 'mediaPlayerPreload.js',
                },
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
          entry: 'electron/duplicateFinderWorker.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'duplicateFinderWorker.js',
                },
              },
            },
          },
        },
        {
          entry: 'electron/assetSimilarSearchWorker.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'assetSimilarSearchWorker.js',
                },
              },
            },
          },
        },
        {
          entry: 'electron/assetSuggestionScanWorker.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'assetSuggestionScanWorker.js',
                },
              },
            },
          },
        },
        {
          entry: 'electron/assetClusteringWorker.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'assetClusteringWorker.js',
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
        {
          entry: 'electron/vectorAnnWorker.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'vectorAnnWorker.js',
                },
              },
            },
          },
        },
        {
          entry: 'electron/semanticVectorSearchWorker.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'semanticVectorSearchWorker.js',
                },
              },
            },
          },
        },
        {
          entry: 'electron/vectorGenerationRecallWorker.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'vectorGenerationRecallWorker.js',
                },
              },
            },
          },
        },
        {
          entry: 'electron/imageSearchDataCatalogWorker.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'imageSearchDataCatalogWorker.js',
                },
                external: ['node:sqlite'],
              },
            },
          },
        },
        {
          entry: 'electron/clipEmbeddingChild.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'clipEmbeddingChild.js',
                  // This child is also copied alone into packaged resources.
                  inlineDynamicImports: true,
                },
                external: [
                  'fs',
                  'path',
                  'readline',
                  '@huggingface/transformers',
                  'onnxruntime-node',
                ],
              },
            },
          },
        },
        {
          entry: 'electron/dinoEmbeddingChild.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'dinoEmbeddingChild.js',
                  // Keep lazy dependencies inside the independently copied child.
                  inlineDynamicImports: true,
                },
                external: [
                  'fs',
                  'path',
                  'readline',
                  '@huggingface/transformers',
                  'onnxruntime-node',
                ],
              },
            },
          },
        },
        {
          entry: 'electron/embeddingPreparationChild.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'embeddingPreparationChild.js',
                },
                external: ['fs', 'path', 'readline'],
              },
            },
          },
        },
        {
          entry: 'electron/userModelRuntimeChild.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'userModelRuntimeChild.js',
                },
                external: ['fs', 'onnxruntime-node'],
              },
            },
          },
        },
        {
          entry: 'electron/audioSemanticBuildChild.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              emptyOutDir: false,
              rollupOptions: {
                output: {
                  entryFileNames: 'audioSemanticBuildChild.js',
                },
                external: ['fs', 'path', 'readline', 'child_process'],
              },
            },
          },
        },
      ]),
    ),
    renderer(),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
})
