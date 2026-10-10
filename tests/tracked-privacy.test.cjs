const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { findPrivacyIssues, redactPrivacyPaths } = require('../scripts/check-tracked-privacy.cjs')

test('privacy scanner recognizes Windows, JSON, Unix, QQ and WeChat identities', () => {
  const samples = [
    String.raw`C:\Users\private-user\Downloads\asset.psd`,
    String.raw`"C:\\Users\\private-user\\Documents\\Tencent Files\\123456789\\asset.png"`,
    '/home/private-user/assets/image.png',
    '/Users/private-user/assets/image.png',
    String.raw`Tencent Files\123456789\nt_data`,
    'wxid_privateaccount123',
  ]
  for (const sample of samples) assert.ok(findPrivacyIssues(sample).length > 0, sample)
})

test('privacy scanner accepts stable placeholders', () => {
  const text = [
    String.raw`C:\Users\<USER>\assets`,
    '/home/<USER>/assets',
    String.raw`<QQ_DATA>\nt_data\image.png`,
    String.raw`<WECHAT_DATA>\msg\video.png`,
    String.raw`<DATASET>\sample-001.psd`,
  ].join('\n')
  assert.deepEqual(findPrivacyIssues(text), [])
  assert.equal(redactPrivacyPaths(text), text)
})

test('privacy redactor uses semantic roots and leaves valid JSON', () => {
  const source = JSON.stringify({
    qq: String.raw`C:\Users\private-user\Documents\Tencent Files\123456789\nt_data\a.png`,
    app: String.raw`C:\Users\private-user\AppData\Roaming\floating-clock-electron\frames\a.jpg`,
    dataset: String.raw`C:\Users\private-user\Downloads\a.psd`,
  })
  const redacted = redactPrivacyPaths(source)
  const parsed = JSON.parse(redacted)
  assert.match(parsed.qq, /^<QQ_DATA>/)
  assert.match(parsed.app, /^<APP_DATA>/)
  assert.match(parsed.dataset, /^<DATASET>/)
  assert.deepEqual(findPrivacyIssues(redacted), [])
})

test('repository tracked documentation is privacy-clean', () => {
  const root = path.resolve(__dirname, '..')
  const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
  assert.match(packageJson, /"privacy:check": "node scripts\/check-tracked-privacy\.cjs"/)
  assert.match(packageJson, /"test:privacy": "node --test tests\/tracked-privacy\.test\.cjs"/)

  for (const relativePath of [
    'tests/media-search-benchmark-wrapper.ps1',
    'tests/media-search-ipc-scan-benchmark-wrapper.ps1',
    'scripts/eval-chinese-semantic-search.cjs',
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    assert.match(source, /artifacts[\\/]/, relativePath)
    assert.doesNotMatch(source, /docs[\\/]benchmark/, relativePath)
  }
})
