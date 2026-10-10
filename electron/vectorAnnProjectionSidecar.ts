import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { VECTOR_ANN_VERSION, type VectorAnnBufferSegment } from './vectorAnnIndex'

interface ProjectionSidecarMeta {
  version: number
  sourceIdentity: string
  count: number
  dim: number
  projectionDimensions: number[]
  projectionInverseScales: number[]
  valuesSha256: string
  createdAt: number
}

export interface VectorAnnProjectionSidecar {
  dimensions: Uint16Array
  inverseScales: Float32Array
  values: Buffer
}

export function vectorAnnProjectionSidecarPaths(vectorPath: string): {
  meta: string
  values: string
} {
  const base = path.basename(vectorPath, path.extname(vectorPath))
  const directory = path.dirname(vectorPath)
  return {
    meta: path.join(directory, `${base}.ann-q8-v${VECTOR_ANN_VERSION}.json`),
    values: path.join(directory, `${base}.ann-q8-v${VECTOR_ANN_VERSION}.bin`),
  }
}

function replaceDerivedFile(temporary: string, target: string): void {
  try {
    fs.renameSync(temporary, target)
  } catch {
    try {
      fs.unlinkSync(target)
    } catch {
      // Target may not exist.
    }
    fs.renameSync(temporary, target)
  }
}

function validProjectionMeta(meta: ProjectionSidecarMeta, dim: number): boolean {
  if (
    meta.version !== VECTOR_ANN_VERSION ||
    !Number.isSafeInteger(meta.count) ||
    meta.count < 0 ||
    meta.dim !== dim ||
    !Array.isArray(meta.projectionDimensions) ||
    meta.projectionDimensions.length === 0 ||
    meta.projectionDimensions.length !== meta.projectionInverseScales?.length ||
    !/^[a-f0-9]{64}$/.test(meta.valuesSha256)
  ) {
    return false
  }
  const seen = new Set<number>()
  for (let index = 0; index < meta.projectionDimensions.length; index++) {
    const dimension = meta.projectionDimensions[index]
    const scale = meta.projectionInverseScales[index]
    if (
      !Number.isInteger(dimension) ||
      dimension < 0 ||
      dimension >= dim ||
      seen.has(dimension) ||
      !Number.isFinite(scale) ||
      scale <= 0
    ) {
      return false
    }
    seen.add(dimension)
  }
  return true
}

export function readVectorAnnProjectionSidecar(
  files: { meta: string; values: string },
  expected: { sourceIdentity: string; count: number; dim: number },
): VectorAnnProjectionSidecar | null {
  try {
    const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8')) as ProjectionSidecarMeta
    if (
      !validProjectionMeta(meta, expected.dim) ||
      meta.sourceIdentity !== expected.sourceIdentity ||
      meta.count !== expected.count
    ) {
      return null
    }
    const values = fs.readFileSync(files.values)
    if (values.length !== meta.count * meta.projectionDimensions.length) return null
    const digest = crypto.createHash('sha256').update(values).digest('hex')
    if (digest !== meta.valuesSha256) return null
    return {
      dimensions: Uint16Array.from(meta.projectionDimensions),
      inverseScales: Float32Array.from(meta.projectionInverseScales),
      values,
    }
  } catch {
    return null
  }
}

export function persistVectorAnnProjectionSidecar(
  files: { meta: string; values: string },
  sourceIdentity: string,
  count: number,
  dim: number,
  dimensions: Uint16Array,
  inverseScales: Float32Array,
  segments: readonly VectorAnnBufferSegment[],
): void {
  const valuesTmp = `${files.values}.${process.pid}.tmp`
  const metaTmp = `${files.meta}.${process.pid}.tmp`
  const descriptor = fs.openSync(valuesTmp, 'w')
  const hash = crypto.createHash('sha256')
  let nextRow = 0
  let writeError: unknown
  try {
    for (const segment of segments) {
      if (
        segment.startRow !== nextRow ||
        segment.buffer.length !== segment.rowCount * dimensions.length
      ) {
        throw new Error('ANN projection sidecar segments are not contiguous')
      }
      let offset = 0
      while (offset < segment.buffer.length) {
        const written = fs.writeSync(
          descriptor,
          segment.buffer,
          offset,
          segment.buffer.length - offset,
        )
        if (written === 0) throw new Error('ANN projection sidecar write was truncated')
        offset += written
      }
      hash.update(segment.buffer)
      nextRow += segment.rowCount
    }
    if (nextRow !== count) throw new Error('ANN projection sidecar row count mismatch')
    fs.fsyncSync(descriptor)
  } catch (error) {
    writeError = error
  } finally {
    fs.closeSync(descriptor)
  }
  if (writeError) {
    try {
      fs.unlinkSync(valuesTmp)
    } catch {
      // Nothing committed; a missing temporary file needs no cleanup.
    }
    throw writeError
  }
  try {
    replaceDerivedFile(valuesTmp, files.values)
    const meta: ProjectionSidecarMeta = {
      version: VECTOR_ANN_VERSION,
      sourceIdentity,
      count,
      dim,
      projectionDimensions: [...dimensions],
      projectionInverseScales: [...inverseScales],
      valuesSha256: hash.digest('hex'),
      createdAt: Date.now(),
    }
    fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2), 'utf8')
    replaceDerivedFile(metaTmp, files.meta)
  } finally {
    for (const temporary of [valuesTmp, metaTmp]) {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      } catch {
        // A later rebuild can replace a stale temporary file.
      }
    }
  }
}
