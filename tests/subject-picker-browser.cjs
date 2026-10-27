// Actual application styles and picker; model responses and source image are synthetic.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

async function run() {
  const root = path.resolve(__dirname, '..')
  const { createServer } = await import('vite')
  const { default: react } = await import('@vitejs/plugin-react')
  const server = await createServer({
    configFile: false,
    root,
    plugins: [react()],
    optimizeDeps: { entries: ['tests/fixtures/workspace-ui.html'] },
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
  })
  const evidence =
    process.env.SIFTORY_UI_SCREENSHOT_DIR || path.join(root, 'artifacts/subject-picker')
  fs.mkdirSync(evidence, { recursive: true })
  let browser
  const errors = []
  try {
    await server.listen()
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: process.platform === 'win32',
      args:
        process.platform === 'linux'
          ? [
              '--no-sandbox',
              '--no-zygote',
              '--single-process',
              '--disable-dev-shm-usage',
              '--use-gl=angle',
              '--use-angle=swiftshader',
            ]
          : [],
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
    })
    const page = await browser.newPage({ viewport: { width: 1320, height: 850 } })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    await page.getByTestId('image-search-query-section').waitFor()
    await page.evaluate(() => {
      const fixture = window.__workspaceTest
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1000
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#d7bb93'
      ctx.fillRect(0, 0, 1000, 1000)
      ctx.fillStyle = '#274b65'
      ctx.fillRect(180, 120, 640, 740)
      ctx.fillStyle = '#b8d4e4'
      ctx.fillRect(200, 150, 600, 630)
      ctx.fillStyle = '#f8f5ee'
      ctx.font = '48px sans-serif'
      ctx.fillText('Subject selection test', 240, 400)
      const image = canvas.toDataURL('image/png')
      ctx.fillStyle = 'black'
      ctx.fillRect(0, 0, 1000, 1000)
      ctx.fillStyle = 'white'
      ctx.fillRect(180, 120, 640, 740)
      const mask = canvas.toDataURL('image/png')
      fixture.setHandler('sam.preview', () => ({ ok: true, dataUrl: image }))
      fixture.setHandler('subject.search', () => ({
        ok: true,
        subjectLabel: 'phone',
        results: [{ imagePath: 'C:/fixtures/original.jpg', imageId: 'original', score: 0.99 }],
      }))
      fixture.setHandler('sam.status', () => ({ ready: true }))
      fixture.setHandler('subject.detect', () => ({
        ok: true,
        width: 1000,
        height: 1000,
        subjects: [
          { x: 180, y: 120, w: 640, h: 740, confidence: 0.9, label: 'phone' },
          { x: 100, y: 920, w: 800, h: 10, confidence: 0.8, label: 'thin-detail' },
        ],
      }))
      fixture.setHandler('sam.segment', () => ({
        ok: true,
        bbox: { x: 180, y: 120, w: 640, h: 740 },
        maskPngDataUrl: mask,
        segmentationSessionId: 'synthetic-mask-session',
        iou: 0.95,
      }))
    })
    await page.getByTestId('image-search-query-image').click()
    await page
      .locator('.image-search-results-pane')
      .getByRole('button', { name: '\u4e3b\u4f53', exact: true })
      .first()
      .waitFor()
    const open = async () => {
      await page.getByTestId('image-search-query-image').waitFor({ state: 'visible' })
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="image-search-query-image"]').disabled,
      )
      await page
        .locator('.image-search-results-pane')
        .getByRole('button', { name: '\u4e3b\u4f53', exact: true })
        .first()
        .click()
    }
    const picker = page.locator('.subject-picker-modal')
    for (const mode of ['dark', 'light']) {
      await page.evaluate(
        (value) => window.__workspaceTest.store.getState().setThemeMode(value),
        mode,
      )
      for (const width of [1320, 760]) {
        await page.setViewportSize({ width, height: 850 })
        await open()
        await picker.locator('.subject-picker-stage > img').waitFor()
        await page.evaluate(() => document.fonts.ready)
        const box = picker.locator('.subject-picker-box').first()
        await page.mouse.move(0, 0)
        await page.screenshot({ path: path.join(evidence, `subject-${mode}-${width}.png`) })
        const style = await box.evaluate((element) => {
          const css = getComputedStyle(element)
          return { background: css.backgroundColor, padding: css.padding, minHeight: css.minHeight }
        })
        assert.equal(
          style.background,
          'rgba(80, 200, 255, 0.12)',
          'detection must not become an opaque button',
        )
        assert.equal(style.padding, '0px')
        assert.equal(style.minHeight, '0px')
        const stage = await picker.locator('.subject-picker-stage').boundingBox()
        const thin = await picker.locator('.subject-picker-box').nth(1).boundingBox()
        assert.ok(
          Math.abs(thin.height - stage.height * 0.01) < 1,
          'small boxes must not grow to button height',
        )
        await box.hover()
        await page.waitForFunction(
          () =>
            getComputedStyle(document.querySelector('.subject-picker-box')).backgroundColor ===
            'rgba(80, 200, 255, 0.3)',
        )
        assert.equal(
          await box.evaluate((element) => getComputedStyle(element).backgroundColor),
          'rgba(80, 200, 255, 0.3)',
        )
        await box.click()
        await picker.waitFor({ state: 'detached' })
        await page.getByTestId('image-search-toast').filter({ hasText: 'phone' }).waitFor()
      }
    }
    await page.setViewportSize({ width: 1320, height: 850 })
    await page.evaluate(() => window.__workspaceTest.store.getState().setThemeMode('dark'))
    await open()
    await picker.getByRole('button', { name: '框选', exact: true }).click()
    const stage = await picker.locator('.subject-picker-stage').boundingBox()
    await page.mouse.move(stage.x + stage.width * 0.2, stage.y + stage.height * 0.15)
    await page.mouse.down()
    await page.mouse.move(stage.x + stage.width * 0.8, stage.y + stage.height * 0.85, { steps: 6 })
    await page.mouse.up()
    await picker.getByRole('button', { name: /IoU/ }).waitFor()
    const prompts = await page.evaluate(
      () =>
        window.__workspaceTest.calls.filter((call) => call.method === 'sam.segment').at(-1).args[1],
    )
    assert.equal(prompts[0].label, 2)
    assert.equal(prompts[1].label, 3)
    assert.ok(Math.abs(prompts[0].x - 200) <= 2 && Math.abs(prompts[0].y - 150) <= 2)
    assert.ok(Math.abs(prompts[1].x - 800) <= 2 && Math.abs(prompts[1].y - 850) <= 2)
    assert.equal(await picker.locator('.subject-picker-box').count(), 0)
    const overlay = picker.locator('[style*="mask-image"]')
    assert.equal(
      await overlay.evaluate((element) => getComputedStyle(element).maskMode),
      'luminance',
    )
    await page.screenshot({ path: path.join(evidence, 'subject-mask.png') })
    await picker.getByRole('button', { name: '撤销', exact: true }).click()
    assert.equal(await overlay.count(), 0)
    await picker.getByRole('button', { name: '重做', exact: true }).click()
    await picker.getByRole('button', { name: /IoU/ }).waitFor()
    await picker.getByRole('button', { name: /IoU/ }).click()
    await picker.waitFor({ state: 'detached' })
    await page.waitForFunction(() =>
      window.__workspaceTest.calls.some(
        (call) => call.method === 'subject.search' && call.args[3] === 'synthetic-mask-session',
      ),
    )
    assert.deepEqual(errors, [])
    const report = {
      passed: true,
      themes: 2,
      widths: [1320, 760],
      detectionClick: true,
      scaledBoxPrompts: true,
      maskUndoRedo: true,
      maskSearchSession: true,
      pageErrors: errors,
    }
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally {
    await browser?.close()
    await server.close()
  }
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
