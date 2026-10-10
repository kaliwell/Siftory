const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { findSecretContent } = require('./git-preflight.cjs')
const { findPrivacyIssues } = require('./check-tracked-privacy.cjs')

const COMMIT_PREFIX = '@@COMMIT@@'
const MAX_HISTORY_BYTES = 256 * 1024 * 1024

function runGit(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_HISTORY_BYTES,
  })
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim())
  }
  return result.stdout || ''
}

function auditHistory(repoRoot) {
  const history = runGit(
    [
      'log',
      '--all',
      `--format=${COMMIT_PREFIX}%H`,
      '--patch',
      '--no-color',
      '--',
      'docs',
      '*.md',
      '*.json',
      '*.jsonl',
    ],
    repoRoot,
  )
  const findings = []
  let commit = ''
  let file = ''

  for (const line of history.split(/\r?\n/)) {
    if (line.startsWith(COMMIT_PREFIX)) {
      commit = line.slice(COMMIT_PREFIX.length)
      file = ''
      continue
    }
    if (line.startsWith('+++ b/')) {
      file = line.slice(6)
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('diff --git ') || line.startsWith('@@ '))
      continue
    const content = /^[+ -]/.test(line) ? line.slice(1) : line
    for (const issue of findPrivacyIssues(content)) {
      findings.push({ commit, file, kind: issue.kind, sample: issue.sample })
    }
    for (const kind of findSecretContent(content)) {
      findings.push({ commit, file, kind, sample: '[redacted]' })
    }
  }

  return findings
}

function summarizeFindings(findings) {
  const byKind = {}
  for (const finding of findings) byKind[finding.kind] = (byKind[finding.kind] || 0) + 1
  return { ok: findings.length === 0, count: findings.length, byKind }
}

function main() {
  const repoRoot = path.resolve(runGit(['rev-parse', '--show-toplevel'], process.cwd()).trim())
  const findings = auditHistory(repoRoot)
  const summary = summarizeFindings(findings)
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else if (summary.ok) {
    console.log('[git-history-audit] passed: no personal paths or high-confidence secrets')
  } else {
    console.error(`[git-history-audit] blocked: ${summary.count} historical finding(s)`)
    for (const finding of findings.slice(0, 30)) {
      console.error(
        `- ${finding.commit.slice(0, 12)} ${finding.file || '(unknown file)'}: ${finding.kind}: ${finding.sample}`,
      )
    }
    if (findings.length > 30) console.error(`- ... ${findings.length - 30} more`)
  }
  if (!summary.ok) process.exitCode = 1
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[git-history-audit] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = { auditHistory, summarizeFindings }
