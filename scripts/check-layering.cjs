#!/usr/bin/env node
// ── Layer governance (VAL-033) ─────────────────────────────
// Enforces the module layering contract:
//   shared/   bottom layer — must not import electron/, src/, or the bare
//             'electron' package;
//   electron/ main process — may import shared/, must not import src/;
//   src/      renderer     — may import shared/, must not import electron/.
// Cross-layer references sneak coupling past the IPC contract; fail the
// build the moment one appears.

const fs = require('fs')
const path = require('path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const LAYERS = ['shared', 'electron', 'src']

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') walk(full, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function specifiers(file) {
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const specs = []
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specs.push(node.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specs.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specs
}

function layerOf(absolutePath) {
  const first = path.relative(root, absolutePath).split(path.sep)[0]
  return LAYERS.includes(first) ? first : null
}

const violations = []
let scanned = 0
for (const layer of LAYERS) {
  for (const file of walk(path.join(root, layer))) {
    scanned += 1
    for (const spec of specifiers(file)) {
      if (layer === 'shared' && spec === 'electron') {
        violations.push(`${path.relative(root, file)} imports the bare 'electron' package`)
        continue
      }
      if (!spec.startsWith('.')) continue
      const targetLayer = layerOf(path.resolve(path.dirname(file), spec))
      if (!targetLayer || targetLayer === layer) continue
      const banned =
        (layer === 'shared' && (targetLayer === 'electron' || targetLayer === 'src')) ||
        (layer === 'electron' && targetLayer === 'src') ||
        (layer === 'src' && targetLayer === 'electron')
      if (banned) {
        violations.push(
          `${path.relative(root, file)} (${layer}/) imports '${spec}' (${targetLayer}/)`,
        )
      }
    }
  }
}

if (violations.length > 0) {
  console.error('[layering] cross-layer import violations:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(`[layering] OK — ${scanned} modules scanned, no cross-layer imports`)
}
