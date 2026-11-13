import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import { pathToFileURL } from 'url'

// One bounded execution lane: do not create a decode thread for every file.
let worker: Worker | undefined
let chain: Promise<unknown> = Promise.resolve()
let idleTimer: ReturnType<typeof setTimeout> | undefined
export function runProjectPreviewCompute(input: unknown): Promise<unknown> {
  const task = chain.then(
    () =>
      new Promise((resolve, reject) => {
        clearTimeout(idleTimer)
        if (!worker) {
          const local = path.join(__dirname, 'projectPreviewImageWorker.cjs')
          const built = path.join(__dirname, 'projectPreviewImageWorker.js')
          worker = new Worker(
            fs.existsSync(local)
              ? local
              : fs.existsSync(built)
                ? built
                : path.join(process.resourcesPath, 'projectPreviewImageWorker.js'),
            {
              workerData: {
                sharpPath: require.resolve('sharp'),
                moduleRoots: require.resolve.paths('@napi-rs/canvas'),
                pdfModuleUrl: pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'))
                  .href,
                providersPath: fs.existsSync(path.join(__dirname, 'projectPreviewProviders.ts'))
                  ? path.join(__dirname, 'projectPreviewProviders.ts')
                  : fs.existsSync(path.join(__dirname, 'projectPreviewProvidersWorker.js'))
                    ? path.join(__dirname, 'projectPreviewProvidersWorker.js')
                    : path.join(process.resourcesPath, 'projectPreviewProvidersWorker.js'),
              },
            },
          )
        }
        const current = worker
        // Keep an error observer while idle; otherwise an idle worker crash can
        // become an uncaught main-process error after per-request cleanup.
        if (current.listenerCount('error') === 0) {
          current.on('error', () => {
            if (worker === current) worker = undefined
          })
          current.on('exit', () => {
            if (worker === current) worker = undefined
          })
        }
        let settled = false
        const finish = (error?: Error, value?: unknown) => {
          if (settled) return
          settled = true
          clearTimeout(timeout)
          current.removeListener('message', onMessage)
          current.removeListener('error', onError)
          current.removeListener('exit', onExit)
          if (error) {
            if (worker === current) worker = undefined
            void current.terminate()
            reject(error)
          } else {
            resolve(value)
            idleTimer = setTimeout(() => {
              if (worker === current) worker = undefined
              void current.terminate()
            }, 15000)
            idleTimer.unref()
            current.unref()
          }
        }
        const onMessage = (message: { error?: string; result?: unknown }) =>
          finish(message.error ? new Error(message.error) : undefined, message.result)
        const onError = (error: Error) => finish(error)
        const onExit = (code: number) =>
          finish(new Error(`Project preview worker exited (${code})`))
        const timeout = setTimeout(
          () => finish(new Error('Project preview compute timeout')),
          120000,
        )
        current.ref()
        current.once('message', onMessage)
        current.once('error', onError)
        current.once('exit', onExit)
        try {
          const manifest = input as { kind?: string; entries?: unknown[]; temporaryPath?: string }
          if (manifest.kind === 'manifest' && Array.isArray(manifest.entries)) {
            void (async () => {
              current.postMessage({ kind: 'manifestStart' })
              for (let offset = 0; offset < manifest.entries!.length; offset += 256) {
                if (settled) return
                current.postMessage({
                  kind: 'manifestChunk',
                  entries: manifest.entries!.slice(offset, offset + 256),
                })
                await new Promise<void>((resolve) => setImmediate(resolve))
              }
              if (!settled)
                current.postMessage({
                  kind: 'manifestFinish',
                  temporaryPath: manifest.temporaryPath,
                })
            })().catch(onError)
          } else current.postMessage(input)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      }),
  )
  chain = task.catch(() => {})
  return task
}
