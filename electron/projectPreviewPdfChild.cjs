'use strict'
// The native Canvas allocations live in this process, not in Electron's host.
const { Worker } = require('node:worker_threads')
let worker
let memoryTimer
let busy = false
process.on('message', ({ workerPath, workerData, input }) => {
  if (busy) return process.exit(1)
  busy = true
  if (!worker) {
    worker = new Worker(workerPath, { workerData })
    worker.on('message', (message) => {
      clearInterval(memoryTimer)
      busy = false
      if (process.connected) process.send({ kind: 'result', ...message })
      else process.exit(0)
    })
    worker.once('error', () => process.exit(1))
    worker.once('exit', () => process.exit(1))
  }
  const reportMemory = () => {
    process.send?.({ kind: 'memory', rss: process.memoryUsage().rss })
  }
  reportMemory()
  memoryTimer = setInterval(reportMemory, 100)
  worker.postMessage(input)
})
process.on('disconnect', () => process.exit(0))
