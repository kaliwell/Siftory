const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const REPO_ROOT = path.resolve(__dirname, '..')
const SOURCE_ROOT = path.join(REPO_ROOT, 'src')
const BASELINE_PATH = path.join(__dirname, 'i18n-visible-text-baseline.json')
const I18N_CORE_PATH = path.join(SOURCE_ROOT, 'i18n', 'core.ts')
const VISIBLE_ATTRIBUTES = new Set(['alt', 'aria-label', 'placeholder', 'title'])
const MESSAGE_CALLS = new Set(['alert', 'confirm', 'setMessage', 'showToast', 'toast'])
const INTENTIONAL_TECHNICAL_TEXT = new Set([
  '/s',
  '0B',
  'AL:',
  'C:',
  'CLIP',
  'CLIP + DINO',
  'DctHash64:',
  'DINO',
  'Diff256:',
  'DiffHash64:',
  'F2',
  'KB',
  '(CJK →',
  '(IoU',
  'S:',
  'T+',
  'V:',
  'd=',
  'del:',
  'ffmpeg:',
  'ffprobe:',
  'GPU:',
  ': GPU',
  '· Auto→CPU',
  '· CPU',
  '· GPU',
  'ms',
  'ovl:',
  'perm',
  'pmap:',
  'rep:',
  's',
  'seg#',
  'src:',
  'v',
  'x',
])
const INTENTIONAL_TECHNICAL_PLACEHOLDERS = new Set(['C:\\Users\\...\\.ssh\\id_rsa', 'root'])
const INTENTIONAL_TECHNICAL_PATTERNS = [
  /^\{[^}]+\}x\{[^}]+\}$/,
  /^· \{[^}]+\}s$/,
  /^(?:Ctrl\+Shift\+Alt\+[QRS]|Shift\+(?:Alt\+[QWE]|Escape)) —$/,
]

function normalizeText(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

function hasHumanText(value) {
  return /[A-Za-z\u3400-\u9fff]/u.test(value)
}

function isIntentionalTechnicalText(kind, value) {
  const normalized = normalizeText(value)
  return (
    INTENTIONAL_TECHNICAL_TEXT.has(normalized) ||
    (kind === 'jsx-attribute:placeholder' &&
      INTENTIONAL_TECHNICAL_PLACEHOLDERS.has(normalized)) ||
    INTENTIONAL_TECHNICAL_PATTERNS.some((pattern) => pattern.test(normalized))
  )
}

function relativeFile(filePath) {
  return path.relative(REPO_ROOT, filePath).replaceAll(path.sep, '/')
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function literalText(node, sourceFile) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return normalizeText(node.text)
  }
  if (ts.isTemplateExpression(node)) {
    const segments = [node.head.text]
    for (const span of node.templateSpans) segments.push('{…}', span.literal.text)
    return normalizeText(segments.join(''))
  }
  return normalizeText(node.getText(sourceFile))
}

function collectExpressionLiterals(node, sourceFile, callback, deep = false) {
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  ) {
    callback(literalText(node, sourceFile), node)
    return
  }
  if (ts.isParenthesizedExpression(node)) {
    collectExpressionLiterals(node.expression, sourceFile, callback, deep)
    return
  }
  if (ts.isConditionalExpression(node)) {
    collectExpressionLiterals(node.whenTrue, sourceFile, callback, deep)
    collectExpressionLiterals(node.whenFalse, sourceFile, callback, deep)
    return
  }
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(node.operatorToken.kind)
  ) {
    collectExpressionLiterals(node.left, sourceFile, callback, deep)
    collectExpressionLiterals(node.right, sourceFile, callback, deep)
    return
  }
  if (deep && ts.isArrayLiteralExpression(node)) {
    for (const element of node.elements) {
      collectExpressionLiterals(element, sourceFile, callback, deep)
    }
    return
  }
  if (deep && ts.isCallExpression(node) && callName(node.expression) !== 't') {
    for (const argument of node.arguments) {
      collectExpressionLiterals(argument, sourceFile, callback, deep)
    }
  }
}

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text
  return ''
}

function jsxTagName(attribute) {
  const attributes = attribute.parent
  const opening = attributes && attributes.parent
  if (!opening || (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening))) {
    return ''
  }
  return opening.tagName.getText()
}

function scanSourceFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const file = relativeFile(filePath)
  const findings = []
  const add = (kind, text, node) => {
    const normalized = normalizeText(text)
    if (!normalized || !hasHumanText(normalized) || isIntentionalTechnicalText(kind, normalized))
      return
    findings.push({ file, kind, text: normalized, line: lineOf(sourceFile, node) })
  }

  function visit(node) {
    if (ts.isJsxText(node)) {
      add('jsx-text', node.text, node)
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      collectExpressionLiterals(node.expression, sourceFile, (text, literal) =>
        add('jsx-expression', text, literal),
      )
    } else if (
      ts.isJsxAttribute(node) &&
      VISIBLE_ATTRIBUTES.has(node.name.text) &&
      !(node.name.text === 'title' && jsxTagName(node) === 'DraggablePanel')
    ) {
      if (node.initializer && ts.isStringLiteral(node.initializer)) {
        add(`jsx-attribute:${node.name.text}`, node.initializer.text, node.initializer)
      } else if (
        node.initializer &&
        ts.isJsxExpression(node.initializer) &&
        node.initializer.expression
      ) {
        collectExpressionLiterals(node.initializer.expression, sourceFile, (text, literal) =>
          add(`jsx-attribute:${node.name.text}`, text, literal),
        )
      }
    } else if (
      ts.isCallExpression(node) &&
      MESSAGE_CALLS.has(callName(node.expression)) &&
      node.arguments[0]
    ) {
      collectExpressionLiterals(
        node.arguments[0],
        sourceFile,
        (text, literal) => add(`message-call:${callName(node.expression)}`, text, literal),
        true,
      )
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return findings
}

function listTsxFiles(directory = SOURCE_ROOT) {
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...listTsxFiles(fullPath))
    else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(fullPath)
  }
  return files.sort()
}

function loadZhTranslationKeys(filePath = I18N_CORE_PATH) {
  const source = fs.readFileSync(filePath, 'utf8')
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  let keys = null
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sourceFile) === 'zhCN' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      keys = new Set(
        node.initializer.properties
          .filter(ts.isPropertyAssignment)
          .map((property) =>
            ts.isIdentifier(property.name) ? property.name.text : property.name.text,
          ),
      )
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!keys) throw new Error('Could not find the zhCN translation dictionary.')
  return keys
}

function scanLiteralTranslationKeys(files = listTsxFiles()) {
  const keys = new Set()
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    )
    function visit(node) {
      if (
        ts.isCallExpression(node) &&
        callName(node.expression) === 't' &&
        node.arguments[0] &&
        (ts.isStringLiteral(node.arguments[0]) ||
          ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
      ) {
        keys.add(node.arguments[0].text)
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return keys
}

function findMissingTranslationKeys(keys, translatedKeys) {
  return [...keys].filter((key) => !translatedKeys.has(key)).sort()
}

function findingKey(finding) {
  return `${finding.file}\0${finding.kind}\0${finding.text}`
}

function fingerprint(finding) {
  return crypto.createHash('sha256').update(findingKey(finding)).digest('hex').slice(0, 16)
}

function groupFindings(findings) {
  const groups = new Map()
  for (const finding of findings) {
    const key = findingKey(finding)
    const current = groups.get(key)
    if (current) {
      current.count++
      current.lines.push(finding.line)
    } else {
      groups.set(key, {
        id: fingerprint(finding),
        file: finding.file,
        kind: finding.kind,
        text: finding.text,
        count: 1,
        lines: [finding.line],
      })
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.lines[0] - b.lines[0] ||
      a.kind.localeCompare(b.kind) ||
      a.text.localeCompare(b.text),
  )
}

function loadBaseline(baselinePath = BASELINE_PATH) {
  const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('Visible-text baseline must contain version 1 and an entries array.')
  }
  for (const entry of parsed.entries) {
    if (
      !entry.id ||
      !entry.file ||
      !entry.kind ||
      !entry.text ||
      !Number.isInteger(entry.count) ||
      entry.count < 1 ||
      !entry.reason ||
      !entry.expiresWhen
    ) {
      throw new Error(`Invalid visible-text baseline entry: ${JSON.stringify(entry)}`)
    }
  }
  return parsed
}

function compareWithBaseline(groups, baseline) {
  const allowed = new Map(baseline.entries.map((entry) => [entry.id, entry]))
  return groups.filter((group) => {
    const entry = allowed.get(group.id)
    return (
      !entry ||
      entry.file !== group.file ||
      entry.kind !== group.kind ||
      entry.text !== group.text ||
      group.count > entry.count
    )
  })
}

function pruneBaseline(groups, baseline) {
  const violations = compareWithBaseline(groups, baseline)
  if (violations.length > 0) {
    throw new Error('Cannot prune while new or expanded visible-text findings exist.')
  }
  const activeIds = new Set(groups.map((group) => group.id))
  return {
    ...baseline,
    entries: baseline.entries.filter((entry) => activeIds.has(entry.id)),
  }
}

function scanProject() {
  return groupFindings(listTsxFiles().flatMap(scanSourceFile))
}

function printFinding(finding) {
  return `${finding.file}:${finding.lines.join(',')} [${finding.kind}] ${JSON.stringify(finding.text)} (${finding.count}x, id=${finding.id})`
}

function main() {
  const groups = scanProject()
  const missingTranslationKeys = findMissingTranslationKeys(
    scanLiteralTranslationKeys(),
    loadZhTranslationKeys(),
  )
  if (process.argv.includes('--report')) {
    console.log(
      JSON.stringify(
        {
          version: 1,
          count: groups.length,
          entries: groups,
          missingTranslationKeys,
        },
        null,
        2,
      ),
    )
    return
  }
  if (missingTranslationKeys.length > 0) {
    console.error(
      `[i18n-visible-text] ${missingTranslationKeys.length} literal t(...) key(s) lack zh-CN translations:`,
    )
    for (const key of missingTranslationKeys) console.error(`- ${JSON.stringify(key)}`)
    process.exitCode = 1
    return
  }
  const baseline = loadBaseline()
  if (process.argv.includes('--prune-baseline')) {
    const pruned = pruneBaseline(groups, baseline)
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(pruned, null, 2)}\n`, 'utf8')
    console.log(
      `[i18n-visible-text] pruned baseline: ${baseline.entries.length} -> ${pruned.entries.length}`,
    )
    return
  }
  const violations = compareWithBaseline(groups, baseline)
  if (violations.length === 0) {
    console.log(
      `[i18n-visible-text] passed: ${groups.length} grandfathered group(s), no new visible hardcoded text`,
    )
    return
  }
  console.error(`[i18n-visible-text] ${violations.length} new or expanded finding(s):`)
  for (const finding of violations) console.error(`- ${printFinding(finding)}`)
  console.error('Wrap user-visible text with t(...), or add a narrow documented baseline entry.')
  process.exitCode = 1
}

if (require.main === module) main()

module.exports = {
  compareWithBaseline,
  findMissingTranslationKeys,
  fingerprint,
  groupFindings,
  loadBaseline,
  loadZhTranslationKeys,
  normalizeText,
  pruneBaseline,
  scanLiteralTranslationKeys,
  scanProject,
  scanSourceFile,
}
