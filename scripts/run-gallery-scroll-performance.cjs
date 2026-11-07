'use strict'
const fs = require('fs')
const { chromium } = require('playwright')
;(async () => {
  const { createServer } = await import('vite'),
    { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({
    configFile: false,
    root: process.cwd(),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: { ignored: ['**/artifacts/**', '**/release/**', '**/native/**'] },
    },
    logLevel: 'error',
  })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({
      headless: true,
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    })
    const reports = []
    for (const count of [1000, 5000, 10000]) {
      const page = await browser.newPage({ viewport: { width: 1320, height: 850 } })
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(
        `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/performance-gallery.html?count=${count}`,
      )
      await page.locator('.asset-library-card').first().waitFor()
      await page.waitForTimeout(1000)
      const report = await page.evaluate(async () => {
        const grid = document.querySelector('.asset-library-gallery')
        const frames = []
        let last = performance.now(),
          maxDomCards = 0
        for (let i = 0; i < 300; i++) {
          grid.scrollTop = ((grid.scrollHeight - grid.clientHeight) * (i < 150 ? i : 299 - i)) / 149
          await new Promise((r) => requestAnimationFrame(r))
          const now = performance.now()
          frames.push(now - last)
          last = now
          maxDomCards = Math.max(
            maxDomCards,
            document.querySelectorAll('.asset-library-card').length,
          )
        }
        frames.sort((a, b) => a - b)
        return {
          frames: frames.length,
          p95FrameMs: frames[Math.floor(frames.length * 0.95)],
          maxFrameMs: Math.max(...frames),
          meanFrameMs: frames.reduce((a, b) => a + b, 0) / frames.length,
          maxDomCards,
          bridge: window.__galleryPerformance,
        }
      })
      reports.push({ count, errors, ...report })
      await page.close()
      console.log(JSON.stringify(reports.at(-1)))
    }
    fs.writeFileSync(
      'artifacts/performance-gallery-scroll.json',
      JSON.stringify(
        {
          scope:
            'Headless Chrome microbenchmark of production virtual grid and renderer scheduler, synthetic SVG bridge; excludes native IPC/decode/disk/model workloads. Not full product scrolling FPS. Fixed 300-frame traversal per size.',
          reports,
        },
        null,
        2,
      ),
    )
    if (reports.some((r) => r.errors.length || r.maxDomCards > 100)) process.exitCode = 1
  } finally {
    await browser?.close()
    await server.close()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
