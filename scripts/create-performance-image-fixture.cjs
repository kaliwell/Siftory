'use strict'
const fs = require('fs'),
  path = require('path'),
  crypto = require('crypto')
const { createCanvas } = require('@napi-rs/canvas')
const dir = path.resolve('artifacts/benchmark/image-fixture-20261107')
fs.mkdirSync(dir, { recursive: true })
const templates = []
for (let i = 0; i < 64; i++) {
  const canvas = createCanvas(1200, 800),
    c = canvas.getContext('2d')
  const g = c.createLinearGradient(0, 0, 1200, 800)
  g.addColorStop(0, `hsl(${(i * 47) % 360},65%,35%)`)
  g.addColorStop(1, `hsl(${(i * 47 + 90) % 360},55%,70%)`)
  c.fillStyle = g
  c.fillRect(0, 0, 1200, 800)
  for (let j = 0; j < 30; j++) {
    c.fillStyle = `hsla(${(i * 71 + j * 11) % 360},60%,60%,0.6)`
    c.fillRect((j * 137 + i * 23) % 1150, (j * 79 + i * 37) % 750, 40 + j * 3, 50 + j * 2)
  }
  templates.push(canvas.toBuffer('image/jpeg', 90))
}
const files = []
for (let i = 0; i < 10000; i++) {
  const name = String(i).padStart(5, '0') + '.jpg',
    bytes = templates[i % 64]
  fs.writeFileSync(path.join(dir, name), bytes)
  files.push({ name, sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
}
fs.writeFileSync(
  path.join(dir, 'manifest.json'),
  JSON.stringify(
    {
      scope:
        'Deterministic generated JPEG fixture, 1200x800 quality 90; 64 image patterns over 10000 paths; not a representative real photo library.',
      files,
    },
    null,
    2,
  ),
)
console.log(JSON.stringify({ dir, files: files.length }))
