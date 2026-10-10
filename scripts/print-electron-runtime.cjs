const { app } = require('electron')

app.whenReady().then(() => {
  console.log(
    `[electron-runtime]${JSON.stringify({
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    })}`,
  )
  app.quit()
})

app.on('window-all-closed', () => app.quit())
