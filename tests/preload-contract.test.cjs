const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')

function readSource(relativePath) {
  const absolutePath = path.join(root, relativePath)
  return ts.createSourceFile(
    absolutePath,
    fs.readFileSync(absolutePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  return null
}

function collectInterfaceApiPaths() {
  const source = readSource('shared/ipc/electron-api.ts')
  const paths = new Set()

  function collectTypeLiteral(prefix, members) {
    for (const member of members) {
      if ((!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) || !member.name) continue
      const name = propertyNameText(member.name)
      if (!name) continue
      const nextPrefix = prefix ? `${prefix}.${name}` : name
      if (ts.isMethodSignature(member)) {
        paths.add(nextPrefix)
        continue
      }
      if (!member.type) continue
      if (ts.isTypeLiteralNode(member.type)) {
        collectTypeLiteral(nextPrefix, member.type.members)
      } else if (
        ts.isIntersectionTypeNode(member.type) &&
        member.type.types.some(
          (type) => ts.isImportTypeNode(type) && type.qualifier?.getText() === 'MediaSearchApi',
        )
      ) {
        const domain = readSource('shared/ipc/media-search.ts')
        const declaration = domain.statements.find(
          (statement) =>
            ts.isInterfaceDeclaration(statement) && statement.name.text === 'MediaSearchApi',
        )
        assert.ok(declaration, 'MediaSearchApi contract must exist')
        collectTypeLiteral(nextPrefix, declaration.members)
      } else {
        paths.add(nextPrefix)
      }
    }
  }

  function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'ElectronAPI') {
      collectTypeLiteral('', node.members)
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return paths
}

function collectPreloadApiPaths() {
  const source = readSource('electron/preload.ts')
  const paths = new Set()

  function collectObjectLiteral(prefix, objectLiteral) {
    for (const property of objectLiteral.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) continue
      const name = propertyNameText(property.name)
      if (!name) continue
      const nextPrefix = prefix ? `${prefix}.${name}` : name
      if (ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
        collectObjectLiteral(nextPrefix, property.initializer)
      } else {
        paths.add(nextPrefix)
      }
    }
  }

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'api') {
      if (node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        collectObjectLiteral('', node.initializer)
      }
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return paths
}

test('preload API implementation matches shared ElectronAPI contract', () => {
  const contractPaths = collectInterfaceApiPaths()
  const preloadPaths = collectPreloadApiPaths()

  const missingInPreload = [...contractPaths].filter((entry) => !preloadPaths.has(entry)).sort()
  const missingInContract = [...preloadPaths].filter((entry) => !contractPaths.has(entry)).sort()

  assert.deepEqual(missingInPreload, [])
  assert.deepEqual(missingInContract, [])
})

test('shared IPC contract delegates domain models to bounded modules', () => {
  const contractPath = path.join(root, 'shared', 'ipc-contract.ts')
  const contract = fs.readFileSync(contractPath, 'utf8')
  const lineCount = contract.split(/\r?\n/).length
  assert.ok(
    lineCount < 450,
    `ipc-contract.ts must stay a thin barrel below 450 lines; found ${lineCount}`,
  )
  // The ElectronAPI preload interface lives in its own bounded module so the
  // barrel carries no declarations of its own.
  assert.doesNotMatch(contract, /export interface ElectronAPI/)
  assert.match(contract, /export type \{ ElectronAPI \} from '\.\/ipc\/electron-api'/)
  const electronApiPath = path.join(root, 'shared', 'ipc', 'electron-api.ts')
  assert.match(fs.readFileSync(electronApiPath, 'utf8'), /export interface ElectronAPI/)

  for (const domain of [
    'app-core',
    'app-storage',
    'asset-feedback',
    'asset-library',
    'electron-api',
    'file-manager',
    'image-search',
    'media-search',
    'remote-terminal',
    'subject-search',
  ]) {
    assert.match(contract, new RegExp(`from './ipc/${domain}'`), `${domain} must be re-exported`)
    const domainPath = path.join(root, 'shared', 'ipc', `${domain}.ts`)
    const domainLines = fs.readFileSync(domainPath, 'utf8').split(/\r?\n/).length
    assert.ok(
      domainLines < 800,
      `shared/ipc/${domain}.ts must stay below 800 lines; found ${domainLines}`,
    )
  }

  assert.doesNotMatch(contract, /export interface (?:DupGroup|RemoteTerminalProfile|SubjectBBox)/)
})
