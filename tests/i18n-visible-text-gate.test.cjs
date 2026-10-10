const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  compareWithBaseline,
  findMissingTranslationKeys,
  fingerprint,
  groupFindings,
  loadBaseline,
  loadZhTranslationKeys,
  pruneBaseline,
  scanLiteralTranslationKeys,
  scanProject,
  scanSourceFile,
} = require('../scripts/check-visible-i18n.cjs')

function withTsx(source, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-visible-gate-'))
  const filePath = path.join(directory, 'Fixture.tsx')
  fs.writeFileSync(filePath, source)
  try {
    return callback(filePath)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('visible-text scanner detects JSX, visible attributes, and direct message calls', () => {
  withTsx(
    `const View = () => (
      <section title="Raw title">
        Raw JSX
        {'Raw expression'}
        <input placeholder="Raw placeholder" />
        <button onClick={() => showToast('Raw toast')}>Run</button>
      </section>
    )`,
    (filePath) => {
      const findings = scanSourceFile(filePath)
      assert.deepEqual(
        findings.map(({ kind, text }) => ({ kind, text })),
        [
          { kind: 'jsx-attribute:title', text: 'Raw title' },
          { kind: 'jsx-text', text: 'Raw JSX' },
          { kind: 'jsx-expression', text: 'Raw expression' },
          { kind: 'jsx-attribute:placeholder', text: 'Raw placeholder' },
          { kind: 'message-call:showToast', text: 'Raw toast' },
          { kind: 'jsx-text', text: 'Run' },
        ],
      )
    },
  )
})

test('translated calls, technical terms, data attributes, and non-human symbols are ignored', () => {
  withTsx(
    `const View = () => (
      <section data-testid="stable-command" title={t('Open')}>
        {t('Run')} ···
        <span>DINO</span><span>CLIP</span><span>ms</span><span>/s</span><span>T+</span><span>x</span>
        <button onClick={() => showToast(t('Done'))}>{t('Done')}</button>
      </section>
    )`,
    (filePath) => assert.deepEqual(scanSourceFile(filePath), []),
  )
})

test('baseline pruning removes only resolved entries and refuses new findings', () => {
  const current = groupFindings([
    { file: 'src/Current.tsx', kind: 'jsx-text', text: 'Current debt', line: 1 },
  ])
  const baseline = {
    version: 1,
    entries: [
      {
        ...current[0],
        reason: 'Existing visible text awaiting migration.',
        expiresWhen: 'Remove after the current surface adopts translation.',
      },
      {
        id: 'resolved-id',
        file: 'src/Resolved.tsx',
        kind: 'jsx-text',
        text: 'Resolved debt',
        count: 1,
        reason: 'Existing visible text awaiting migration.',
        expiresWhen: 'Remove after the resolved surface adopts translation.',
      },
    ],
  }
  assert.deepEqual(pruneBaseline(current, baseline).entries.map((entry) => entry.id), [current[0].id])
  assert.throws(
    () => pruneBaseline([{ ...current[0], count: current[0].count + 1 }], baseline),
    /Cannot prune/,
  )
})

test('baseline permits only the exact documented occurrence count', () => {
  const finding = {
    file: 'src/Fixture.tsx',
    kind: 'jsx-text',
    text: 'Legacy visible text',
    line: 8,
  }
  const group = groupFindings([finding])[0]
  const baseline = {
    version: 1,
    entries: [
      {
        id: fingerprint(finding),
        file: finding.file,
        kind: finding.kind,
        text: finding.text,
        count: 1,
        reason: 'Legacy surface awaiting migration.',
        expiresWhen: 'Remove when Fixture adopts useTranslation.',
      },
    ],
  }
  assert.deepEqual(compareWithBaseline([group], baseline), [])
  assert.equal(compareWithBaseline([{ ...group, count: 2 }], baseline).length, 1)
  assert.equal(compareWithBaseline([{ ...group, text: 'Changed text' }], baseline).length, 1)
})

test('repository grandfathered baseline stays empty after migration', () => {
  const baseline = loadBaseline()
  assert.deepEqual(baseline.entries, [])
})

test('repository has no visible hardcoded text beyond the exact baseline', () => {
  assert.deepEqual(compareWithBaseline(scanProject(), loadBaseline()), [])
})

test('every literal renderer translation key has a zh-CN entry', () => {
  assert.deepEqual(
    findMissingTranslationKeys(scanLiteralTranslationKeys(), loadZhTranslationKeys()),
    [],
  )
})
