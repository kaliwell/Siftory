const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  firstLevelHeadingCount,
  inspectDocumentation,
  relativeLinkTargets,
} = require('../scripts/check-documentation-standard.cjs')

test('documentation parser ignores fenced examples and resolves local links', () => {
  assert.equal(firstLevelHeadingCount('# Real\n\n```md\n# Example\n```\n'), 1)
  assert.deepEqual(relativeLinkTargets('[local](next.md) [web](https://example.test)'), [
    'next.md',
  ])
})

test('documentation check rejects invalid current metadata and broken links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'floating-clock-docs-'))
  try {
    const current = path.join(root, 'docs', 'current')
    fs.mkdirSync(current, { recursive: true })
    fs.writeFileSync(path.join(current, 'invalid.md'), '# Invalid\n\n[missing](missing.md)\n')
    const errors = inspectDocumentation(root)
    assert.equal(errors.some((error) => error.includes('status metadata')), true)
    assert.equal(errors.some((error) => error.includes('missing relative link')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('repository current documentation and relative links follow the active standard', () => {
  assert.deepEqual(inspectDocumentation(path.resolve(__dirname, '..')), [])
})
