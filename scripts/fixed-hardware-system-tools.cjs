'use strict'

const fs = require('node:fs')
const path = require('node:path')

const FIXED_WINDOWS_ROOT = 'C:\\Windows'
const TOOL_RELATIVE_PATHS = Object.freeze({
  powershell: ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'],
  taskkill: ['System32', 'taskkill.exe'],
  nvidiaSmi: ['System32', 'nvidia-smi.exe'],
  wmic: ['System32', 'wbem', 'WMIC.exe'],
  comSpec: ['System32', 'cmd.exe'],
})

function createFixedWindowsSystemEnvironment(options = {}) {
  const systemRoot = path.win32.normalize(options.systemRoot || FIXED_WINDOWS_ROOT)
  if (!path.win32.isAbsolute(systemRoot)) {
    throw new Error('Fixed Windows environment root must be absolute')
  }
  const system32 = path.win32.join(systemRoot, 'System32')
  const powershell = path.win32.join(system32, 'WindowsPowerShell', 'v1.0')
  const systemDriveRoot = path.win32.parse(systemRoot).root
  if (!/^[a-z]:\\$/i.test(systemDriveRoot)) {
    throw new Error('Fixed Windows environment root must be on a trusted drive')
  }
  const programFiles = path.win32.join(systemDriveRoot, 'Program Files')
  const comSpec = path.win32.normalize(options.comSpec || path.win32.join(system32, 'cmd.exe'))
  if (!path.win32.isAbsolute(comSpec) || !isInsideWindowsRoot(systemRoot, comSpec)) {
    throw new Error('Fixed Windows command interpreter must stay under the trusted root')
  }
  return Object.freeze({
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: comSpec,
    PATH: [system32, systemRoot, path.win32.join(system32, 'Wbem'), powershell].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: path.win32.join(powershell, 'Modules'),
    ProgramFiles: programFiles,
    ProgramW6432: programFiles,
  })
}

function normalizeWindowsPath(value) {
  return path.win32
    .normalize(value)
    .replace(/[. ]+$/g, '')
    .toLowerCase()
}

function isInsideWindowsRoot(rootPath, candidatePath) {
  const relative = path.win32.relative(rootPath, candidatePath)
  return Boolean(relative) && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative)
}

function verifySystemExecutable(filePath, systemRoot, fsModule) {
  const entry = fsModule.lstatSync(filePath)
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error('Fixed-hardware system tool must be a regular non-link file: ' + filePath)
  }
  const realPath = fsModule.realpathSync.native(filePath)
  if (normalizeWindowsPath(realPath) !== normalizeWindowsPath(filePath)) {
    throw new Error('Fixed-hardware system tool canonical path changed: ' + filePath)
  }
  if (!isInsideWindowsRoot(systemRoot, realPath)) {
    throw new Error('Fixed-hardware system tool escaped the trusted Windows root: ' + filePath)
  }
  return realPath
}

function resolveFixedHardwareSystemTools(options = {}) {
  const platform = options.platform || process.platform
  if (platform !== 'win32') {
    throw new Error('The fixed-hardware baseline system-tool policy currently requires Windows')
  }
  const fsModule = options.fsModule || fs
  const configuredRoot = options.windowsRoot || FIXED_WINDOWS_ROOT
  if (!path.win32.isAbsolute(configuredRoot)) {
    throw new Error('Trusted Windows root must be absolute')
  }
  const systemRoot = fsModule.realpathSync.native(configuredRoot)
  if (normalizeWindowsPath(systemRoot) !== normalizeWindowsPath(configuredRoot)) {
    throw new Error('Trusted Windows root canonical path changed')
  }
  const tools = {}
  for (const [name, segments] of Object.entries(TOOL_RELATIVE_PATHS)) {
    const candidate = path.win32.join(systemRoot, ...segments)
    tools[name] = verifySystemExecutable(candidate, systemRoot, fsModule)
  }
  return Object.freeze({
    schemaVersion: 1,
    policy: 'fixed-windows-system32-v1',
    systemRoot,
    ...tools,
  })
}

module.exports = {
  FIXED_WINDOWS_ROOT,
  TOOL_RELATIVE_PATHS,
  createFixedWindowsSystemEnvironment,
  resolveFixedHardwareSystemTools,
}
