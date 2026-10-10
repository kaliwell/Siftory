const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { loadTsModule } = require('./guard-utils.cjs')
const { translate } = loadTsModule('src/i18n/core.ts')

const ROOT = path.resolve(__dirname, '..')

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

test('workspace Tasks menu mounts one preparation center backed by main-process status', () => {
  const workspace = source('src/components/WorkspaceNavigator.tsx')
  const center = source('src/components/ProductReadinessCenter.tsx')

  assert.match(workspace, /<ProductReadinessCenter onAction=\{openReadinessAction\} \/>/)
  assert.match(center, /loadProductReadiness\(api, \{ includeStorage \}\)/)
  assert.match(center, /refreshIntervalMs = 5000/)
  assert.match(center, /refreshInFlightRef/)
  assert.match(center, /'Calculate storage'/)
  assert.match(center, /data-testid="product-readiness-next-action"/)
  assert.match(center, /data-testid="product-model-manager"/)
  assert.match(center, /data-testid="product-task-center"/)
  assert.match(center, /data-testid="product-task-storage"/)
})

test('managed model mutations require a visible click and destructive confirmation', () => {
  const center = source('src/components/ProductReadinessCenter.tsx')

  assert.match(center, /window\.confirm\(t\('Download and verify \{model\} now\?'/)
  assert.match(center, /window\.confirm\(t\('Remove \{model\} from this device\?'/)
  assert.match(center, /await vector\.downloadModel\(model\.id\)/)
  assert.match(center, /await vector\.deleteModel\(model\.id\)/)
  assert.match(center, /await vector\.cancelDownload\(\)/)

  const effectBlock = center.slice(
    center.indexOf('useEffect(() =>'),
    center.indexOf('if (!snapshot)'),
  )
  assert.doesNotMatch(effectBlock, /downloadModel|deleteModel|cancelDownload/)
  assert.doesNotMatch(
    effectBlock,
    /runProductTaskControl|pauseEmbeddingBuild|resumeEmbeddingBuild|stopEmbeddingBuild/,
  )
})

test('task center exposes authoritative progress, restart status, and guarded controls', () => {
  const center = source('src/components/ProductReadinessCenter.tsx')

  assert.match(center, /snapshot\.tasks\.map/)
  assert.match(center, /task\.itemsPerSecond/)
  assert.match(center, /task\.etaMs/)
  assert.match(center, /task\.persisted \? 'Restores after restart' : 'This-session task'/)
  assert.match(center, /runProductTaskControl\(api, task, action\)/)
  for (const action of ['pause', 'resume', 'retry', 'stop']) {
    assert.ok(center.includes(`${action}:`), `missing task control ${action}`)
  }
})

test('preparation center renders every product stage and capability', () => {
  const center = source('src/components/ProductReadinessCenter.tsx')

  for (const stage of [
    'sources',
    'catalog',
    'image-semantic',
    'video-visual',
    'video-semantic',
    'audio-semantic',
  ]) {
    assert.ok(center.includes(stage), `missing stage ${stage}`)
  }
  for (const capability of [
    'metadata',
    'imageSimilarity',
    'naturalLanguageImage',
    'videoFrame',
    'videoSemantic',
    'dialogue',
  ]) {
    assert.ok(center.includes(capability), `missing capability ${capability}`)
  }
})

test('preparation center labels are translated for Chinese UI', () => {
  assert.equal(translate('zh-CN', 'Preparation center'), '准备中心')
  assert.equal(translate('zh-CN', 'Searchable now'), '现在可搜索')
  assert.equal(translate('zh-CN', 'Dialogue and audio'), '对白与音频')
  assert.equal(translate('zh-CN', 'Next step'), '下一步')
  assert.equal(translate('zh-CN', 'Task center'), '任务中心')
  assert.equal(translate('zh-CN', 'Restores after restart'), '重启后可恢复')
})
