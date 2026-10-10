import fs from 'fs'
import path from 'path'

interface TransformersEnvironmentTarget {
  localModelPath: string
  cacheDir: string
  allowLocalModels: boolean
  allowRemoteModels: boolean
}

type TransformersCacheEnvironment = Readonly<{
  TRANSFORMERS_CACHE?: string
}>

function hasInvalidPathControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function requireDirectoryOrCreatableDescendant(directoryPath: string): void {
  let candidate = directoryPath
  for (;;) {
    try {
      if (!fs.statSync(candidate).isDirectory()) {
        throw new Error('TRANSFORMERS_CACHE resolves to an existing non-directory path')
      }
      return
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      const parent = path.dirname(candidate)
      if (parent === candidate) {
        throw new Error('TRANSFORMERS_CACHE has no resolvable directory ancestor', {
          cause: error,
        })
      }
      candidate = parent
    }
  }
}

export function resolveTransformersCacheDirectory(
  modelRoot: string,
  environment: TransformersCacheEnvironment = process.env,
): string {
  const configured = environment.TRANSFORMERS_CACHE
  if (configured === undefined) return path.join(modelRoot, '.transformers-cache')
  if (
    configured.length === 0 ||
    configured.trim() !== configured ||
    hasInvalidPathControlCharacters(configured)
  ) {
    throw new Error('TRANSFORMERS_CACHE must be a non-empty absolute directory path')
  }
  if (!path.isAbsolute(configured)) {
    throw new Error('TRANSFORMERS_CACHE must be absolute and must not depend on the child cwd')
  }
  const resolved = path.resolve(configured)
  if (!path.isAbsolute(resolved) || hasInvalidPathControlCharacters(resolved)) {
    throw new Error('TRANSFORMERS_CACHE could not be resolved safely')
  }
  requireDirectoryOrCreatableDescendant(resolved)
  return resolved
}

export function configureLocalTransformersEnvironment(
  target: TransformersEnvironmentTarget,
  modelPath: string,
  environment: TransformersCacheEnvironment = process.env,
): { modelRoot: string; cacheDir: string } {
  const modelRoot = path.resolve(path.dirname(modelPath), '..', '..', '..')
  const cacheDir = resolveTransformersCacheDirectory(modelRoot, environment)
  target.localModelPath = modelRoot
  target.cacheDir = cacheDir
  target.allowLocalModels = true
  target.allowRemoteModels = false
  return { modelRoot, cacheDir }
}
