const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { resolveWindowMaterial } = loadTsModule('src/services/windowMaterial.ts')
const root = path.resolve(__dirname, '..')

test('window material maps zero to opaque and bounds frosted glass strength', () => {
  assert.deepEqual(resolveWindowMaterial(0), {
    mode: 'solid',
    transparency: 0,
    surfaceAlpha: 0.98,
    blurPx: 0,
    saturation: 1,
  })

  const lightGlass = resolveWindowMaterial(1)
  const strongGlass = resolveWindowMaterial(60)
  assert.equal(lightGlass.mode, 'glass')
  assert.equal(strongGlass.mode, 'glass')
  assert.equal(strongGlass.transparency, 60)
  assert.ok(strongGlass.surfaceAlpha < lightGlass.surfaceAlpha)
  assert.ok(strongGlass.blurPx > lightGlass.blurPx)
  assert.deepEqual(resolveWindowMaterial(100), strongGlass)
  assert.deepEqual(resolveWindowMaterial(Number.NaN), resolveWindowMaterial(0))
})

test('window design system keeps modern flat geometry, optional glass, and solid fallbacks', () => {
  const themes = fs.readFileSync(path.join(root, 'src/styles/themes.css'), 'utf8')
  const windows = fs.readFileSync(path.join(root, 'src/styles/window-system.css'), 'utf8')
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')

  assert.match(themes, /--ui-radius-lg:\s*[^;]+;/)
  assert.match(themes, /--panel-radius:\s*var\(--ui-radius-lg\)/)
  assert.match(themes, /--panel-shadow:\s*var\(--ui-shadow-panel\)/)
  assert.match(
    windows,
    /html\[data-surface='glass'\]\s+\.panel\s*\{[^}]*backdrop-filter:\s*blur\(var\(--panel-glass-blur\)\)\s+saturate\(var\(--panel-glass-saturation\)\)/s,
  )
  assert.match(windows, /html\[data-surface='solid'\]\s+\.panel/)
  assert.match(windows, /prefers-reduced-transparency:\s*reduce/)
  assert.match(app, /resolveWindowMaterial\(transparency\)/)
  assert.doesNotMatch(app, /electronAPI\.setTransparency/)
})
