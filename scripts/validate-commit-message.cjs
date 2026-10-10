const fs = require('node:fs')

const HEADER_PATTERN =
  /^(feat|fix|perf|refactor|test|docs|build|ci|chore|revert)\([a-z0-9][a-z0-9-]*\): (.{2,})$/
const REQUIRED_TRAILERS = ['Executor-System', 'Executor-Model', 'Task', 'Validation']
const ALLOWED_EXECUTOR_SYSTEMS = new Set(['Codex', 'Kimi', 'Claude', 'Gemini', 'Human', 'Mixed'])

function trailerValues(lines, name) {
  return lines
    .filter((line) => line.startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1).trim())
}

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
    errors.push('header must be <type>(<lowercase-kebab-scope>): <summary>')
  } else if (/[。.]$/.test(match[2])) {
    errors.push('summary must not end with a period')
  }

  for (const trailer of REQUIRED_TRAILERS) {
    const values = trailerValues(lines, trailer)
    if (values.length !== 1) {
      errors.push(`${trailer} trailer must appear exactly once`)
      continue
    }
    if (!values[0] || /[<>]/.test(values[0])) {
      errors.push(`${trailer} trailer is required and must be filled`)
    }
  }

  const executorSystems = trailerValues(lines, 'Executor-System')
  if (executorSystems.length === 1 && !ALLOWED_EXECUTOR_SYSTEMS.has(executorSystems[0])) {
    errors.push(`Executor-System must be one of: ${[...ALLOWED_EXECUTOR_SYSTEMS].join(', ')}`)
  }
  const tasks = trailerValues(lines, 'Task')
  if (tasks.length === 1 && tasks[0].length > 100)
    errors.push('Task trailer exceeds 100 characters')
  const validations = trailerValues(lines, 'Validation')
  if (validations.length === 1 && validations[0].length < 3) {
    errors.push('Validation trailer is too short to be meaningful')
  }
  return errors
}

function selfTest() {
  const valid = `fix(repo): validate commit metadata\n\nExecutor-System: Codex\nExecutor-Model: GPT-5 series\nTask: git-policy\nValidation: self-test passed\n`
  if (validate(valid).length !== 0) throw new Error('valid message was rejected')
  for (const invalid of [
    'WIP',
    'Merge bypass',
    `fix(repo): invalid system\n\nExecutor-System: Other\nExecutor-Model: x\nTask: x\nValidation: passed`,
    `${valid}Executor-System: Kimi\n`,
  ]) {
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

module.exports = { ALLOWED_EXECUTOR_SYSTEMS, validate }
