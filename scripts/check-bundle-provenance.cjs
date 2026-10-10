const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const { inspectBundleProvenance } = await import(pathToFileURL(path.join(__dirname, 'bundle-provenance.mjs')))
  const root = path.resolve(__dirname, '..')
  const outputs = ['dist', 'dist-electron'].map((folder) => ({ folder, ...inspectBundleProvenance(path.join(root, folder)) }))
  const result = { ok: outputs.every((output) => output.ok), outputs }
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}
main().catch((error) => { console.error(error.message); process.exitCode = 1 })
