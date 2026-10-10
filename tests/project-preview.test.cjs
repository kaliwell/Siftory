const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const AdmZip = require('adm-zip')
const sharp = require('sharp')
const { loadTsModule } = require('./guard-utils.cjs')

const { classifyProjectFile, isProjectFile } = loadTsModule('shared/projectFileTypes.ts')
const { ProjectPreviewManifestStore, projectPreviewCacheKey, projectSourceId } = loadTsModule(
  'electron/projectPreviewManifest.ts',
)
const {
  extractKraMergedPreview,
  extractPdfFirstPage,
  extractPsdEmbeddedPreview,
  extractSafeSvgPreview,
  extractTiffArtwork,
  projectPreviewBitmapDifference,
  providerForExtension,
  providersForExtension,
} = loadTsModule('electron/projectPreviewProviders.ts')
const { ProjectPreviewService } = loadTsModule('electron/projectPreviewService.ts')
const { externalProjectPreviewConfigPath, loadExternalProjectPreviewProviders } = loadTsModule(
  'electron/projectPreviewExternalProviders.ts',
)
const {
  getProjectSearchMetadata,
  indexProjectPreviews,
  initProjectSearchIndex,
  isProjectPreviewProxy,
  mapProjectLayeredResults,
  prepareProjectSearchInput,
  resolveProjectSearchInputPath,
  searchProjectPreviewHashes,
} = loadTsModule('electron/projectSearchIndexService.ts')

async function imageBuffer(format = 'jpeg') {
  const pipeline = sharp({
    create: {
      width: 640,
      height: 480,
      channels: 3,
      background: { r: 80, g: 120, b: 200 },
    },
  })
  return format === 'png' ? pipeline.png().toBuffer() : pipeline.jpeg({ quality: 90 }).toBuffer()
}

function makePsdWithPreview(jpeg, version = 1) {
  const header = Buffer.alloc(26)
  header.write('8BPS', 0, 'ascii')
  header.writeUInt16BE(version, 4)
  header.writeUInt16BE(3, 12)
  header.writeUInt32BE(480, 14)
  header.writeUInt32BE(640, 18)
  header.writeUInt16BE(8, 22)
  header.writeUInt16BE(3, 24)
  const thumbnailHeader = Buffer.alloc(28)
  thumbnailHeader.writeUInt32BE(1, 0)
  const resource = Buffer.concat([
    Buffer.from('8BIM', 'ascii'),
    Buffer.from([0x04, 0x0c]),
    Buffer.from([0, 0]),
    Buffer.alloc(4),
    thumbnailHeader,
    jpeg,
  ])
  resource.writeUInt32BE(thumbnailHeader.length + jpeg.length, 8)
  const resourceLength = Buffer.alloc(4)
  resourceLength.writeUInt32BE(resource.length, 0)
  return Buffer.concat([header, Buffer.alloc(4), resourceLength, resource])
}

function makePdf() {
  const content = 'q 0.15 0.45 0.85 rg 0 0 320 200 re f Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  const parts = [Buffer.from('%PDF-1.7\n%\x80\x81\x82\x83\n', 'binary')]
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.concat(parts).length)
    parts.push(Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`, 'binary'))
  }
  const xrefOffset = Buffer.concat(parts).length
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join('')
  parts.push(Buffer.from(xref, 'binary'))
  return Buffer.concat(parts)
}

test('project file classification exposes stable search keywords', () => {
  assert.deepEqual(classifyProjectFile('C:\\art\\poster.PSD'), {
    sourceKind: 'project',
    sourceExt: 'psd',
    displayType: 'Photoshop PSD',
    keywords: ['project-file', 'photoshop', 'psd', 'layered', 'editable'],
  })
  assert.equal(classifyProjectFile('/art/painting.kra').keywords.includes('krita'), true)
  assert.equal(isProjectFile('/art/vector.ai'), true)
  assert.equal(isProjectFile('/art/photo.jpg'), false)
  assert.equal(classifyProjectFile('/art/layout.indd').keywords.includes('indesign'), true)
  assert.equal(classifyProjectFile('/art/camera.NEF').keywords.includes('camera-raw'), true)
  assert.equal(classifyProjectFile('/art/drawing.clip').keywords.includes('layered'), true)
})

test('PSD and PSB providers stream the embedded JPEG preview', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-psd-provider-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const jpeg = await imageBuffer('jpeg')
  for (const [name, version] of [
    ['sample.psd', 1],
    ['sample.psb', 2],
  ]) {
    const sourcePath = path.join(tmpDir, name)
    fs.writeFileSync(sourcePath, makePsdWithPreview(jpeg, version))
    const extracted = await extractPsdEmbeddedPreview(sourcePath)
    assert.deepEqual(extracted, jpeg)
  }
  assert.equal(providerForExtension('psd').id, 'psd-embedded-jpeg')
  assert.equal(providerForExtension('psb').id, 'psd-embedded-jpeg')
})

test('KRA provider prefers mergedimage.png and supports deflated ZIP entries', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-kra-provider-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const merged = await imageBuffer('png')
  const preview = await sharp(merged).resize(128, 96).png().toBuffer()
  const archive = new AdmZip()
  archive.addFile('preview.png', preview)
  archive.addFile('mergedimage.png', merged)
  const sourcePath = path.join(tmpDir, 'painting.kra')
  archive.writeZip(sourcePath)
  const extracted = await extractKraMergedPreview(sourcePath)
  assert.deepEqual(extracted, merged)
  assert.equal(providerForExtension('kra').id, 'kra-merged-png')
})

test('SVG provider accepts local vector markup and rejects active or external content', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-svg-provider-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const safePath = path.join(tmpDir, 'safe.svg')
  const unsafePath = path.join(tmpDir, 'unsafe.svg')
  fs.writeFileSync(
    safePath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#2878d0"/></svg>',
  )
  fs.writeFileSync(
    unsafePath,
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private.png"/></svg>',
  )
  assert.equal((await extractSafeSvgPreview(safePath)).includes(Buffer.from('<svg')), true)
  assert.equal(await extractSafeSvgPreview(unsafePath), null)
  assert.equal(providerForExtension('svg').id, 'svg-safe-raster')
})

test('PDF and PDF-compatible AI providers render the first page without shell plugins', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-pdf-provider-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const pdf = makePdf()
  for (const name of ['document.pdf', 'illustration.ai']) {
    const sourcePath = path.join(tmpDir, name)
    fs.writeFileSync(sourcePath, pdf)
    const rendered = await extractPdfFirstPage(sourcePath)
    assert.ok(rendered)
    const metadata = await sharp(rendered).metadata()
    assert.equal(metadata.format, 'png')
    assert.equal(metadata.width, 2048)
    assert.equal(metadata.height, 1280)
  }
  assert.equal(providerForExtension('pdf').id, 'pdfjs-first-page')
  assert.equal(providerForExtension('ai').id, 'pdfjs-first-page')
})

test('PDF-compatible AI manifests record compatibility only after successful rendering', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-ai-manifest-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const compatiblePath = path.join(tmpDir, 'compatible.ai')
  const incompatiblePath = path.join(tmpDir, 'legacy.ai')
  fs.writeFileSync(compatiblePath, makePdf())
  fs.writeFileSync(incompatiblePath, '%!PS-Adobe-3.0\n%%EOF')
  const service = new ProjectPreviewService(tmpDir)
  const compatible = await service.getOrCreate(compatiblePath)
  const incompatible = await service.getOrCreate(incompatiblePath)
  assert.equal(compatible.status, 'ready')
  assert.equal(compatible.keywords.includes('pdf-compatible'), true)
  assert.equal(incompatible.status, 'unavailable')
  assert.equal(incompatible.keywords.includes('pdf-compatible'), false)
})

test('TIFF uses bounded direct decoding and optional formats fall back to Windows Shell', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-tiff-provider-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const sourcePath = path.join(tmpDir, 'artwork.tiff')
  const tiff = await sharp(await imageBuffer('png'))
    .tiff()
    .toBuffer()
  fs.writeFileSync(sourcePath, tiff)
  assert.deepEqual(await extractTiffArtwork(sourcePath), tiff)
  assert.equal(providerForExtension('tiff').id, 'tiff-direct')
  assert.deepEqual(
    providersForExtension('tiff').map((provider) => provider.id),
    ['tiff-direct', 'windows-shell-thumbnail'],
  )
  assert.deepEqual(
    providersForExtension('indd').map((provider) => provider.id),
    ['windows-shell-thumbnail'],
  )
  const bitmap = Buffer.from([0, 10, 20, 255])
  assert.equal(projectPreviewBitmapDifference(bitmap, Buffer.from(bitmap)), 0)
  assert.equal(projectPreviewBitmapDifference(bitmap, Buffer.from([255, 10, 20, 255])) > 0.2, true)
})

test('provider chain falls back after an unavailable embedded preview', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-provider-chain-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const sourcePath = path.join(tmpDir, 'drawing.cdr')
  fs.writeFileSync(sourcePath, 'placeholder')
  const png = await imageBuffer('png')
  const calls = []
  const service = new ProjectPreviewService(tmpDir, [
    {
      id: 'unavailable-first',
      version: '1',
      extensions: ['cdr'],
      extract: async () => {
        calls.push('first')
        return null
      },
    },
    {
      id: 'working-second',
      version: '2',
      extensions: ['cdr'],
      extract: async () => {
        calls.push('second')
        return png
      },
    },
  ])
  const entry = await service.getOrCreate(sourcePath)
  assert.equal(entry.status, 'ready')
  assert.equal(entry.provider, 'working-second')
  assert.deepEqual(calls, ['first', 'second'])
})

test('explicit external providers use validated executable configs without a shell', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-external-provider-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const converterPath = path.join(tmpDir, 'converter.cjs')
  const previewPath = path.join(tmpDir, 'preview.png')
  const sourcePath = path.join(tmpDir, 'drawing.cdr')
  fs.writeFileSync(
    converterPath,
    "const fs=require('node:fs');fs.copyFileSync(process.argv[2],process.argv[4])",
  )
  fs.writeFileSync(previewPath, await imageBuffer('png'))
  fs.writeFileSync(sourcePath, 'external-source')
  fs.writeFileSync(
    externalProjectPreviewConfigPath(tmpDir),
    JSON.stringify({
      version: 1,
      providers: [
        {
          id: 'test-converter',
          version: '7',
          extensions: ['cdr'],
          executable: process.execPath,
          args: [converterPath, previewPath, '{input}', '{output}'],
          timeoutMs: 10_000,
        },
        {
          id: 'unsafe-script',
          version: '1',
          extensions: ['indd'],
          executable: converterPath,
          args: ['{input}', '{output}'],
        },
      ],
    }),
  )
  const providers = loadExternalProjectPreviewProviders(tmpDir)
  assert.equal(providers.length, 1)
  assert.equal(providers[0].id, 'external:test-converter')
  assert.equal(providers[0].extensions[0], 'cdr')
  assert.deepEqual(await providers[0].extract(sourcePath), fs.readFileSync(previewPath))
  const entry = await new ProjectPreviewService(tmpDir).getOrCreate(sourcePath)
  assert.equal(entry.status, 'ready')
  assert.equal(entry.provider, 'external:test-converter')
})

test('project preview service caches by source fingerprint and provider version', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-preview-service-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const sourcePath = path.join(tmpDir, 'design.psd')
  fs.writeFileSync(sourcePath, 'source-v1')
  const png = await imageBuffer('png')
  let calls = 0
  const provider = {
    id: 'test-provider',
    version: '7',
    extensions: ['psd'],
    extract: async () => {
      calls += 1
      return png
    },
  }
  const service = new ProjectPreviewService(tmpDir, [provider])
  const first = await service.getOrCreate(sourcePath)
  const cached = await service.getOrCreate(sourcePath)
  assert.equal(first.status, 'ready')
  assert.equal(cached.previewPath, first.previewPath)
  assert.equal(calls, 1)
  assert.equal(first.keywords.includes('photoshop'), true)
  assert.equal(fs.existsSync(first.previewPath), true)

  fs.appendFileSync(sourcePath, '-changed')
  const changed = await service.getOrCreate(sourcePath)
  assert.equal(changed.status, 'ready')
  assert.notEqual(changed.previewPath, first.previewPath)
  assert.equal(calls, 2)
  assert.equal(fs.existsSync(first.previewPath), false)
  const manifest = JSON.parse(fs.readFileSync(service.manifest.manifestPath, 'utf8'))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.entries.length, 1)
  assert.equal(
    fs.readdirSync(service.manifest.rootDir).some((name) => name.endsWith('.tmp')),
    false,
  )
})

test('manifest cache identity is deterministic and corrupt manifests are recoverable', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-preview-manifest-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const store = new ProjectPreviewManifestStore(tmpDir)
  fs.mkdirSync(store.rootDir, { recursive: true })
  fs.writeFileSync(store.manifestPath, '{broken')
  await store.load()
  assert.deepEqual(await store.list(), [])
  assert.equal(
    fs.readdirSync(store.rootDir).some((name) => name.startsWith('manifest.json.corrupted-')),
    true,
  )
  const sourcePath = path.resolve(tmpDir, 'a.psd')
  assert.equal(projectSourceId(sourcePath), projectSourceId(sourcePath))
  const input = {
    sourcePath,
    size: 10,
    mtimeMs: 20,
    provider: 'p',
    providerVersion: '1',
  }
  assert.equal(projectPreviewCacheKey(input), projectPreviewCacheKey(input))
})

test('project search indexes preview proxies but exposes and removes source identities', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-search-index-'))
  t.after(() => {
    sharp.cache(false)
    fs.rmSync(tmpDir, { recursive: true, force: true })
    sharp.cache(true)
  })
  const userDataPath = path.join(tmpDir, 'user-data')
  const sourceRoot = path.join(tmpDir, 'library')
  const sourcePath = path.join(sourceRoot, 'campaign.psd')
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.writeFileSync(sourcePath, makePsdWithPreview(await imageBuffer('jpeg')))
  await initProjectSearchIndex(userDataPath)

  const upserts = []
  const deletes = []
  const vectorDeletes = []
  const adapter = {
    async hashImageAsync(previewPath) {
      const metadata = await sharp(previewPath).metadata()
      return {
        ok: true,
        width: metadata.width,
        height: metadata.height,
        diffHash64: '1'.repeat(16),
        dctHash64: '2'.repeat(16),
      }
    },
    upsertIndexRecord(...args) {
      upserts.push(args)
      return { ok: true }
    },
    deleteIndexPath(filePath) {
      deletes.push(filePath)
      return { ok: true }
    },
    removeSourceVectorData(filePath) {
      vectorDeletes.push(filePath)
    },
  }

  const indexed = await indexProjectPreviews([sourceRoot], adapter)
  assert.equal(indexed.indexed, 1)
  assert.equal(indexed.failed, 0)
  assert.equal(upserts.length, 1)
  const previewPath = upserts[0][0]
  assert.equal(isProjectPreviewProxy(previewPath), true)
  assert.equal(path.extname(previewPath), '.jpg')
  assert.notEqual(previewPath, sourcePath)
  assert.equal(resolveProjectSearchInputPath(sourcePath), previewPath)
  assert.equal(await prepareProjectSearchInput(sourcePath), previewPath)
  const projectHashHits = searchProjectPreviewHashes('1'.repeat(16), '2'.repeat(16), 0, 10)
  assert.equal(projectHashHits.length, 1)
  assert.equal(projectHashHits[0].path, previewPath)
  assert.equal(projectHashHits[0].distance, 0)

  const metadata = getProjectSearchMetadata(previewPath)
  assert.equal(metadata.sourcePath, sourcePath)
  assert.equal(metadata.sourceExt, 'psd')
  assert.equal(metadata.keywords.includes('layered'), true)
  assert.equal(upserts[0][3], fs.statSync(sourcePath).size)
  const mapped = mapProjectLayeredResults([
    {
      imageId: previewPath,
      path: previewPath,
      finalScore: 0.9,
      hashScore: 0.9,
      vectorScore: 0,
      colorScore: 0,
      shapeScore: 0,
      localFeatureScore: 0,
      ocrScore: 0,
      matchLevel: 'near_duplicate',
      reasons: [],
      indexSources: ['hash'],
    },
  ])
  assert.equal(mapped.length, 1)
  assert.equal(mapped[0].path, sourcePath)
  assert.equal(mapped[0].sourceKind, 'project')
  assert.equal(mapped[0].projectDisplayType, 'Photoshop PSD')

  fs.unlinkSync(sourcePath)
  const cleaned = await indexProjectPreviews([sourceRoot], adapter)
  assert.equal(cleaned.removed, 1)
  assert.equal(deletes.includes(previewPath), true)
  assert.equal(vectorDeletes.includes(sourcePath), true)
  assert.equal(getProjectSearchMetadata(sourcePath), null)
  assert.equal(getProjectSearchMetadata(previewPath), null)
})

test('project preview proxy detection rejects cross-drive paths on Windows', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('cross-drive path.relative semantics are Windows-specific')
    return
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-proxy-cross-drive-'))
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
  const userDataPath = path.join(tmpDir, 'user-data')
  await initProjectSearchIndex(userDataPath)
  const previewsDir = new ProjectPreviewService(userDataPath).manifest.previewsDir
  const previewDrive = path.parse(previewsDir).root.slice(0, 1).toUpperCase()
  const otherDrive = previewDrive === 'D' ? 'C' : 'D'
  // path.relative returns an absolute path across drives, which previously
  // slipped past the `..` checks and dropped every other-drive record from search.
  assert.equal(isProjectPreviewProxy(`${otherDrive}:\\PxHereDataset\\images\\x.jpg`), false)
  assert.equal(isProjectPreviewProxy(`${otherDrive}:/PxHereDataset/images/x.jpg`), false)
  assert.equal(isProjectPreviewProxy(path.join(previewsDir, 'cached-preview.jpg')), true)
})

test('project search integration keeps proxy paths behind the main-process boundary', () => {
  const root = path.resolve(__dirname, '..')
  const imageSearch = fs.readFileSync(path.join(root, 'electron/imageSearchService.ts'), 'utf8')
  const projectSearch = fs.readFileSync(
    path.join(root, 'electron/projectSearchIndexService.ts'),
    'utf8',
  )
  const embeddingPreparation = fs.readFileSync(
    path.join(root, 'electron/embeddingPreparationChild.ts'),
    'utf8',
  )
  const embeddingSpool = fs.readFileSync(
    path.join(root, 'electron/embeddingPreparationSpool.ts'),
    'utf8',
  )
  const vectorIpc = fs.readFileSync(path.join(root, 'electron/vectorIpc.ts'), 'utf8')
  const resultGrid = fs.readFileSync(
    path.join(root, 'src/components/ImageSearchResultGrid.tsx'),
    'utf8',
  )
  assert.match(imageSearch, /indexProjectPreviews\(/)
  assert.match(projectSearch, /searchProjectPreviewHashes\(/)
  assert.match(imageSearch, /mapNativeProjectSearchHits\(mergedHits\)/)
  assert.match(embeddingPreparation, /spool\.findProjectPreview\(pathKey\(fullPath\)\)/)
  assert.match(embeddingPreparation, /spool\.addCandidate\(embeddingCachePathKey\(fullPath\)/)
  assert.match(embeddingSpool, /CREATE TABLE project_previews/)
  assert.match(embeddingSpool, /CREATE TABLE candidates/)
  assert.match(vectorIpc, /mapProjectLayeredResults\(response\.results\)/)
  assert.match(resultGrid, /r\.sourceKind === 'project'/)
  assert.match(resultGrid, /PROJECT_KEYWORD_LABELS/)
  assert.match(resultGrid, /disabled=\{r\.sourceKind === 'project'\}/)
})

test('thumbnail pipeline routes MVP project formats through project preview manifests', () => {
  const root = path.resolve(__dirname, '..')
  const thumbnail = fs.readFileSync(path.join(root, 'electron/thumbnailIpc.ts'), 'utf8')
  const renderer = fs.readFileSync(
    path.join(root, 'src/components/filemanager/ThumbnailImage.tsx'),
    'utf8',
  )
  const resultGrid = fs.readFileSync(
    path.join(root, 'src/components/ImageSearchResultGrid.tsx'),
    'utf8',
  )
  assert.match(thumbnail, /PROJECT_PREVIEW_EXTS = new Set\(\[/)
  assert.match(thumbnail, /getProjectPreviewService\(userDataPath\)\.getOrCreate\(filePath\)/)
  assert.match(renderer, /isProjectFile\(filePath\)/)
  assert.match(renderer, /projectThumbnailScheduler/)
  assert.match(renderer, /fmGetThumbnail\(path, maxDim\)/)
  assert.match(renderer, /Promise\.allSettled/)
  assert.match(renderer, /PROJECT_THUMBNAIL_RETRY_DELAYS_MS/)
  assert.match(renderer, /visibilitychange/)
  assert.match(renderer, /activeRequestKey/)
  assert.match(resultGrid, /loadWhenRendered/)
  assert.match(resultGrid, /startIndex \+ visibleIndex/)
  for (const extension of ['psb', 'kra', 'pdf', 'ai', 'eps', 'nef', 'clip', 'cdr', 'indd']) {
    assert.equal(thumbnail.includes(`'.${extension}'`), true)
    assert.equal(renderer.includes(`'.${extension}'`), true)
  }
})
