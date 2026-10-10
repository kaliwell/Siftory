const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repo = path.resolve(__dirname, '..')
const runner = path.join(__dirname, 'electron-ui-smoke.cjs')
const matrix = [
  { locale: 'zh-CN', theme: 'pearl-rose-light', mode: 'light', scale: '1' },
  { locale: 'en', theme: 'lilac-mist-light', mode: 'light', scale: '1.25' },
  { locale: 'zh-CN', theme: 'deep-ocean', mode: 'dark', scale: '1.5' },
  { locale: 'en', theme: 'forest-night', mode: 'dark', scale: '1' },
  { locale: 'zh-CN', theme: 'paper-light', mode: 'light', scale: '1.25' },
  { locale: 'en', theme: 'high-contrast', mode: 'dark', scale: '1.5' },
]

for (const entry of matrix) {
  console.log(`[ui-theme-matrix] ${entry.locale} ${entry.theme} ${entry.mode} scale=${entry.scale}`)
  const result = spawnSync(
    process.execPath,
    [
      runner,
      `--locale=${entry.locale}`,
      '--viewport=1920x1080',
      `--scale=${entry.scale}`,
      `--theme=${entry.theme}`,
      `--theme-mode=${entry.mode}`,
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        FLOATING_CLOCK_UI_SMOKE_TIMEOUT_MS:
          process.env.FLOATING_CLOCK_UI_SMOKE_TIMEOUT_MS || '90000',
      },
      stdio: 'inherit',
    },
  )
  if (result.status !== 0) process.exit(result.status || 1)
}

console.log(`[ui-theme-matrix] passed ${matrix.length}/${matrix.length}`)
