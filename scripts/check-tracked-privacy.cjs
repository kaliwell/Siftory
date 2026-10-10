const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const TEXT_EXTENSIONS = new Set(['.csv', '.json', '.jsonl', '.md', '.tsv', '.txt'])
const GENERIC_USER_NAMES = new Set(['<user>', '<user_home>', '...', 'user', 'username'])

function runGit(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim())
  }
  return result.stdout || ''
}

function trackedTextFiles(repoRoot) {
  return runGit(['ls-files', '-z'], repoRoot)
    .split('\0')
    .filter(Boolean)
    .filter(
      (file) => file.startsWith('docs/') || TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()),
    )
}

function normalizedForInspection(text) {
  return text.replace(/\\\\/g, '\\')
}

function findPrivacyIssues(text) {
  const normalized = normalizedForInspection(text)
  const issues = []
  const rules = [
    {
      kind: 'Windows user directory',
      pattern: /\b[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'`]+)/g,
      accept: (match) => GENERIC_USER_NAMES.has(match[1].toLowerCase()),
    },
    {
      kind: 'Unix user directory',
      pattern: /(?:^|[\s"'`(])(?:\/home|\/Users)\/([^/\s"'`)]+)/gm,
      accept: (match) => GENERIC_USER_NAMES.has(match[1].toLowerCase()),
    },
    {
      kind: 'QQ account directory',
      pattern: /Tencent Files[\\/]\d{5,}(?=[\\/\s"'`]|$)/gi,
    },
    { kind: 'WeChat account directory', pattern: /\bwxid_[A-Za-z0-9_-]{8,}\b/gi },
  ]

  for (const rule of rules) {
    for (const match of normalized.matchAll(rule.pattern)) {
      if (rule.accept?.(match)) continue
      const line = normalized.slice(0, match.index).split('\n').length
      issues.push({ kind: rule.kind, line, sample: match[0].trim() })
    }
  }
  return issues
}

const SEP = String.raw`(?:\\\\|\\|\/)`
const USER = String.raw`[^\\\/\s"'\x60]+`

function replaceRoot(text, segments, replacement) {
  const pattern = new RegExp(
    String.raw`\b[A-Za-z]:${SEP}Users${SEP}(${USER})${SEP}${segments.join(SEP)}`,
    'gi',
  )
  return text.replace(pattern, (match, userName) =>
    GENERIC_USER_NAMES.has(String(userName).toLowerCase()) ? match : replacement,
  )
}

function redactPrivacyPaths(text) {
  let output = text
  output = replaceRoot(output, ['Documents', 'Tencent Files', String.raw`\d{5,}`], '<QQ_DATA>')
  output = replaceRoot(
    output,
    [String.raw`(?:Documents${SEP}WeChat Files|xwechat_files)`, String.raw`wxid_[A-Za-z0-9_-]+`],
    '<WECHAT_DATA>',
  )
  output = replaceRoot(output, ['AppData', 'Roaming', 'floating-clock-electron'], '<APP_DATA>')
  output = replaceRoot(output, ['AppData', 'Local', 'Temp'], '<TEMP_DATA>')
  output = replaceRoot(output, ['Downloads'], '<DATASET>')
  output = replaceRoot(output, ['Desktop', 'x'], '<DATASET>')
  output = output.replace(/\bD:(?:\\\\|\\|\/)PxHereDataset(?:\\\\|\\|\/)images\b/gi, '<DATASET>')
  output = output.replace(
    new RegExp(String.raw`\b[A-Za-z]:${SEP}Users${SEP}(${USER})`, 'gi'),
    (match, userName) =>
      GENERIC_USER_NAMES.has(String(userName).toLowerCase()) ? match : '<USER_HOME>',
  )
  output = output.replace(/Tencent Files(?:\\\\|\\|\/)\d{5,}/gi, 'Tencent Files/<QQ_ACCOUNT>')
  output = output.replace(/\bwxid_[A-Za-z0-9_-]{8,}\b/gi, '<WECHAT_ACCOUNT>')
  return output
}

function scanRepository(repoRoot) {
  const findings = []
  for (const file of trackedTextFiles(repoRoot)) {
    const absolutePath = path.join(repoRoot, file)
    if (!fs.existsSync(absolutePath)) continue
    const text = fs.readFileSync(absolutePath, 'utf8')
    for (const issue of findPrivacyIssues(text)) findings.push({ file, ...issue })
  }
  return findings
}

function redactRepository(repoRoot) {
  let changed = 0
  for (const file of trackedTextFiles(repoRoot)) {
    const absolutePath = path.join(repoRoot, file)
    if (!fs.existsSync(absolutePath)) continue
    const before = fs.readFileSync(absolutePath, 'utf8')
    const after = redactPrivacyPaths(before)
    if (after === before) continue
    fs.writeFileSync(absolutePath, after)
    changed += 1
  }
  return changed
}

function main() {
  const repoRoot = runGit(['rev-parse', '--show-toplevel']).trim()
  if (process.argv.includes('--write')) {
    const changed = redactRepository(repoRoot)
    console.log(`[privacy] redacted ${changed} tracked text file(s)`)
  }
  const findings = scanRepository(repoRoot)
  if (findings.length > 0) {
    console.error(`[privacy] blocked: ${findings.length} personal path/account reference(s)`)
    for (const finding of findings.slice(0, 50)) {
      console.error(`- ${finding.file}:${finding.line}: ${finding.kind}: ${finding.sample}`)
    }
    if (findings.length > 50) console.error(`- ... ${findings.length - 50} more`)
    process.exitCode = 1
    return
  }
  console.log(`[privacy] passed: ${trackedTextFiles(repoRoot).length} tracked text file(s)`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`[privacy] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

module.exports = { findPrivacyIssues, redactPrivacyPaths, trackedTextFiles }
