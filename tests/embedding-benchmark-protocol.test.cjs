const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { runModel } = require('./image-search-simple-embedding-benchmark.cjs')

test('embedding benchmark consumes fragmented binary results and actual provider telemetry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siftory-benchmark-protocol-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const childPath = path.join(root, 'fixture.cjs')
  const modelPath = path.join(root, 'fixture.onnx')
  fs.writeFileSync(modelPath, 'not a model; fixture child does not load it')
  const guardPath = path.join(__dirname, 'guard-utils.cjs')
  fs.writeFileSync(
    childPath,
    `
    const {loadTsModule}=require(${JSON.stringify(guardPath)});
    const {encodeEmbeddingChildFrame}=loadTsModule('electron/embeddingChildBinaryProtocol.ts');
    const ready=encodeEmbeddingChildFrame({type:'ready'});
    process.stdout.write(ready.subarray(0,5));
    setTimeout(()=>process.stdout.write(ready.subarray(5)),10);
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const task=JSON.parse(line);
      process.stdout.write(Buffer.concat([
        encodeEmbeddingChildFrame({type:'provider-selected',model:'dino',requestedBackend:'gpu',selectedProvider:'dml',fallback:false,reason:'session-created'}),
        encodeEmbeddingChildFrame({id:task.id,ok:true,vectorEncoding:'float64le'},[1,0])
      ]));
    });
  `,
  )
  const result = await runModel(
    { name: 'dino', dim: 2, childPath, modelPath },
    ['synthetic-one.jpg', 'synthetic-two.jpg'],
    {
      jobs: 1,
      batchSize: 2,
      backend: 'gpu',
      tensorPrefetch: false,
      stageMetrics: false,
      timeoutMs: 15_000,
      childrenDir: root,
    },
  )
  assert.deepEqual(result.vectors, [
    [1, 0],
    [1, 0],
  ])
  assert.equal(result.report.images, 2)
  assert.equal(result.report.providerSelections[0].selectedProvider, 'dml')
  assert.equal(result.report.providerSelections[0].fallback, false)
})
