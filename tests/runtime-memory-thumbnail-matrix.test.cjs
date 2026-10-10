'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { summarizeVariant } = require('../scripts/run-runtime-memory-thumbnail-matrix.cjs')

test('thumbnail matrix retains requested and effective lanes with memory evidence', () => {
  const result = summarizeVariant(
    8,
    {
      status: 'passed',
      results: [
        {
          attempts: [
            { memory: { peak: { privateBytes: 10 }, gpu: { peakDeltaMiB: 20, finalUsedMiB: 30 } } },
          ],
        },
      ],
    },
    {
      ok: true,
      thumbnailSourceUnchanged: true,
      runtimeCheck: {
        thumbnailGpu: {
          completed: true,
          total: 16,
          cacheWrites: 16,
          cacheWriteFailures: 0,
          gpuCompleted: 16,
          cpuCompleted: 0,
          fallbackCount: 0,
          gpuJobs: 8,
          gpuLanes: 2,
          peakInFlight: 2,
          elapsedMs: 100,
        },
      },
    },
  )
  assert.equal(result.status, 'passed')
  assert.equal(result.requestedJobs, 8)
  assert.equal(result.effectiveGpuLanes, 2)
  assert.equal(result.peakPrivateBytes, 10)
})

test('thumbnail matrix fails closed on source mutation or cache write failure', () => {
  const result = summarizeVariant(
    1,
    { status: 'passed', results: [{ attempts: [{}] }] },
    {
      ok: true,
      thumbnailSourceUnchanged: false,
      runtimeCheck: {
        thumbnailGpu: { completed: true, total: 1, cacheWrites: 0, cacheWriteFailures: 1 },
      },
    },
  )
  assert.equal(result.status, 'failed')
})

test('thumbnail matrix fails closed when GPU work falls back to CPU', () => {
  const result = summarizeVariant(
    2,
    { status: 'passed', results: [{ attempts: [{}] }] },
    {
      ok: true,
      thumbnailSourceUnchanged: true,
      runtimeCheck: {
        thumbnailGpu: {
          completed: true,
          total: 10,
          cacheWrites: 10,
          cacheWriteFailures: 0,
          gpuCompleted: 9,
          cpuCompleted: 1,
          fallbackCount: 1,
          gpuLanes: 2,
        },
      },
    },
  )
  assert.equal(result.status, 'failed')
})
