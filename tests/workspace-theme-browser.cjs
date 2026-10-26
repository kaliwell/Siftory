// Real settings controls and computed colors; synthetic settings bridge only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')
const root = path.resolve(__dirname, '..')

async function main() {
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
  await server.listen()
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: process.platform === 'win32',
      ...(process.env.SIFTORY_TEST_CHROMIUM_PATH
        ? { executablePath: process.env.SIFTORY_TEST_CHROMIUM_PATH }
        : {}),
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(
      `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/workspace-ui.html`,
    )
    await page.locator('[data-ready="true"]').waitFor()
    await page.getByTestId('unified-search-query').waitFor()
    await page.getByTestId('workspace-domain-settings').click()
    await page.mouse.move(800, 900)
    await page.addStyleTag({
      content: '*,*::before,*::after{transition:none!important;animation:none!important}',
    })
    await page.locator('#app-theme').waitFor()
    const ids = await page
      .locator('#app-theme option')
      .evaluateAll((options) => options.map((o) => o.value))
    assert.equal(ids.length, 17)
    const checks = []
    for (const id of ids) {
      await page.locator('#app-theme').selectOption(id)
      for (const mode of ['light', 'dark']) {
        await page.getByTestId('theme-mode').selectOption(mode)
        await page.waitForFunction(
          ({ id, mode }) =>
            document.documentElement.dataset.themeId === id &&
            document.documentElement.dataset.effectiveMode === mode,
          { id, mode },
        )
        const result = await page.evaluate(
          async ({ id, mode }) => {
            const { buildThemePalette, themeCssVariables } =
              await import('/src/services/themeCatalog.ts')
            const p = buildThemePalette(id, mode)
            const color = (values) => `rgb(${values.join(', ')})`
            const actual = (selector) => getComputedStyle(document.querySelector(selector))
            return {
              canvas: actual('.focused-workspace').backgroundColor,
              expectedCanvas: color(p.canvas),
              surface: actual('.workspace-sidebar').backgroundColor,
              expectedSurface: color(p.surface),
              accent: actual('.workspace-brand-mark').backgroundColor,
              expectedAccent: color(p.accent),
              selection: actual('.workspace-sidebar button[aria-current="page"]').backgroundColor,
              expectedSelection: color(p.selection),
              primary: actual('.workspace-button-primary').backgroundColor,
              primaryText: actual('.workspace-button-primary').color,
              expectedPrimaryText: `rgb(${themeCssVariables(id, mode)['--color-on-accent']})`,
              selectedText: actual('.workspace-sidebar button[aria-current="page"]').color,
            }
          },
          { id, mode },
        )
        for (const key of ['Canvas', 'Surface', 'Accent', 'Selection']) {
          assert.equal(result[key.toLowerCase()], result['expected' + key], `${id}/${mode} ${key}`)
        }
        assert.equal(result.selectedText, result.expectedAccent)
        assert.equal(result.primary, result.expectedAccent)
        assert.equal(result.primaryText, result.expectedPrimaryText)
        checks.push({ id, mode })
      }
    }
    await page.locator('#app-theme').selectOption('amber-dark')
    await page.getByTestId('theme-mode').selectOption('system')
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme })
      await page.waitForFunction(
        (mode) => document.documentElement.dataset.effectiveMode === mode,
        colorScheme,
      )
    }
    await page.evaluate(async () => {
      const writer = await import('/src/hooks/settingsWriter.ts')
      await writer.flushSettingsWrites()
    })
    await page.reload()
    await page.locator('[data-ready="true"]').waitFor()
    await page.waitForFunction(
      () =>
        document.documentElement.dataset.themeId === 'amber-dark' &&
        document.documentElement.dataset.themeMode === 'system',
    )
    fs.mkdirSync(path.join(root, 'artifacts/theme-fix'), { recursive: true })
    for (const id of ['matrix-dark', 'amber-dark', 'deep-ocean', 'lilac-mist-light']) {
      await page.getByTestId('workspace-domain-settings').click()
      await page.locator('#app-theme').selectOption(id)
      await page.getByTestId('workspace-domain-search').click()
      await page.screenshot({ path: path.join(root, 'artifacts/theme-fix', id + '.png') })
    }
    assert.deepEqual(errors, [])
    const report = {
      passed: true,
      syntheticSettingsBridge: true,
      paletteChecks: checks.length,
      systemModeChanges: true,
      reloadPersistence: true,
      pageErrors: errors,
    }
    fs.writeFileSync(
      path.join(root, 'artifacts/theme-fix/report.json'),
      JSON.stringify(report, null, 2),
    )
    console.log(JSON.stringify(report))
  } finally {
    await browser?.close()
    await server.close()
  }
}
main().catch((error) => {
  console.error(error.stack)
  process.exitCode = 1
})
