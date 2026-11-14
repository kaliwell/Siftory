import { app } from 'electron'

// The helper must branch before importing main.ts: that module acquires the
// single-instance lock, resolves user storage and installs application services.
const helperRequested = process.argv.some((arg) => arg.startsWith('--siftory-shell-preview='))
if (helperRequested) {
  void import('./projectPreviewShellChild')
    .then(({ startShellPreviewChild }) => startShellPreviewChild())
    .catch((error) => {
      console.error('[ShellPreview] Helper startup failed', error)
      app.exit(1)
    })
} else {
  void import('./main').catch((error) => {
    console.error('[Startup] Application startup failed', error)
    app.exit(1)
  })
}
