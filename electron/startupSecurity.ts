import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Session } from 'electron'

export const SMOKE_SESSION_MARKER = '.floating-clock-smoke-session.json'
export const PRODUCT_NAME = 'Siftory'
export const PRODUCT_NAME_ZH_CN = '寻藏'
export const PRODUCT_DISPLAY_NAME = `${PRODUCT_NAME} · ${PRODUCT_NAME_ZH_CN}`
export const LEGACY_USER_DATA_DIRECTORY = 'floating-clock-electron'

export function resolveStableUserDataPath(appDataPath: string): string {
  return path.join(appDataPath, LEGACY_USER_DATA_DIRECTORY)
}

const UI_REPORT_ENV = 'FLOATING_CLOCK_UI_SMOKE_REPORT'
const AI_REPORT_ENV = 'FLOATING_CLOCK_AI_CONTROL_SMOKE_REPORT'
const USER_DATA_ENV = 'FLOATING_CLOCK_UI_SMOKE_USER_DATA'
const NONCE_ENV = 'FLOATING_CLOCK_SMOKE_SESSION_NONCE'
const UI_NO_SANDBOX_ENV = 'FLOATING_CLOCK_UI_SMOKE_ALLOW_NO_SANDBOX'
const REQUIRE_SANDBOX_ENV = 'FLOATING_CLOCK_REQUIRE_SANDBOX'
const NONCE_PATTERN = /^[a-f0-9]{64}$/
const MAX_MARKER_BYTES = 4096
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** Accept only an explicit loopback HTTP origin for the development renderer. */
export function getAllowedDevServerUrl(
  isPackaged: boolean,
  rawUrl: string | undefined,
): string | null {
  if (isPackaged || !rawUrl) return null

  try {
    const url = new URL(rawUrl)
    if (
      url.protocol !== 'http:' ||
      !LOOPBACK_HOSTS.has(url.hostname) ||
      !url.port ||
      url.username ||
      url.password
    ) {
      return null
    }
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
    return url.href
  } catch {
    return null
  }
}

/** Collapse Windows' case-insensitive PATH aliases before child processes start. */
export function normalizeWindowsPathEnvironment(env: Record<string, string | undefined>): boolean {
  const keys = Object.keys(env).filter((key) => key.toLowerCase() === 'path')
  if (keys.length <= 1) return false
  const value = keys
    .map((key) => env[key] || '')
    .sort((left, right) => right.length - left.length)[0]
  for (const key of keys) delete env[key]
  env.Path = value
  return true
}

export const MAIN_SESSION_ALLOWED_PERMISSIONS: readonly string[] = Object.freeze([])

export function isMainSessionPermissionAllowed(permission: string): boolean {
  return MAIN_SESSION_ALLOWED_PERMISSIONS.includes(permission)
}

/** Install the main renderer's deny-by-default permission policy. */
export function hardenMainSession(target: Session): void {
  target.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (isMainSessionPermissionAllowed(permission)) {
      callback(true)
      return
    }
    console.warn(`[security] Denied main-session permission request: ${permission}`)
    callback(false)
  })
  target.setPermissionCheckHandler((_webContents, permission) =>
    isMainSessionPermissionAllowed(permission),
  )
}

export type SmokeStartupMode = 'ui' | 'ai-control'

export interface StartupSecurityInput {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  noSandboxSwitchPresent?: boolean
  disableSandboxSwitchPresent?: boolean
  tempDirectory?: string
}

export interface StartupSecurityResult {
  smokeMode?: SmokeStartupMode
  smokeUserDataPath?: string
  sandboxDisabled: boolean
}

interface SmokeMarker {
  version?: unknown
  nonce?: unknown
  runner?: unknown
}

function hasOwnEnvironmentKey(env: NodeJS.ProcessEnv, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key)
}

function nonEmptyEnvironmentValue(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`[StartupSecurity] ${key} must be a non-empty value`)
  return value
}

function isNestedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return (
    Boolean(relative) &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function resolveValidatedSmokeUserData(
  env: NodeJS.ProcessEnv,
  mode: SmokeStartupMode,
  tempDirectory: string,
): string {
  const configuredPath = nonEmptyEnvironmentValue(env, USER_DATA_ENV)
  if (!path.isAbsolute(configuredPath)) {
    throw new Error(`[StartupSecurity] ${USER_DATA_ENV} must be an absolute path`)
  }

  const configuredStat = fs.lstatSync(configuredPath)
  if (!configuredStat.isDirectory() || configuredStat.isSymbolicLink()) {
    throw new Error(`[StartupSecurity] ${USER_DATA_ENV} must be a real directory`)
  }

  const resolvedTempDirectory = fs.realpathSync(tempDirectory)
  const resolvedUserData = fs.realpathSync(configuredPath)
  if (!isNestedPath(resolvedTempDirectory, resolvedUserData)) {
    throw new Error(`[StartupSecurity] smoke userData must be below the system temporary directory`)
  }

  const nonce = nonEmptyEnvironmentValue(env, NONCE_ENV)
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error(`[StartupSecurity] ${NONCE_ENV} must be a 256-bit lowercase hex nonce`)
  }

  const markerPath = path.join(resolvedUserData, SMOKE_SESSION_MARKER)
  const markerStat = fs.lstatSync(markerPath)
  if (
    !markerStat.isFile() ||
    markerStat.isSymbolicLink() ||
    markerStat.size <= 0 ||
    markerStat.size > MAX_MARKER_BYTES
  ) {
    throw new Error('[StartupSecurity] smoke session marker is invalid')
  }

  let marker: SmokeMarker
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as SmokeMarker
  } catch {
    throw new Error('[StartupSecurity] smoke session marker is not valid JSON')
  }
  if (marker.version !== 1 || marker.runner !== mode || marker.nonce !== nonce) {
    throw new Error('[StartupSecurity] smoke session marker does not match this runner')
  }
  return resolvedUserData
}

function argvDisablesSandbox(argv: readonly string[]): boolean {
  return argv.some((argument) =>
    ['--no-sandbox', '--disable-sandbox'].some(
      (forbidden) => argument === forbidden || argument.startsWith(`${forbidden}=`),
    ),
  )
}

/**
 * Fail-closed startup policy. Smoke modes must prove that their profile was
 * created by a runner below the OS temp directory before app services start.
 * The sole no-sandbox exception is the visual UI smoke, which still needs the
 * marker/nonce proof and an explicit runner opt-in.
 */
export function validateStartupSecurity(input: StartupSecurityInput): StartupSecurityResult {
  const uiSmokeRequested = hasOwnEnvironmentKey(input.env, UI_REPORT_ENV)
  const aiSmokeRequested = hasOwnEnvironmentKey(input.env, AI_REPORT_ENV)
  if (uiSmokeRequested && aiSmokeRequested) {
    throw new Error('[StartupSecurity] UI and AI smoke modes cannot run in the same process')
  }

  let smokeMode: SmokeStartupMode | undefined
  let smokeUserDataPath: string | undefined
  if (uiSmokeRequested || aiSmokeRequested) {
    smokeMode = uiSmokeRequested ? 'ui' : 'ai-control'
    nonEmptyEnvironmentValue(input.env, uiSmokeRequested ? UI_REPORT_ENV : AI_REPORT_ENV)
    smokeUserDataPath = resolveValidatedSmokeUserData(
      input.env,
      smokeMode,
      input.tempDirectory ?? os.tmpdir(),
    )
  }

  const sandboxDisabled =
    argvDisablesSandbox(input.argv) ||
    input.noSandboxSwitchPresent === true ||
    input.disableSandboxSwitchPresent === true
  const sandboxRequired = input.env[REQUIRE_SANDBOX_ENV]?.trim() === '1'
  const authenticatedVisualSmokeException =
    smokeMode === 'ui' && input.env[UI_NO_SANDBOX_ENV]?.trim() === '1'
  if (sandboxDisabled && (sandboxRequired || !authenticatedVisualSmokeException)) {
    throw new Error('[StartupSecurity] Chromium sandbox disabling switches are not permitted')
  }

  return { smokeMode, smokeUserDataPath, sandboxDisabled }
}
