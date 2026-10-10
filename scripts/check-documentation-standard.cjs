const fs = require('node:fs')
const path = require('node:path')

const ALLOWED_CURRENT_STATUSES = new Set(['当前', '草案', '部分实施', '历史快照', '已替代'])

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(target)
    return entry.name.endsWith('.md') ? [target] : []
  })
}

function firstLevelHeadingCount(source) {
  let fenced = false
  let count = 0
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    if (!fenced && /^# /.test(line)) count += 1
  }
  return count
}

function relativeLinkTargets(source) {
  const targets = []
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g
  for (const match of source.matchAll(linkPattern)) {
    let target = match[1].trim().replace(/^<|>$/g, '').split('#')[0]
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue
    try {
      target = decodeURIComponent(target)
    } catch {
      // An undecodable local target is reported as missing below.
    }
    targets.push(target)
  }
  return targets
}

function inspectDocumentation(projectRoot) {
  const docsRoot = path.join(projectRoot, 'docs')
  const errors = []
  for (const filePath of markdownFiles(docsRoot)) {
    const source = fs.readFileSync(filePath, 'utf8')
    const relativePath = path.relative(projectRoot, filePath).split(path.sep).join('/')
    const headingCount = firstLevelHeadingCount(source)
    if (headingCount !== 1) errors.push(`${relativePath}: expected 1 H1, received ${headingCount}`)

    if (relativePath.startsWith('docs/current/')) {
      const status = source.match(/^> 状态：(\S+)\s*$/m)?.[1]
      if (!status || !ALLOWED_CURRENT_STATUSES.has(status)) {
        errors.push(`${relativePath}: missing or invalid current-document status metadata`)
      }
    }

    for (const target of relativeLinkTargets(source)) {
      if (!fs.existsSync(path.resolve(path.dirname(filePath), target))) {
        errors.push(`${relativePath}: missing relative link target ${target}`)
      }
    }
  }
  return errors
}

function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const errors = inspectDocumentation(projectRoot)
  if (errors.length > 0) {
    console.error(`[docs] blocked: ${errors.length} issue(s)`)
    for (const error of errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log('[docs] passed: current metadata, H1 structure, and relative links')
}

if (require.main === module) main()

module.exports = {
  firstLevelHeadingCount,
  inspectDocumentation,
  relativeLinkTargets,
}
