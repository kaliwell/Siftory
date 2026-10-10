const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const SOURCE_ROOTS = ['electron', 'shared', 'src', 'native']
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.cc', '.h', '.cpp', '.cu'])
const EXCLUDED_DIRECTORIES = new Set(['build', 'build-node', 'build-electron', 'node_modules'])
const THIRD_PARTY = new Set(['native/stb_image.h', 'native/stb_image_resize2.h'])
const ENTRY_ORDER = ['electron/main.ts', 'electron/preload.ts', 'src/main.tsx', 'src/App.tsx']
const MAX_SOURCE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function collectSourceFiles(root) {
  const files = []
  const excluded = []
  function visit(relative) {
    const absolute = path.join(root, relative)
    const stat = fs.lstatSync(absolute)
    if (stat.isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${relative}`)
    if (stat.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(path.basename(relative))) return
      for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`)
    } else if (stat.isFile() && EXTENSIONS.has(path.extname(relative))) {
      if (THIRD_PARTY.has(relative))
        excluded.push({ path: relative, reason: 'vendored-third-party' })
      else if (/\.generated\.|\.d\.ts$/.test(relative)) {
        excluded.push({ path: relative, reason: 'generated-or-declaration' })
      } else {
        if (stat.size > MAX_SOURCE_BYTES) throw new Error(`Oversized source file: ${relative}`)
        files.push(relative)
      }
    }
  }
  for (const directory of SOURCE_ROOTS) {
    if (fs.existsSync(path.join(root, directory))) visit(directory)
  }
  const ordered = ENTRY_ORDER.filter((file) => files.includes(file))
  return { files: [...ordered, ...files.filter((file) => !ordered.includes(file))], excluded }
}

function wrapSourceLine(line, maxColumns = 100) {
  const expanded = line.replace(/\t/g, '    ')
  const parts = []
  let current = ''
  let columns = 0
  for (const char of expanded) {
    const width = char.codePointAt(0) > 255 ? 2 : 1
    if (columns + width > maxColumns && current) {
      parts.push(current)
      current = ''
      columns = 0
    }
    current += char
    columns += width
  }
  if (current) parts.push(current)
  return parts
}

function findSubmissionIssues(text) {
  const issues = []
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text))
    issues.push('private-key')
  if (/\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(text)) issues.push('access-token')
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) issues.push('access-key')
  if (/\bsk-[A-Za-z0-9_-]{32,}\b/.test(text)) issues.push('api-key')
  const userPaths = [
    ...text.replace(/\\\\/g, '\\').matchAll(/\b[A-Za-z]:[\\/]Users[\\/]([^\\/\s"'`]+)/gi),
  ]
  const genericUsers = new Set(['...', '<user>', '<user_home>', 'user', 'username', 'public'])
  if (userPaths.some((match) => !genericUsers.has(match[1].toLowerCase()))) {
    issues.push('personal-user-path')
  }
  if (
    [...text].some((char) => char.codePointAt(0) < 32 && ![9, 10, 13].includes(char.codePointAt(0)))
  )
    issues.push('unsupported-control-character')
  return issues
}

function prepareSource(root) {
  root = fs.realpathSync(root)
  const inventory = collectSourceFiles(root)
  const files = []
  const rows = []
  const sourceLines = []
  const findings = []
  let bytes = 0
  let physicalLines = 0
  let nonemptyLines = 0
  for (const relative of inventory.files) {
    const buffer = fs.readFileSync(path.join(root, relative))
    bytes += buffer.length
    if (bytes > MAX_TOTAL_BYTES) throw new Error('Source selection exceeds the byte budget')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    for (const kind of findSubmissionIssues(text)) findings.push({ path: relative, kind })
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    physicalLines += lines.length
    let fileNonemptyLines = 0
    const firstRow = rows.length
    lines.forEach((line, index) => {
      if (line.trim()) fileNonemptyLines += 1
      const display = wrapSourceLine(line)
      if (!display.length) display.push('')
      const entry = {
        file: relative,
        line: index + 1,
        text: line,
        rows: display.map((part, segment) => ({
          file: relative,
          line: index + 1,
          segment,
          text: part,
        })),
      }
      sourceLines.push(entry)
      rows.push(...entry.rows)
    })
    nonemptyLines += fileNonemptyLines
    files.push({
      path: relative,
      bytes: buffer.length,
      sha256: sha256(buffer),
      physicalLines: lines.length,
      nonemptyLines: fileNonemptyLines,
      firstDisplayRow: firstRow + 1,
      displayRows: rows.length - firstRow,
      ownership: 'requires-rightsholder-confirmation',
    })
  }
  if (findings.length)
    throw new Error(`Submission source review required: ${JSON.stringify(findings)}`)
  if (!nonemptyLines) throw new Error('No eligible source code found')
  // Paginate the complete selected source set before extracting its front/back pages.
  // Balanced quotas keep each normal page at >= 50 original nonempty lines without
  // losing blank lines inside template literals/raw strings or slicing a long line.
  const fullPageCount = Math.max(1, Math.floor(nonemptyLines / 50))
  const minimumQuota = Math.floor(nonemptyLines / fullPageCount)
  const extraPages = nonemptyLines % fullPageCount
  const completePages = []
  let at = 0
  for (let page = 0; page < fullPageCount; page++) {
    const quota = minimumQuota + (page < extraPages ? 1 : 0)
    const lines = []
    let count = 0
    while (at < sourceLines.length && (count < quota || page === fullPageCount - 1)) {
      const line = sourceLines[at++]
      lines.push(line)
      if (line.text.trim()) count++
    }
    completePages.push({
      originalPage: page + 1,
      nonemptySourceLines: count,
      sourceLines: lines.map(({ rows: _rows, ...line }) => line),
      rows: lines.flatMap((line) => line.rows),
    })
  }
  const selectedPages =
    fullPageCount <= 60
      ? completePages
      : [...completePages.slice(0, 30), ...completePages.slice(-30)]
  const pages = selectedPages.map((page, index) => ({ page: index + 1, ...page }))
  return {
    schema: 'siftory-copyright-source/v1',
    status: 'review-candidate-not-submitted',
    layout: {
      minimumNonemptySourceLinesPerPage: 50,
      maxDisplayColumns: 100,
      tabs: 'four-spaces',
      blankLines: 'preserved-including-whitespace-inside-literals',
      wrappedLines: 'layout-only-never-split-original-line-across-pages',
    },
    selection:
      fullPageCount <= 60
        ? 'complete-selected-source-set'
        : 'first-and-last-30-pages-of-complete-selected-source-set',
    declaration:
      'File ordering and hashes identify this candidate; inclusion does not establish copyright ownership. Third-party components are documented separately.',
    sourceSha256: sha256(files.map((file) => `${file.path}\0${file.sha256}\n`).join('')),
    totals: {
      files: files.length,
      bytes,
      physicalLines,
      nonemptyLines,
      displayRows: rows.length,
      fullSelectedSourcePages: fullPageCount,
      selectedDisplayRows: pages.reduce((sum, page) => sum + page.rows.length, 0),
      selectedPhysicalLines: pages.reduce((sum, page) => sum + page.sourceLines.length, 0),
      selectedNonemptySourceLines: pages.reduce((sum, page) => sum + page.nonemptySourceLines, 0),
      pages: pages.length,
    },
    excluded: inventory.excluded,
    files,
    pages,
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--output-dir')
    throw new Error('Usage: node scripts/prepare-copyright-source.cjs --output-dir <new-directory>')
  const destination = path.resolve(args[1])
  if (fs.existsSync(destination))
    throw new Error('Output directory already exists; use a fresh candidate directory')
  const result = prepareSource(path.resolve(__dirname, '..'))
  fs.mkdirSync(destination, { recursive: true })
  fs.writeFileSync(
    path.join(destination, 'source-selection.json'),
    `${JSON.stringify(result, null, 2)}\n`,
  )
  fs.writeFileSync(
    path.join(destination, 'source-selected.txt'),
    `${result.pages.flatMap((page) => page.sourceLines.map((line) => line.text)).join('\n')}\n`,
  )
  process.stdout.write(
    `${JSON.stringify({ sourceSha256: result.sourceSha256, ...result.totals })}\n`,
  )
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { collectSourceFiles, wrapSourceLine, findSubmissionIssues, prepareSource }
