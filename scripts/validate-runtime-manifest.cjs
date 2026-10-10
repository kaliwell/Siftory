const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const projectRoot = path.resolve(__dirname, '..')
const manifestPath = path.join(projectRoot, 'resources', 'runtime-manifest.json')
const shaPattern = /^[a-f0-9]{64}$/
const allowedTypes = new Set(['model', 'tool', 'font', 'native-addon', 'optional-runtime'])
const allowedReviews = new Set(['recorded', 'legal-review-required', 'project-license-pending'])
const allowedFetchPolicies = new Set(['download', 'local-build', 'manual-review'])

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value)) return false
  const normalized = value.replaceAll('\\', '/')
  return !normalized.split('/').includes('..')
}

function validateRuntimeManifest(manifest, options = {}) {
  const errors = []
  const ids = new Set()
  const targets = new Set()
  const components = Array.isArray(manifest?.components) ? manifest.components : []
  if (manifest?.schemaVersion !== 1) errors.push('schemaVersion must equal 1')
  if (manifest?.manifestId !== 'floating-clock-runtime-resources') {
    errors.push('manifestId must equal floating-clock-runtime-resources')
  }
  if (components.length === 0) errors.push('components must be a non-empty array')

  for (const component of components) {
    const prefix = `component ${component?.id || '<missing>'}`
    if (!/^[a-z0-9][a-z0-9-]*$/.test(component?.id || '')) {
      errors.push(`${prefix}: invalid stable id`)
    } else if (ids.has(component.id)) {
      errors.push(`${prefix}: duplicate id`)
    } else {
      ids.add(component.id)
    }
    if (!allowedTypes.has(component?.componentType)) {
      errors.push(`${prefix}: invalid componentType`)
    }
    if (typeof component?.purpose !== 'string' || component.purpose.trim().length < 8) {
      errors.push(`${prefix}: purpose is required`)
    }
    const upstream = component?.upstream
    if (
      typeof upstream?.name !== 'string' ||
      typeof upstream?.version !== 'string' ||
      upstream.version.length === 0 ||
      typeof upstream?.sourceUrl !== 'string' ||
      upstream.sourceUrl.length === 0
    ) {
      errors.push(`${prefix}: upstream name, exact version, and sourceUrl are required`)
    }
    if (upstream?.releasedAt !== null && !/^\d{4}-\d{2}-\d{2}$/.test(upstream?.releasedAt || '')) {
      errors.push(`${prefix}: releasedAt must be YYYY-MM-DD or null`)
    }
    const license = component?.license
    if (
      typeof license?.spdx !== 'string' ||
      !Array.isArray(license?.licenseFiles) ||
      typeof license?.noticeRequired !== 'boolean' ||
      !allowedReviews.has(license?.reviewStatus)
    ) {
      errors.push(`${prefix}: complete license and notice metadata are required`)
    }
    if (
      license?.acceptanceRequired !== undefined &&
      typeof license.acceptanceRequired !== 'boolean'
    ) {
      errors.push(`${prefix}: acceptanceRequired must be boolean when present`)
    }
    if (
      license?.acceptanceRequired === true &&
      (typeof license?.sourceUrl !== 'string' || !license.sourceUrl.startsWith('https://'))
    ) {
      errors.push(`${prefix}: an HTTPS license sourceUrl is required for explicit acceptance`)
    }
    for (const file of license?.licenseFiles || []) {
      if (!isSafeRelativePath(file)) errors.push(`${prefix}: unsafe license file ${file}`)
    }
    const distribution = component?.distribution
    if (
      typeof distribution?.firstRunRequired !== 'boolean' ||
      typeof distribution?.defaultBundled !== 'boolean' ||
      !Array.isArray(distribution?.platforms) ||
      distribution.platforms.length === 0 ||
      !Array.isArray(distribution?.architectures) ||
      distribution.architectures.length === 0
    ) {
      errors.push(`${prefix}: complete distribution metadata are required`)
    }
    const artifacts = Array.isArray(component?.artifacts) ? component.artifacts : []
    if (artifacts.length === 0) errors.push(`${prefix}: at least one artifact is required`)
    for (const artifact of artifacts) {
      const target = artifact?.targetPath
      const artifactPrefix = `${prefix} artifact ${target || '<missing>'}`
      if (
        typeof artifact?.role !== 'string' ||
        !allowedFetchPolicies.has(artifact?.fetchPolicy) ||
        typeof artifact?.sourceUrl !== 'string' ||
        artifact.sourceUrl.length === 0
      ) {
        errors.push(`${artifactPrefix}: role, fetchPolicy, and sourceUrl are required`)
      }
      if (!shaPattern.test(artifact?.sha256 || '')) {
        errors.push(`${artifactPrefix}: sha256 must be lowercase hex`)
      }
      if (!Number.isSafeInteger(artifact?.sizeBytes) || artifact.sizeBytes <= 0) {
        errors.push(`${artifactPrefix}: sizeBytes must be a positive integer`)
      }
      const archive = artifact?.archive
      if (archive !== undefined) {
        if (archive?.format !== 'zip') {
          errors.push(`${artifactPrefix}: archive format must be zip`)
        }
        if (!isSafeRelativePath(archive?.entryPath)) {
          errors.push(`${artifactPrefix}: archive entryPath must be a safe relative path`)
        }
        if (!shaPattern.test(archive?.sha256 || '')) {
          errors.push(`${artifactPrefix}: archive sha256 must be lowercase hex`)
        }
        if (!Number.isSafeInteger(archive?.sizeBytes) || archive.sizeBytes <= 0) {
          errors.push(`${artifactPrefix}: archive sizeBytes must be a positive integer`)
        }
      }
      if (!isSafeRelativePath(target)) {
        errors.push(`${artifactPrefix}: targetPath must be a safe relative path`)
      } else if (targets.has(target)) {
        errors.push(`${artifactPrefix}: duplicate targetPath`)
      } else {
        targets.add(target)
      }
      if (options.verifyLocal && isSafeRelativePath(target)) {
        const localPath = path.join(projectRoot, ...target.split('/'))
        if (!fs.existsSync(localPath)) {
          errors.push(`${artifactPrefix}: local file is missing`)
        } else {
          const stat = fs.statSync(localPath)
          if (stat.size !== artifact.sizeBytes) {
            errors.push(`${artifactPrefix}: local size mismatch`)
          }
          const actual = crypto
            .createHash('sha256')
            .update(fs.readFileSync(localPath))
            .digest('hex')
          if (actual !== artifact.sha256) {
            errors.push(`${artifactPrefix}: local sha256 mismatch`)
          }
        }
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    componentCount: components.length,
    artifactCount: targets.size,
  }
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const result = validateRuntimeManifest(manifest, {
    verifyLocal: process.argv.includes('--verify-local'),
  })
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}

if (require.main === module) main()

module.exports = { isSafeRelativePath, validateRuntimeManifest }
