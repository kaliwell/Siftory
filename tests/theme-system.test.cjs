const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const {
  THEME_PRESETS,
  LEGACY_THEME_IDS,
  buildThemePalette,
  contrastRatio,
  legacyThemeIndex,
  normalizeThemeId,
  normalizeThemeMode,
  resolveThemeMode,
  themeCssVariables,
} = loadTsModule('src/services/themeCatalog.ts')
const root = path.resolve(__dirname, '..')

test('theme catalog keeps six legacy themes and adds grouped soft, bold, and neutral presets', () => {
  assert.equal(THEME_PRESETS.length, 17)
  assert.equal(new Set(THEME_PRESETS.map((theme) => theme.id)).size, THEME_PRESETS.length)
  assert.deepEqual(LEGACY_THEME_IDS, [
    'matrix-dark',
    'midnight-dark',
    'amber-dark',
    'frost-dark',
    'rose-night',
    'mono-dark',
  ])
  for (const group of ['classic', 'soft', 'bold', 'neutral']) {
    assert.ok(
      THEME_PRESETS.some((theme) => theme.group === group),
      `missing ${group} group`,
    )
  }
  assert.ok(THEME_PRESETS.some((theme) => theme.id === 'pearl-rose-light'))
  assert.ok(THEME_PRESETS.some((theme) => theme.id === 'deep-ocean'))
  assert.ok(THEME_PRESETS.some((theme) => theme.id === 'system-auto'))
  assert.ok(THEME_PRESETS.some((theme) => theme.id === 'high-contrast'))
})

test('legacy numeric settings migrate to stable theme ids without changing appearance', () => {
  LEGACY_THEME_IDS.forEach((themeId, index) => {
    assert.equal(normalizeThemeId(undefined, index), themeId)
    assert.equal(legacyThemeIndex(themeId), index)
  })
  assert.equal(normalizeThemeId('deep-ocean', 0), 'deep-ocean')
  assert.equal(normalizeThemeId('unknown', 99), 'matrix-dark')
  assert.equal(normalizeThemeMode(undefined, 'pearl-rose-light'), 'light')
})

test('every preset meets WCAG AA text contrast on every text-bearing surface', () => {
  for (const theme of THEME_PRESETS) {
    for (const mode of ['light', 'dark']) {
      const palette = buildThemePalette(theme.id, mode)
      for (const surface of ['canvas', 'surface', 'surfaceElevated']) {
        assert.ok(
          contrastRatio(palette.text, palette[surface]) >= 4.5,
          `${theme.id}/${mode} primary text contrast on ${surface}`,
        )
        assert.ok(
          contrastRatio(palette.textMuted, palette[surface]) >= 4.5,
          `${theme.id}/${mode} muted text contrast on ${surface}`,
        )
      }
    }
  }
})

test('system mode reacts to operating-system preference and emits semantic CSS tokens', () => {
  assert.equal(resolveThemeMode('system', true), 'dark')
  assert.equal(resolveThemeMode('system', false), 'light')
  assert.equal(resolveThemeMode('light', true), 'light')
  const variables = themeCssVariables('lilac-mist-light', 'light')
  for (const token of [
    '--color-canvas',
    '--color-surface',
    '--color-surface-elevated',
    '--color-text',
    '--color-text-muted',
    '--color-border',
    '--color-accent',
    '--color-focus',
    '--color-success',
    '--color-warning',
    '--color-danger',
    '--color-selection',
  ]) {
    assert.equal(typeof variables[token], 'string', `missing ${token}`)
  }
})

test('window system consumes semantic tokens and preserves accessibility fallbacks', () => {
  const themes = fs.readFileSync(path.join(root, 'src/styles/themes.css'), 'utf8')
  const windows = fs.readFileSync(path.join(root, 'src/styles/window-system.css'), 'utf8')
  const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
  const settings = fs.readFileSync(path.join(root, 'src/components/SettingsPanel.tsx'), 'utf8')
  assert.match(themes, /--color-canvas:/)
  assert.match(themes, /--color-selection:/)
  for (const token of [
    '--ui-radius-xs',
    '--ui-radius-sm',
    '--ui-radius-md',
    '--ui-radius-lg',
    '--ui-radius-pill',
    '--ui-control-height',
    '--ui-border',
    '--ui-border-strong',
    '--ui-surface-subtle',
    '--ui-surface-hover',
    '--ui-accent-soft',
    '--ui-shadow-panel',
    '--ui-shadow-menu',
    '--ui-motion-fast',
    '--ui-motion-normal',
  ]) {
    assert.ok(themes.includes(`${token}:`), `missing ${token}`)
  }
  assert.match(themes, /--panel-font:\s*'Source Han Sans CN'/)
  assert.match(windows, /var\(--color-surface\)/)
  assert.match(windows, /var\(--color-focus\)/)
  assert.match(windows, /\.panel\s*\{[^}]*border-color:\s*var\(--ui-border\)/s)
  assert.match(windows, /button\s*\{[^}]*min-height:\s*var\(--ui-control-height\)/s)
  assert.match(windows, /prefers-reduced-motion:\s*reduce/)
  assert.match(windows, /data-theme-id='high-contrast'/)
  assert.match(app, /prefers-color-scheme:\s*dark/)
  assert.match(app, /themeCssVariables\(themeId, effectiveMode\)/)
  assert.match(app, /root\.dataset\.material = preset\.material/)
  assert.match(app, /root\.dataset\.density = preset\.density/)
  assert.match(settings, /THEME_GROUPS\.map/)
  assert.match(settings, /data-testid="theme-mode"/)
})
