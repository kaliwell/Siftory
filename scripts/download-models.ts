/**
 * Model Download Script
 *
 * Downloads vision model weights for Layer 2 vector retrieval.
 * Run: npx ts-node scripts/download-models.ts [model-name]
 *
 * Models are saved to models/ directory (gitignored except manifest).
 * SHA-256 is verified after download.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

const MANIFEST_PATH = path.join(__dirname, '..', 'models', 'manifest.json')
const MODELS_DIR = path.join(__dirname, '..', 'models')

interface ModelFileEntry {
  filename: string
  url: string
  sha256: string
  sizeBytes: number
}

interface ModelEntry extends ModelFileEntry {
  name: string
  requiredFiles?: ModelFileEntry[]
}

function requiredModelFiles(entry: ModelEntry): ModelFileEntry[] {
  return [entry, ...(entry.requiredFiles || [])]
}

async function downloadModelFile(modelName: string, entry: ModelFileEntry): Promise<void> {
  const destDir = path.join(MODELS_DIR, modelName)
  fs.mkdirSync(destDir, { recursive: true })
  const destPath = path.join(destDir, entry.filename)
  fs.mkdirSync(path.dirname(destPath), { recursive: true })

  if (fs.existsSync(destPath)) {
    console.log(`[download-models] ${modelName}/${entry.filename}: file exists, verifying...`)
    const buf = fs.readFileSync(destPath)
    const actualHash = crypto.createHash('sha256').update(buf).digest('hex')
    if (actualHash === entry.sha256) {
      console.log(`[download-models] ${modelName}/${entry.filename}: already verified.`)
      return
    }
    console.log(
      `[download-models] ${modelName}/${entry.filename}: hash mismatch, re-downloading...`,
    )
    fs.unlinkSync(destPath)
  }

  if (!entry.url) {
    console.log(`[download-models] ${modelName}/${entry.filename}: no download URL, skipping.`)
    return
  }

  console.log(`[download-models] Downloading ${modelName}/${entry.filename} from ${entry.url}...`)
  console.log(`[download-models] Expected size: ${(entry.sizeBytes / 1e6).toFixed(1)} MB`)

  const response = await fetch(entry.url, {
    headers: { 'User-Agent': 'Siftory-ModelDownload/1.0' },
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const fileStream = fs.createWriteStream(destPath)
  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  let downloaded = 0
  const total = parseInt(response.headers.get('content-length') || '0', 10) || entry.sizeBytes

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    fileStream.write(value)
    downloaded += value.length
    const pct = total > 0 ? ((downloaded / total) * 100).toFixed(1) : '?'
    process.stdout.write(`\r  ${pct}% (${(downloaded / 1e6).toFixed(1)} MB)`)
  }

  await new Promise<void>((resolve, reject) => {
    fileStream.end((err?: Error | null) => (err ? reject(err) : resolve()))
  })

  console.log('\n[download-models] Verifying SHA-256...')
  const buf = fs.readFileSync(destPath)
  const actualHash = crypto.createHash('sha256').update(buf).digest('hex')

  if (entry.sha256 && actualHash !== entry.sha256) {
    fs.unlinkSync(destPath)
    throw new Error(`SHA-256 mismatch!\n  Expected: ${entry.sha256}\n  Got:      ${actualHash}`)
  }

  console.log(`[download-models] ${modelName}/${entry.filename}: downloaded and verified.`)

  // Update manifest with real hash if it was placeholder
  if (!entry.sha256 || entry.sha256.startsWith('PLACEHOLDER')) {
    console.log(`[download-models] ${entry.name}: SHA-256 = ${actualHash}`)
    console.log(`[download-models] Update manifest.json with this hash.`)
  }
}

async function downloadModel(entry: ModelEntry): Promise<void> {
  for (const file of requiredModelFiles(entry)) await downloadModelFile(entry.name, file)
}

async function main(): Promise<void> {
  const targetName = process.argv[2]

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'))
  const models: ModelEntry[] = manifest.models || []

  if (targetName) {
    const entry = models.find((m: ModelEntry) => m.name === targetName)
    if (!entry) {
      console.error(`Unknown model: ${targetName}`)
      console.error(`Available: ${models.map((m: ModelEntry) => m.name).join(', ')}`)
      process.exit(1)
    }
    await downloadModel(entry)
  } else {
    console.log('Available models:')
    for (const m of models) {
      const downloaded = requiredModelFiles(m).every((file) =>
        fs.existsSync(path.join(MODELS_DIR, m.name, file.filename)),
      )
      console.log(`  ${m.name} [${downloaded ? 'downloaded' : 'not downloaded'}]`)
    }
    console.log('\nSpecify a model name to download: npx ts-node scripts/download-models.ts <name>')
  }
}

main().catch((err) => {
  console.error('Download failed:', err.message)
  process.exit(1)
})
