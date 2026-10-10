const fs = require('fs')
const path = require('path')
const readline = require('readline')

const userData = process.env.FLOATING_CLOCK_USER_DATA ||
  path.join(process.env.APPDATA || '', 'floating-clock-electron')
const manifestPath = path.join(userData, 'media-search', 'manifests', 'video_frames.jsonl')
const embeddingPath = path.join(
  userData,
  'vector-db',
  'embeddings',
  'clip_vit_base_patch32__global.jsonl',
)

function normalizeFrameKey(filePath) {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

const frames = fs.existsSync(manifestPath)
  ? fs.readFileSync(manifestPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : []
const frameKeys = new Map(
  frames
    .filter((record) => record.status === 'done' && record.imagePath && fs.existsSync(record.imagePath))
    .map((record) => [normalizeFrameKey(record.imagePath), record.imagePath]),
)

async function main() {
  let found = 0
  let first = null
  if (fs.existsSync(embeddingPath)) {
    const rl = readline.createInterface({
      input: fs.createReadStream(embeddingPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (!line) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (
        row.modelName !== 'clip_vit_base_patch32' ||
        row.embeddingType !== 'global' ||
        typeof row.imageId !== 'string' ||
        !Array.isArray(row.vector)
      ) {
        continue
      }
      const manifestImagePath = frameKeys.get(normalizeFrameKey(row.imageId))
      if (!manifestImagePath) continue
      found++
      if (!first) {
        first = {
          imageId: row.imageId,
          manifestImagePath,
          dim: row.vector.length,
        }
      }
    }
  }

  console.log(JSON.stringify({
    userData,
    manifestPath,
    embeddingPath,
    readyFrames: frameKeys.size,
    matchingClipEmbeddings: found,
    first,
  }, null, 2))

  if (frameKeys.size > 0 && found === 0) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
