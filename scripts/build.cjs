const { spawnSync } = require('child_process')
const path = require('path')
const { packageProfileFromArgs, preparePackageProfile } = require('./package-profile.cjs')

const npmCli = process.env.npm_execpath
const electronBuilderCli = path.join(
  path.dirname(require.resolve('electron-builder/package.json')),
  require('electron-builder/package.json').bin['electron-builder'],
)

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    shell: false,
  })

  if (result.error) {
    console.error(result.error)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

if (!npmCli) {
  console.error('Missing npm_execpath. Run this build through "npm run build".')
  process.exit(1)
}

const profile = packageProfileFromArgs()
run(path.join(__dirname, 'runtime-package-pruning.cjs'), [])
run(path.join(__dirname, 'check-covered-source.cjs'), [])
run(npmCli, ['run', 'build:renderer:checked'])
run(npmCli, ['run', 'typecheck'])
run(npmCli, ['run', 'build:native:electron'])
run(npmCli, ['run', 'resources:verify', '--', `--profile=${profile}`])
const prepared = preparePackageProfile(process.cwd(), profile)
console.log(`[package-profile] ${profile}: ${prepared.configPath}`)
run(electronBuilderCli, ['--config', prepared.configPath])
run(path.join(__dirname, 'check-covered-source.cjs'), [
  '--resources',
  path.resolve(
    process.cwd(),
    prepared.builderConfig.directories?.output || 'release',
    'win-unpacked',
    'resources',
  ),
])
run(path.join(__dirname, 'check-runtime-package.cjs'), [
  '--resources',
  path.resolve(
    process.cwd(),
    prepared.builderConfig.directories?.output || 'release',
    'win-unpacked',
    'resources',
  ),
])
if (process.env.FLOATING_CLOCK_KEEP_UNPACKED !== '1') {
  run(path.join(__dirname, 'clean-release.cjs'), [`--profile=${profile}`])
}
