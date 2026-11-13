function makePdf() {
  const content = 'q 0.15 0.45 0.85 rg 0 0 320 200 re f Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  const parts = [Buffer.from('%PDF-1.7\n%\x80\x81\x82\x83\n', 'binary')]
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.concat(parts).length)
    parts.push(Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`, 'binary'))
  }
  const xrefOffset = Buffer.concat(parts).length
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    '0000000000 65535 f \n',
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join('')
  parts.push(Buffer.from(xref, 'binary'))
  return Buffer.concat(parts)
}

module.exports = { makePdf }
