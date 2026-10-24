const { isIP } = require('node:net')

// Documentation networks (RFC 5737), loopback and private examples are safe fixtures.
function isExampleAddress(address) {
  const [a, b] = address.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    address.startsWith('192.0.2.') ||
    address.startsWith('198.51.100.') ||
    address.startsWith('203.0.113.')
  )
}

function findPublicEndpoints(text) {
  const findings = []
  const pattern = /(?:[A-Za-z_][\w.-]*@|@)((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/g
  for (const match of text.matchAll(pattern)) {
    if (isIP(match[1]) !== 4 || isExampleAddress(match[1])) continue
    findings.push({
      kind: 'public SSH endpoint',
      line: text.slice(0, match.index).split('\n').length,
      sample: '[redacted endpoint]',
    })
  }
  return findings
}

module.exports = { findPublicEndpoints }
