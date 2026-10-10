import { execFile as nodeExecFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type DataDirectorySecurityStatus =
  | { applied: true; platform: NodeJS.Platform }
  | {
      applied: false
      platform: NodeJS.Platform
      reason: 'disabled' | 'unsupported' | 'failed'
      error?: string
    }

type CommandRunner = (
  executable: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>

export interface DataDirectorySecurityOptions {
  enabled?: boolean
  platform?: NodeJS.Platform
  runCommand?: CommandRunner
}

const WINDOWS_USER_SID = /^S-1-5-21-(?:\d+-){3}\d+$/
const WINDOWS_SYSTEM_SID = 'S-1-5-18'
const WINDOWS_ADMINISTRATORS_SID = 'S-1-5-32-544'

function windowsSystemExecutable(
  executable: string,
  windowsRoot: string | undefined = process.env.SystemRoot || process.env.WINDIR,
): string {
  if (!windowsRoot || !path.win32.isAbsolute(windowsRoot)) {
    throw new Error('Windows system directory is unavailable')
  }
  if (executable === 'whoami.exe') return path.win32.join(windowsRoot, 'System32', executable)
  if (executable === 'powershell.exe') {
    return path.win32.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', executable)
  }
  throw new Error('Unsupported Windows security executable')
}

// powershell.exe -Command appends trailing argv tokens as extra command text
// instead of filling $args, so paths/SIDs are inlined as single-quoted literals.
function powerShellLiteral(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('PowerShell argument contains control characters')
  return `'${value.replace(/'/g, "''")}'`
}

function buildWindowsAclScript(root: string, currentUserSid: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = [IO.Path]::GetFullPath(${powerShellLiteral(root)})`,
    `$allowed = @(${powerShellLiteral(currentUserSid)}, '${WINDOWS_SYSTEM_SID}', '${WINDOWS_ADMINISTRATORS_SID}')`,
    '$acl = Get-Acl -LiteralPath $target',
    '$acl.SetAccessRuleProtection($true, $false)',
    'foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }',
    '$inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit',
    'foreach ($sidValue in $allowed) { $identity = [Security.Principal.SecurityIdentifier]::new($sidValue); $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow); [void]$acl.AddAccessRule($rule) }',
    'Set-Acl -LiteralPath $target -AclObject $acl',
    '$verified = Get-Acl -LiteralPath $target',
    "if (-not $verified.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled' }",
    '$rules = @($verified.Access)',
    '$actual = @($rules | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })',
    '$unexpected = @($actual | Where-Object { $_ -notin $allowed })',
    '$missing = @($allowed | Where-Object { $_ -notin $actual })',
    '$invalid = @($rules | Where-Object { $_.IsInherited -or $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) })',
    "if ($unexpected.Count -gt 0 -or $missing.Count -gt 0 -or $invalid.Count -gt 0 -or $rules.Count -ne 3) { throw 'ACL verification failed' }",
    "Write-Output 'verified'",
  ].join('; ')
}

function buildWindowsAclProbeScript(root: string, currentUserSid: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$target = [IO.Path]::GetFullPath(${powerShellLiteral(root)})`,
    `$allowed = @(${powerShellLiteral(currentUserSid)}, '${WINDOWS_SYSTEM_SID}', '${WINDOWS_ADMINISTRATORS_SID}')`,
    '$acl = Get-Acl -LiteralPath $target',
    '$rules = @($acl.Access)',
    '$actual = @($rules | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })',
    '$unexpected = @($actual | Where-Object { $_ -notin $allowed })',
    '$missing = @($allowed | Where-Object { $_ -notin $actual })',
    '$invalid = @($rules | Where-Object { $_.IsInherited -or $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) })',
    "if (-not $acl.AreAccessRulesProtected -or $unexpected.Count -gt 0 -or $missing.Count -gt 0 -or $invalid.Count -gt 0 -or $rules.Count -ne 3) { Write-Output 'drifted' } else { Write-Output 'compliant' }",
  ].join('; ')
}
const SENSITIVE_FILES = [
  'remote-terminal-credentials.json',
  'ai-control.json',
  'ai-control-audit.jsonl',
] as const

let latestStatus: DataDirectorySecurityStatus | null = null

function defaultCommandRunner(
  executable: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      windowsSystemExecutable(executable),
      args,
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${path.basename(executable)} failed with exit code ${error.code ?? 'unknown'}`,
            ),
          )
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

function validateUserDataDirectory(userDataPath: string): string {
  if (!path.isAbsolute(userDataPath)) throw new Error('Application data path must be absolute')
  const resolved = path.resolve(userDataPath)
  if (path.dirname(resolved) === resolved) throw new Error('Refusing to secure a filesystem root')
  return resolved
}

function extractWindowsUserSid(output: string): string {
  const sid = output.match(/S-1-5-21-(?:\d+-){3}\d+/)?.[0]
  if (!sid || !WINDOWS_USER_SID.test(sid))
    throw new Error('Could not determine the current Windows user SID')
  return sid
}

async function hardenWindowsDirectory(root: string, runCommand: CommandRunner): Promise<void> {
  const identity = await runCommand('whoami.exe', ['/user', '/fo', 'csv', '/nh'])
  const currentUserSid = extractWindowsUserSid(identity.stdout)
  const result = await runCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    buildWindowsAclScript(root, currentUserSid),
  ])
  if (!result.stdout.split(/\r?\n/).some((line) => line.trim() === 'verified')) {
    throw new Error('Windows ACL verification did not complete')
  }
}

async function hardenPosixDirectory(root: string): Promise<void> {
  await fs.promises.chmod(root, 0o700)
  if (((await fs.promises.stat(root)).mode & 0o777) !== 0o700) {
    throw new Error('Application data directory permission verification failed')
  }
  for (const filename of SENSITIVE_FILES) {
    const target = path.join(root, filename)
    try {
      const stat = await fs.promises.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      await fs.promises.chmod(target, 0o600)
      if (((await fs.promises.stat(target)).mode & 0o777) !== 0o600) {
        throw new Error('Sensitive file permission verification failed')
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
}

async function probeWindowsDirectory(root: string, runCommand: CommandRunner): Promise<void> {
  const identity = await runCommand('whoami.exe', ['/user', '/fo', 'csv', '/nh'])
  const currentUserSid = extractWindowsUserSid(identity.stdout)
  const result = await runCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    buildWindowsAclProbeScript(root, currentUserSid),
  ])
  if (!result.stdout.split(/\r?\n/).some((line) => line.trim() === 'compliant')) {
    throw new Error('Application data directory ACL drifted from the hardened state')
  }
}

async function probePosixDirectory(root: string): Promise<void> {
  if (((await fs.promises.stat(root)).mode & 0o777) !== 0o700) {
    throw new Error('Application data directory permission drifted from 0700')
  }
  for (const filename of SENSITIVE_FILES) {
    const target = path.join(root, filename)
    try {
      const stat = await fs.promises.lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      if ((stat.mode & 0o777) !== 0o600) {
        throw new Error('Sensitive file permission drifted from 0600')
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
  }
}

/**
 * Remove inherited cross-account access from the application's own data root.
 * The caller enables this only for packaged builds so development sandboxes and
 * test fixtures keep their established permissions.
 */
export async function hardenDataDirectoryPermissions(
  userDataPath: string,
  options: DataDirectorySecurityOptions = {},
): Promise<DataDirectorySecurityStatus> {
  const platform = options.platform ?? process.platform
  if (options.enabled !== true) {
    latestStatus = { applied: false, platform, reason: 'disabled' }
    return { ...latestStatus }
  }
  try {
    const root = validateUserDataDirectory(userDataPath)
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
    const stat = await fs.promises.lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Application data path must be a real directory')
    }
    if (platform === 'win32') {
      await hardenWindowsDirectory(root, options.runCommand ?? defaultCommandRunner)
    } else if (platform === 'darwin' || platform === 'linux') {
      await hardenPosixDirectory(root)
    } else {
      latestStatus = { applied: false, platform, reason: 'unsupported' }
      return { ...latestStatus }
    }
    latestStatus = { applied: true, platform }
    return { ...latestStatus }
  } catch (error: unknown) {
    latestStatus = {
      applied: false,
      platform,
      reason: 'failed',
      error: error instanceof Error ? error.message : 'Data directory hardening failed',
    }
    return { ...latestStatus }
  }
}

export function getDataDirectorySecurityStatus(): DataDirectorySecurityStatus | null {
  return latestStatus ? { ...latestStatus } : null
}

/**
 * Read-only probe of the data-root permission state. Unlike the startup-hardening
 * cache, this re-reads the live ACL/mode so Product Health can show drift and offer
 * an explicit repair. It never modifies permissions.
 */
export async function probeDataDirectorySecurity(
  userDataPath: string,
  options: DataDirectorySecurityOptions = {},
): Promise<DataDirectorySecurityStatus> {
  const platform = options.platform ?? process.platform
  if (options.enabled !== true) {
    latestStatus = { applied: false, platform, reason: 'disabled' }
    return { ...latestStatus }
  }
  try {
    const root = validateUserDataDirectory(userDataPath)
    const stat = await fs.promises.lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('Application data path must be a real directory')
    }
    if (platform === 'win32') {
      await probeWindowsDirectory(root, options.runCommand ?? defaultCommandRunner)
    } else if (platform === 'darwin' || platform === 'linux') {
      await probePosixDirectory(root)
    } else {
      latestStatus = { applied: false, platform, reason: 'unsupported' }
      return { ...latestStatus }
    }
    latestStatus = { applied: true, platform }
    return { ...latestStatus }
  } catch (error: unknown) {
    latestStatus = {
      applied: false,
      platform,
      reason: 'failed',
      error: error instanceof Error ? error.message : 'Data directory probe failed',
    }
    return { ...latestStatus }
  }
}

export const dataDirectorySecurityInternals = {
  windowsSystemExecutable,
  extractWindowsUserSid,
  validateUserDataDirectory,
  buildWindowsAclScript,
  buildWindowsAclProbeScript,
  probeWindowsDirectory,
  probePosixDirectory,
  sensitiveFiles: [...SENSITIVE_FILES],
}
