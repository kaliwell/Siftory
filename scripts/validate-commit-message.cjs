const fs = require('node:fs')

const HEADER_PATTERN =
  /^(feat|fix|perf|refactor|test|docs|build|ci|chore|revert)(?:\([a-z0-9][a-z0-9-]*\))?: (.{2,})$/

function validate(message) {
  const lines = message.replace(/\r\n/g, '\n').split('\n')
  const header = (
    lines.find((line) => line.trim() && !line.trimStart().startsWith('#')) || ''
  ).trim()
  const errors = []

  if (/\bWIP\b/i.test(header)) errors.push('WIP commits are not allowed')
  if (header.length > 100) errors.push('header exceeds 100 characters')
  const match = HEADER_PATTERN.exec(header)
  if (!match) {
    errors.push('header must be type: summary or type(scope): summary')
  }

  return errors
}

function selfTest() {
  const valid = 'fix: simplify commit validation'
  if (validate(valid).length !== 0) throw new Error('valid message was rejected')
  for (const invalid of ['WIP', 'Merge bypass']) {
    if (validate(invalid).length === 0) throw new Error(`invalid message was accepted: ${invalid}`)
  }
  console.log('[commit-msg] self-test passed')
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const messagePath = process.argv[2]
  if (!messagePath) throw new Error('commit message file path is required')
  const errors = validate(fs.readFileSync(messagePath, 'utf8'))
  if (errors.length === 0) return
  console.error('[commit-msg] blocked:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[commit-msg] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = { validate }
