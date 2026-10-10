const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTsModule } = require('./guard-utils.cjs')

const { detectSystemLanguage, normalizeLanguage, translate } = loadTsModule('src/i18n/core.ts')
const { translateRuntimeError, translateRuntimeFailure } = loadTsModule(
  'src/i18n/runtimeError.ts',
)

test('normalizes supported Chinese and English locale variants', () => {
  assert.equal(normalizeLanguage('zh-CN'), 'zh-CN')
  assert.equal(normalizeLanguage('zh-TW'), 'zh-CN')
  assert.equal(normalizeLanguage('en-US'), 'en')
  assert.equal(normalizeLanguage('fr-FR'), null)
})

test('detects the first supported system language and falls back to English', () => {
  assert.equal(detectSystemLanguage(['ja-JP', 'zh-CN', 'en-US']), 'zh-CN')
  assert.equal(detectSystemLanguage(['de-DE']), 'en')
})

test('translates Chinese, falls back to English keys, and interpolates values', () => {
  assert.equal(translate('zh-CN', 'Settings'), '设置')
  assert.equal(translate('zh-CN', 'Untranslated label'), 'Untranslated label')
  assert.equal(translate('en', 'Found {count} items', { count: 3 }), 'Found 3 items')
})

test('translates asset library advanced search and category controls', () => {
  assert.equal(translate('zh-CN', 'Search category samples'), '搜索分类样本')
  assert.equal(translate('zh-CN', 'Recalculate clusters'), '重新计算聚类')
  assert.equal(translate('zh-CN', 'Not relevant'), '不相关')
  assert.equal(translate('zh-CN', 'CATEGORY TREE'), '分类树')
  assert.equal(translate('zh-CN', 'Build reference AI'), '构建参考图 AI')
  assert.equal(translate('zh-CN', 'Archive {count} copies', { count: 3 }), '归档 3 个副本')
})

test('translates image search result actions', () => {
  assert.equal(translate('zh-CN', 'Project files first'), '工程文件优先')
  assert.equal(translate('zh-CN', 'Open'), '打开')
  assert.equal(translate('zh-CN', 'Folder'), '文件夹')
  assert.equal(translate('zh-CN', 'Copy'), '复制')
  assert.equal(translate('zh-CN', 'Similar'), '相似文件')
  assert.equal(translate('zh-CN', 'Subject'), '主体')
  assert.equal(translate('zh-CN', 'Layered'), '分层')
  assert.equal(translate('zh-CN', 'Camera RAW'), '相机 RAW')
  assert.equal(translate('zh-CN', 'Preview provider'), '预览提供器')
  assert.equal(translate('zh-CN', 'PDF compatible'), 'PDF 兼容')
  assert.equal(
    translate('zh-CN', 'Subject search for project files is not available yet'),
    '工程文件主体分割将在后续版本开放',
  )
})

test('translates window topmost actions', () => {
  assert.equal(translate('zh-CN', 'Keep window on top'), '窗口置顶')
  assert.equal(translate('zh-CN', 'Stop keeping window on top'), '取消窗口置顶')
})

test('translates solid and frosted window material controls', () => {
  assert.equal(translate('zh-CN', 'Material'), '界面材质')
  assert.equal(translate('zh-CN', 'Solid'), '不透明')
  assert.equal(translate('zh-CN', 'Glass'), '毛玻璃')
  assert.equal(translate('zh-CN', 'Glass strength'), '毛玻璃透明度')
})

test('translates renderer maintenance, media, asset, and remote terminal surfaces', () => {
  assert.equal(translate('zh-CN', 'No matching records'), '没有匹配记录')
  assert.equal(translate('zh-CN', 'Rebuild Optimized Thumbnails'), '重建优化缩略图')
  assert.equal(translate('zh-CN', 'Coverage: loading after startup...'), '覆盖率：启动后加载中…')
  assert.equal(translate('zh-CN', 'No completed metadata backups.'), '没有已完成的元数据备份。')
  assert.equal(translate('zh-CN', 'Private Key'), '私钥')
  assert.equal(translate('zh-CN', 'Preview Vector GC'), '预览向量 GC')
  assert.equal(translate('zh-CN', 'Delete "{name}"?', { name: '测试服务器' }), '删除“测试服务器”？')
})

test('translates layout panel groups', () => {
  assert.equal(translate('zh-CN', 'Search panels'), '搜索面板')
  assert.equal(translate('zh-CN', 'Other panels'), '其他面板')
})

test('translates migrated status, asset, hash, and SSH baseline text', () => {
  assert.equal(translate('zh-CN', 'Unknown target'), '未知目标')
  assert.equal(translate('zh-CN', 'Asset {id}', { id: 42 }), '素材 42')
  assert.equal(translate('zh-CN', 'Decode {milliseconds} ms', { milliseconds: 3.5 }), '解码 3.5 毫秒')
  assert.equal(
    translate('zh-CN', 'First connection to {host}:{port}.', {
      host: 'server.example',
      port: 22,
    }),
    '首次连接到 server.example:22。',
  )
  assert.equal(translate('zh-CN', 'Trust and save this fingerprint?'), '信任并保存此指纹吗？')
  assert.equal(
    translate('zh-CN', 'Image -> frame results: {results}/{total} by {model} ({milliseconds}ms).', {
      results: 8,
      total: 20,
      model: 'DINO',
      milliseconds: 15,
    }),
    '图片 → 帧结果：8/20，模型 DINO（15 毫秒）。',
  )
  assert.equal(
    translate('zh-CN', 'Cleanup preview ready: {bytes} available', { bytes: '12 MB' }),
    '清理预览已就绪：可释放 12 MB',
  )
})

test('translates stable runtime error codes and preserves diagnostic details', () => {
  const t = (key, values) => translate('zh-CN', key, values)
  assert.equal(
    translateRuntimeError({ code: 'VECTOR_GC_RUNNING' }, t),
    '向量清理正在运行。',
  )
  assert.equal(
    translateRuntimeError(
      { code: 'EMBEDDING_PREPARATION_FAILED', detail: 'child exit 7' },
      t,
    ),
    '数据进程中的图片准备失败。 诊断详情：child exit 7',
  )
})

test('unknown and legacy runtime failures use a bilingual-safe fallback', () => {
  const t = (key, values) => translate('zh-CN', key, values)
  assert.equal(translateRuntimeError({ code: 'FUTURE_ERROR' }, t), '操作失败。')
  assert.equal(
    translateRuntimeFailure({ error: 'legacy backend detail' }, t),
    '操作失败。 诊断详情：legacy backend detail',
  )
})
