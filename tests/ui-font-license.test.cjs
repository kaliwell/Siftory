const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const fontRelativePath = 'src/assets/fonts/SourceHanSansCN-VF.otf.woff2'
const licenseRelativePath = 'legal/SourceHanSans-OFL-1.1.txt'
const expectedSha256 = '7087698d52240614659957608d8c4ad446759aee3208409dc9f566412e7af8f4'

test('Source Han Sans CN is bundled, hash pinned, and wired into the interface theme', () => {
  const font = fs.readFileSync(path.join(root, fontRelativePath))
  const globalStyles = fs.readFileSync(path.join(root, 'src/styles/global.css'), 'utf8')
  const themeStyles = fs.readFileSync(path.join(root, 'src/styles/themes.css'), 'utf8')

  assert.equal(font.subarray(0, 4).toString('ascii'), 'wOF2')
  assert.equal(crypto.createHash('sha256').update(font).digest('hex'), expectedSha256)
  assert.match(globalStyles, /@font-face\s*\{[^}]*font-family:\s*'Source Han Sans CN'/s)
  assert.match(globalStyles, /url\('\.\.\/assets\/fonts\/SourceHanSansCN-VF\.otf\.woff2'\)/)
  assert.match(themeStyles, /--panel-font:\s*'Source Han Sans CN'/)
})

test('the bundled font carries its official OFL text and packaged notice', () => {
  const license = fs.readFileSync(path.join(root, licenseRelativePath), 'utf8')
  const notice = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const resources = new Map(packageJson.build.extraResources.map((entry) => [entry.from, entry.to]))

  assert.match(license, /Copyright 2014-2025 Adobe/)
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/)
  assert.match(license, /Reserved Font Name/)
  assert.match(notice, /Source Han Sans CN Variable/)
  assert.match(notice, new RegExp(expectedSha256))
  assert.equal(resources.get(licenseRelativePath), licenseRelativePath)
})
