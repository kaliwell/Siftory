function normalizeExpression(expr: string): string {
  return expr
    .replace(/[\u00d7\u8133]/g, '*')
    .replace(/[\u00f7\u6885]/g, '/')
    .replace(/\u2212|\u922d.?/g, '-')
}

export function safeEval(expr: string): number {
  const input = normalizeExpression(expr)
  let index = 0

  function skipWhitespace(): void {
    while (index < input.length && /\s/.test(input[index])) index += 1
  }

  function parseNumber(): number {
    skipWhitespace()
    const start = index
    let dotSeen = false
    while (index < input.length) {
      const ch = input[index]
      if (ch === '.') {
        if (dotSeen) break
        dotSeen = true
        index += 1
        continue
      }
      if (ch < '0' || ch > '9') break
      index += 1
    }
    if (start === index || input.slice(start, index) === '.') return NaN
    const value = Number(input.slice(start, index))
    return Number.isFinite(value) ? value : NaN
  }

  function parsePrimary(): number {
    skipWhitespace()
    const ch = input[index]
    if (ch === '+') {
      index += 1
      return parsePrimary()
    }
    if (ch === '-') {
      index += 1
      return -parsePrimary()
    }
    if (ch === '(') {
      index += 1
      const value = parseExpression()
      skipWhitespace()
      if (input[index] !== ')') return NaN
      index += 1
      return value
    }
    return parseNumber()
  }

  function parseTerm(): number {
    let value = parsePrimary()
    for (;;) {
      skipWhitespace()
      const op = input[index]
      if (op !== '*' && op !== '/') return value
      index += 1
      const rhs = parsePrimary()
      if (!Number.isFinite(value) || !Number.isFinite(rhs)) return NaN
      if (op === '*') value *= rhs
      else {
        if (rhs === 0) return NaN
        value /= rhs
      }
    }
  }

  function parseExpression(): number {
    let value = parseTerm()
    for (;;) {
      skipWhitespace()
      const op = input[index]
      if (op !== '+' && op !== '-') return value
      index += 1
      const rhs = parseTerm()
      if (!Number.isFinite(value) || !Number.isFinite(rhs)) return NaN
      value = op === '+' ? value + rhs : value - rhs
    }
  }

  if (typeof expr !== 'string' || expr.trim() === '') return NaN
  if (!/^[\d+\-*/().\s\u00d7\u8133\u00f7\u6885\u2212\u922d\ufffd]+$/.test(input)) return NaN
  const result = parseExpression()
  skipWhitespace()
  if (index !== input.length || !Number.isFinite(result)) return NaN
  return result
}
