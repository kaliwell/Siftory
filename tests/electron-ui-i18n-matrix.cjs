const path = require('node:path')
const { spawnSync } = require('node:child_process')

const repo = path.resolve(__dirname, '..')
const runner = path.join(__dirname, 'electron-ui-smoke.cjs')
const matrix = [
  { locale: 'zh-CN', viewport: '1366x768', scale: '1.25' },
  { locale: 'zh-CN', viewport: '1920x1080', scale: '1.25' },
  { locale: 'zh-CN', viewport: '2560x1440', scale: '1.5' },
  { locale: 'en', viewport: '1920x1080', scale: '1.25' },
  { locale: 'en', viewport: '2560x1440', scale: '1.5' },
  {
    locale: 'en',
    viewport: '1920x1080',
    scale: '1.25',
    workArea: '-1536,0,1536,864',
  },
]

for (const entry of matrix) {
  console.log(`[ui-i18n-matrix] ${entry.locale} ${entry.viewport} scale=${entry.scale}`)
  const result = spawnSync(
    process.execPath,
    [
      runner,
      `--locale=${entry.locale}`,
      `--viewport=${entry.viewport}`,
      `--scale=${entry.scale}`,
      ...(entry.workArea ? [`--work-area=${entry.workArea}`] : []),
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

console.log(`[ui-i18n-matrix] passed ${matrix.length}/${matrix.length}`)
