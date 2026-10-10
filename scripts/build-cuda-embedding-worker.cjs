#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const [inlineName, inlineValue] = argument.split('=', 2)
    const value = inlineValue ?? argv[index + 1]
    if (!inlineName.startsWith('--')) throw new Error(`unexpected argument: ${argument}`)
    if (inlineValue === undefined) index += 1
    if (value === undefined) throw new Error(`${inlineName} requires a value`)
    if (inlineName === '--ort-root') options.ortRoot = value
    else if (inlineName === '--build-dir') options.buildDir = value
    else if (inlineName === '--output-dir') options.outputDir = value
    else throw new Error(`unknown option: ${inlineName}`)
  }
  for (const name of ['ortRoot', 'buildDir', 'outputDir']) {
    if (!options[name]) throw new Error(`${name} is required`)
  }
  return options
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`)
}

function main(argv = process.argv.slice(2)) {
  try {
    if (process.platform !== 'win32')
      throw new Error('CUDA embedding worker build requires Windows')
    const options = parseArgs(argv)
    const root = path.resolve(__dirname, '..')
    const sourceDir = path.join(root, 'native', 'cuda_embedding_worker')
    const ortRoot = path.resolve(options.ortRoot)
    const buildDir = path.resolve(options.buildDir)
    const outputDir = path.resolve(options.outputDir)
    const includeRoots = [
      path.join(ortRoot, 'build', 'native', 'include'),
      path.join(ortRoot, 'buildTransitive', 'native', 'include'),
    ]
    const includeRoot = includeRoots.find((candidate) =>
      fs.existsSync(path.join(candidate, 'onnxruntime_cxx_api.h')),
    )
    const required = [
      includeRoot && path.join(includeRoot, 'onnxruntime_cxx_api.h'),
      path.join(ortRoot, 'runtimes', 'win-x64', 'native', 'onnxruntime.lib'),
    ]
    for (const requiredPath of required) {
      if (!requiredPath || !fs.existsSync(requiredPath))
        throw new Error(`missing ORT development file: ${requiredPath}`)
    }
    fs.mkdirSync(buildDir, { recursive: true })
    fs.mkdirSync(outputDir, { recursive: true })
    run(
      'cmake',
      [
        '-S',
        sourceDir,
        '-B',
        buildDir,
        '-A',
        'x64',
        `-DORT_ROOT=${ortRoot.replaceAll('\\', '/')}`,
        `-DORT_INCLUDE_DIR=${includeRoot.replaceAll('\\', '/')}`,
        `-DCUDA_WORKER_OUTPUT_DIR=${outputDir.replaceAll('\\', '/')}`,
      ],
      root,
    )
    run('cmake', ['--build', buildDir, '--config', 'Release', '--parallel'], root)
    const executablePath = path.join(outputDir, 'floating_clock_cuda_embedding_worker.exe')
    if (!fs.existsSync(executablePath)) throw new Error('CUDA worker executable was not produced')
    const bytes = fs.readFileSync(executablePath)
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        executablePath,
        sizeBytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      })}\n`,
    )
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = { parseArgs }
