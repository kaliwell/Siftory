const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { pathToFileURL } = require('node:url')

async function fixture(run) {
  const temp = path.resolve(os.tmpdir())
  const root = fs.mkdtempSync(path.join(temp, 'siftory-bundle-evidence-'))
  const output = path.join(root, 'output')
  const write = (name, content) => {
    const target = path.join(root, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  const packageFile = (folder, name, version, value) => {
    write(folder + '/package.json', JSON.stringify({ name, version, license: 'MIT' }))
    write(folder + '/index.js', `export const value = ${JSON.stringify(value)};`)
  }
  packageFile('node_modules/@example/dep', '@example/dep', '1.0.0', 'main-dependency')
  packageFile(
    'node_modules/host/node_modules/@example/dep',
    '@example/dep',
    '2.0.0',
    'nested-dependency',
  )
  packageFile('node_modules/unused', 'unused', '1.0.0', 'unused-dependency')
  write(
    'entry.js',
    `
    import { value } from './node_modules/@example/dep/index.js';
    import { value as removed } from './node_modules/unused/index.js';
    import fs from 'node:fs';
    import runtime from 'external-runtime';
    console.log(value, typeof fs, typeof runtime);
    export const lazy = () => import('./lazy.js');
  `,
  )
  write(
    'lazy.js',
    `export { value } from './node_modules/host/node_modules/@example/dep/index.js';`,
  )
  const { rollup } = require('rollup')
  const api = await import(pathToFileURL(path.join(__dirname, '../scripts/bundle-provenance.mjs')))
  const build = async (extra = {}) => {
    const bundle = await rollup({
      input: path.join(root, 'entry.js'),
      external: ['node:fs', 'external-runtime'],
      plugins: [
        ...(extra.plugins || []),
        api.bundleProvenance({ rootDir: root, buildId: extra.buildId || 'fixture' }),
      ],
    })
    try {
      return await bundle.write({ dir: output, format: 'es', ...extra.output })
    } finally {
      await bundle.close()
    }
  }
  try {
    await run({ root, output, write, build, ...api })
  } finally {
    assert.equal(path.dirname(path.resolve(root)), temp)
    assert.ok(path.basename(root).startsWith('siftory-bundle-evidence-'))
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('actual Rollup output separates retained dependencies, removed code and runtime imports', async () => {
  await fixture(async ({ root, output, build, inspectBundleProvenance }) => {
    await build()
    const file = path.join(output, '.vite/third-party-fixture.json')
    const text = fs.readFileSync(file, 'utf8')
    const report = JSON.parse(text)
    assert.equal(report.completeRecursiveSbom, false)
    assert.equal(report.approvalGranted, false)
    assert.equal(report.chunks.length, 2)
    assert.deepEqual(
      report.packages.map((p) => [p.path, p.name, p.version, p.hasRenderedCode]),
      [
        ['node_modules/@example/dep', '@example/dep', '1.0.0', true],
        ['node_modules/host/node_modules/@example/dep', '@example/dep', '2.0.0', true],
      ],
    )
    assert.ok(
      report.packages.every(
        (p) => p.declaredLicense === 'MIT' && /^[a-f0-9]{64}$/.test(p.packageJsonSha256),
      ),
    )
    const imports = report.chunks.flatMap((chunk) => chunk.imports)
    assert.ok(imports.some((record) => record.id === 'node:fs' && record.kind === 'node-builtin'))
    assert.ok(
      imports.some(
        (record) =>
          record.id === 'external-runtime' && record.kind === 'external-or-runtime-import',
      ),
    )
    assert.ok(imports.some((record) => record.kind === 'output-chunk'))
    assert.equal(text.includes(root), false)
    assert.equal(text.includes(root.replaceAll('\\', '/')), false)
    assert.equal(text.includes('unused-dependency'), false)
    const validation = inspectBundleProvenance(output)
    assert.equal(validation.ok, true, validation.errors.join('\n'))
    assert.equal(validation.scriptCount, 2)
    await build()
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'same inputs produce stable evidence')
  })
})

test('changed, omitted and stale output scripts are rejected against emitted module evidence', async () => {
  await fixture(async ({ output, build, inspectBundleProvenance }) => {
    await build()
    const report = JSON.parse(
      fs.readFileSync(path.join(output, '.vite/third-party-fixture.json'), 'utf8'),
    )
    const target = path.join(output, report.chunks[0].file)
    const original = fs.readFileSync(target)
    fs.appendFileSync(target, '\nconsole.log("altered");')
    assert.ok(
      inspectBundleProvenance(output).errors.some((error) => error.includes('differs from')),
    )
    fs.unlinkSync(target)
    assert.ok(
      inspectBundleProvenance(output).errors.some((error) => error.includes('Missing recorded')),
    )
    fs.writeFileSync(target, original)
    fs.writeFileSync(path.join(output, 'leftover.js'), 'console.log("old build")')
    assert.ok(
      inspectBundleProvenance(output).errors.some((error) =>
        error.includes('lacks module evidence'),
      ),
    )
  })
})

test('outside-root virtual IDs are opaque and malformed output paths cannot escape the directory', async () => {
  await fixture(async ({ output, write, build, inspectBundleProvenance }) => {
    write('entry.js', `import { value } from 'injected'; console.log(value);`)
    const privateId = '\0' + path.join(os.tmpdir(), 'private-outside-project', 'module.js')
    await build({
      plugins: [
        {
          name: 'fixture-virtual',
          resolveId(id) {
            if (id === 'injected') return privateId
          },
          load(id) {
            if (id === privateId) return 'export const value = 5;'
          },
        },
      ],
    })
    const file = path.join(output, '.vite/third-party-fixture.json')
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.ok(report.chunks[0].modules.some((m) => m.virtual && m.id.startsWith('opaque:')))
    assert.equal(JSON.stringify(report).includes('private-outside-project'), false)
    for (const unsafe of ['../secret.js', '/secret.js', 'C:/secret.js', 'x\\..\\secret.js']) {
      report.chunks[0].file = unsafe
      fs.writeFileSync(file, JSON.stringify(report))
      assert.ok(
        inspectBundleProvenance(output).errors.some((error) => error.includes('Unsafe chunk path')),
        unsafe,
      )
    }
    report.approvalGranted = true
    fs.writeFileSync(file, JSON.stringify(report))
    assert.ok(
      inspectBundleProvenance(output).errors.some((error) =>
        error.includes('Invalid provenance schema'),
      ),
    )
  })
})

test('matching output hashes cannot replace complete module and package evidence', async (t) => {
  await fixture(async ({ output, build, inspectBundleProvenance }) => {
    await build()
    const file = path.join(output, '.vite/third-party-fixture.json')
    const original = JSON.parse(fs.readFileSync(file, 'utf8'))
    const firstPackageModule = (report) =>
      report.chunks.flatMap((chunk) => chunk.modules).find((module) => module.packagePath)
    const firstImport = (report, kind) =>
      report.chunks.flatMap((chunk) => chunk.imports).find((entry) => entry.kind === kind)
    const cases = [
      [
        'missing build ID',
        (report) => {
          delete report.buildId
        },
      ],
      [
        'mismatched report filename',
        (report) => {
          report.buildId = 'another-build'
        },
      ],
      [
        'missing format',
        (report) => {
          delete report.format
        },
      ],
      [
        'unsupported format',
        (report) => {
          report.format = 'unknown'
        },
      ],
      [
        'missing scope',
        (report) => {
          delete report.scope
        },
      ],
      [
        'missing packages',
        (report) => {
          delete report.packages
        },
      ],
      [
        'missing modules',
        (report) => {
          delete report.chunks[0].modules
        },
      ],
      [
        'missing imports',
        (report) => {
          delete report.chunks[0].imports
        },
      ],
      [
        'missing entry flag',
        (report) => {
          delete report.chunks[0].isEntry
        },
      ],
      [
        'duplicate chunk',
        (report) => {
          report.chunks.push(structuredClone(report.chunks[0]))
        },
      ],
      [
        'duplicate package',
        (report) => {
          report.packages.push(structuredClone(report.packages[0]))
        },
      ],
      [
        'missing license declaration',
        (report) => {
          delete report.packages[0].declaredLicense
        },
      ],
      [
        'missing metadata hash',
        (report) => {
          delete report.packages[0].packageJsonSha256
        },
      ],
      [
        'malformed package hash',
        (report) => {
          report.packages[0].packageJsonSha256 = 'not-a-digest'
        },
      ],
      [
        'missing package version',
        (report) => {
          delete report.packages[0].version
        },
      ],
      [
        'missing rendered flag',
        (report) => {
          delete report.packages[0].hasRenderedCode
        },
      ],
      [
        'inconsistent rendered flag',
        (report) => {
          report.packages[0].hasRenderedCode = false
        },
      ],
      [
        'orphan package',
        (report) => {
          report.packages.push({ ...report.packages[0], path: 'node_modules/orphan' })
        },
      ],
      [
        'unknown package reference',
        (report) => {
          firstPackageModule(report).packagePath = 'node_modules/unknown'
        },
      ],
      [
        'missing virtual flag',
        (report) => {
          delete firstPackageModule(report).virtual
        },
      ],
      [
        'negative rendered length',
        (report) => {
          firstPackageModule(report).renderedLength = -1
        },
      ],
      [
        'missing original length',
        (report) => {
          delete firstPackageModule(report).originalLength
        },
      ],
      [
        'null module',
        (report) => {
          report.chunks[0].modules.push(null)
        },
      ],
      [
        'duplicate module',
        (report) => {
          report.chunks[0].modules.push(structuredClone(report.chunks[0].modules[0]))
        },
      ],
      [
        'unknown import kind',
        (report) => {
          firstImport(report, 'node-builtin').kind = 'bundled'
        },
      ],
      [
        'missing output chunk reference',
        (report) => {
          firstImport(report, 'output-chunk').id = 'missing.js'
        },
      ],
      [
        'false builtin classification',
        (report) => {
          firstImport(report, 'node-builtin').id = 'external-package'
        },
      ],
      [
        'false external classification',
        (report) => {
          firstImport(report, 'node-builtin').kind = 'external-or-runtime-import'
        },
      ],
    ]
    for (const [label, mutate] of cases) {
      await t.test(label, () => {
        const report = structuredClone(original)
        mutate(report)
        fs.writeFileSync(file, JSON.stringify(report))
        const result = inspectBundleProvenance(output)
        assert.equal(result.ok, false)
        assert.ok(
          result.errors.some((error) => error.includes('Invalid provenance schema')),
          result.errors.join('\n'),
        )
      })
    }
    fs.writeFileSync(file, JSON.stringify(original))
    assert.equal(inspectBundleProvenance(output).ok, true)
  })
})

test('virtual query and encoded paths remain opaque without losing their module classification', async () => {
  await fixture(async ({ output, write, build, inspectBundleProvenance }) => {
    write('entry.js', `import { value } from 'injected'; console.log(value);`)
    for (const privateId of [
      '\0commonjs-proxy?file=/home/private-user/secret.js',
      '\0virtual?file=%2Fhome%2Fprivate-user%2Fsecret.js',
      '\0virtual?file=C:\\Users\\private-user\\secret.js',
      '\0virtual:{"file":"/home/private-user/secret.js"}',
    ]) {
      await build({
        plugins: [
          {
            name: 'fixture-private-virtual',
            resolveId(id) {
              if (id === 'injected') return privateId
            },
            load(id) {
              if (id === privateId) return 'export const value = 5;'
            },
          },
        ],
      })
      const text = fs.readFileSync(path.join(output, '.vite/third-party-fixture.json'), 'utf8')
      const report = JSON.parse(text)
      assert.equal(text.includes('private-user'), false)
      assert.ok(
        report.chunks[0].modules.some(
          (module) => module.virtual && /^opaque:[a-f0-9]{20}$/.test(module.id),
        ),
      )
      assert.equal(inspectBundleProvenance(output).ok, true)
    }
  })
})
