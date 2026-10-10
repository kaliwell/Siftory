import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { classifyProjectFile, type ProjectSourceExt } from '../shared/projectFileTypes'
import type { ProjectPreviewProvider } from './projectPreviewProviders'

const CONFIG_FILE_NAME = 'project-preview-providers.json'
const CONFIG_MAX_BYTES = 256 * 1024
const MAX_PROVIDERS = 16
const MAX_ARGUMENTS = 32
const MAX_ARGUMENT_LENGTH = 2048
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_EXTERNAL_PREVIEW_BYTES = 128 * 1024 * 1024

interface ExternalProviderConfig {
  id?: unknown
  version?: unknown
  extensions?: unknown
  executable?: unknown
  args?: unknown
  timeoutMs?: unknown
}

interface ExternalProviderFile {
  version?: unknown
  providers?: unknown
}

function safeString(value: unknown, maximum = 256): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maximum || /[\0\r\n]/.test(trimmed)) return null
  return trimmed
}

function normalizeExtensions(value: unknown): ProjectSourceExt[] {
  if (!Array.isArray(value)) return []
  const extensions = new Set<ProjectSourceExt>()
  for (const raw of value) {
    const extension = safeString(raw, 16)?.replace(/^\./, '').toLowerCase()
    if (!extension) continue
    const classification = classifyProjectFile(`preview.${extension}`)
    if (classification) extensions.add(classification.sourceExt)
  }
  return [...extensions]
}

function normalizeArguments(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARGUMENTS) return null
  const args: string[] = []
  for (const raw of value) {
    const argument = safeString(raw, MAX_ARGUMENT_LENGTH)
    if (!argument) return null
    args.push(argument)
  }
  if (!args.some((argument) => argument.includes('{input}'))) return null
  if (!args.some((argument) => argument.includes('{output}'))) return null
  return args
}

function normalizeTimeout(value: unknown): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, parsed))
}

async function runExternalProvider(
  executable: string,
  argumentTemplates: readonly string[],
  sourcePath: string,
  timeoutMs: number,
): Promise<Buffer | null> {
  const outputRoot = path.join(os.tmpdir(), 'floating-clock-project-preview')
  const outputPath = path.join(outputRoot, `${crypto.randomUUID()}.png`)
  await fsp.mkdir(outputRoot, { recursive: true })
  const args = argumentTemplates.map((argument) =>
    argument.replaceAll('{input}', sourcePath).replaceAll('{output}', outputPath),
  )
  try {
    const succeeded = await new Promise<boolean>((resolve) => {
      let settled = false
      const child = spawn(executable, args, {
        cwd: path.dirname(executable),
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      })
      const finish = (result: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(false)
      }, timeoutMs)
      timer.unref?.()
      child.once('error', () => finish(false))
      child.once('close', (code) => finish(code === 0))
    })
    if (!succeeded) return null
    const stat = await fsp.stat(outputPath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_EXTERNAL_PREVIEW_BYTES) return null
    return await fsp.readFile(outputPath)
  } catch {
    return null
  } finally {
    await fsp.unlink(outputPath).catch(() => {})
  }
}

export function externalProjectPreviewConfigPath(userDataPath: string): string {
  return path.join(path.resolve(userDataPath), CONFIG_FILE_NAME)
}

export function loadExternalProjectPreviewProviders(
  userDataPath: string,
): ProjectPreviewProvider[] {
  const configPath = externalProjectPreviewConfigPath(userDataPath)
  try {
    const stat = fs.statSync(configPath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > CONFIG_MAX_BYTES) return []
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ExternalProviderFile
    if (parsed.version !== 1 || !Array.isArray(parsed.providers)) return []
    const providers: ProjectPreviewProvider[] = []
    for (const raw of parsed.providers.slice(0, MAX_PROVIDERS)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const config = raw as ExternalProviderConfig
      const id = safeString(config.id, 64)
      const declaredVersion = safeString(config.version, 64)
      const executable = safeString(config.executable, 2048)
      const extensions = normalizeExtensions(config.extensions)
      const args = normalizeArguments(config.args)
      if (
        !id ||
        !/^[a-z0-9][a-z0-9._-]*$/i.test(id) ||
        !declaredVersion ||
        !executable ||
        !path.isAbsolute(executable) ||
        path.extname(executable).toLowerCase() !== '.exe' ||
        extensions.length === 0 ||
        !args
      ) {
        continue
      }
      const executableStat = fs.statSync(executable)
      if (!executableStat.isFile()) continue
      const timeoutMs = normalizeTimeout(config.timeoutMs)
      const fingerprint = crypto
        .createHash('sha256')
        .update(
          `${declaredVersion}|${executableStat.size}|${Math.round(executableStat.mtimeMs)}|${args.join('\0')}`,
        )
        .digest('hex')
        .slice(0, 12)
      providers.push({
        id: `external:${id}`,
        version: `${declaredVersion}-${fingerprint}`,
        extensions,
        extract: (sourcePath) => runExternalProvider(executable, args, sourcePath, timeoutMs),
      })
    }
    return providers
  } catch {
    return []
  }
}
