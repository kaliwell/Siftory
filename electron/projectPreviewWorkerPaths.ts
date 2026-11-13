import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'

export function projectPreviewWorkerPaths() {
  const resource = process.resourcesPath || ''
  const resolve = (source: string, built: string) => {
    const local = path.join(__dirname, source)
    const bundled = path.join(__dirname, built)
    return fs.existsSync(local)
      ? local
      : fs.existsSync(bundled)
        ? bundled
        : path.join(resource, built)
  }
  return {
    workerPath: resolve('projectPreviewImageWorker.cjs', 'projectPreviewImageWorker.js'),
    childPath: resolve('projectPreviewPdfChild.cjs', 'projectPreviewPdfChild.js'),
    workerData: {
      sharpPath: require.resolve('sharp'),
      moduleRoots: require.resolve.paths('@napi-rs/canvas'),
      pdfModuleUrl: pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href,
      providersPath: resolve('projectPreviewProviders.ts', 'projectPreviewProvidersWorker.js'),
    },
  }
}
