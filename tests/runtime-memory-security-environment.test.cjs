const assert = require('node:assert/strict')
const test = require('node:test')
const {
  decodeSecurityCenterState,
  summarizeSecuritySamples,
} = require('../scripts/runtime-memory-security-environment.cjs')

test('Security Center state decoder distinguishes enabled and unknown states', () => {
  assert.deepEqual(decodeSecurityCenterState(0x051000), {
    raw: 0x051000,
    protection: 'enabled',
    signatures: 'up-to-date',
  })
  assert.equal(decodeSecurityCenterState(0x060100).protection, 'unknown')
  assert.equal(decodeSecurityCenterState('invalid').raw, null)
})

test('360 evidence summary is bounded, path-free, and includes process noise', () => {
  const report = summarizeSecuritySamples([
    {
      sampledAt: '2026-01-01T00:00:00Z',
      products: { displayName: '360安全卫士', productState: 0x051000, timestamp: 'now' },
      processes: {
        pid: 1,
        name: '360tray.exe',
        version: '1.2.3',
        workingSetBytes: 100,
        privateBytes: 200,
      },
      services: {
        Name: 'QHActiveDefense',
        DisplayName: '360',
        State: 'Running',
        StartMode: 'Auto',
        Version: '14.0',
      },
    },
  ])
  assert.equal(report.status, 'passed')
  assert.equal(report.processes[0].peakPrivateBytes, 200)
  assert.equal(report.services[0].version, '14.0')
  assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:\\/)
})
