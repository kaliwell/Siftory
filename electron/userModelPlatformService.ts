import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { app, dialog, shell } from 'electron'
import {
  USER_MODEL_SLOTS,
  getUserModelProfileDefinition,
  getUserModelSlotDefinition,
  type UserModelMutationResult,
  type UserModelInspection,
  type UserModelTensorDescriptor,
  type UserModelSlotDefinition,
  type UserModelProfileDefinition,
  type UserModelSlotId,
  type UserModelSlotStatus,
} from '../shared/userModelPlatform'
import {
  commitPreparedPath,
  createPreparedSiblingPath,
  discardPreparedPath,
  recoverPreparedPathTransactions,
} from './localFileTransaction'
import { openSafeShellPath } from './pathGuards'
import { inspectUserModelInIsolation } from './userModelRuntimeHost'

interface UserModelMetadata {
  schemaVersion: 1 | 2 | 3
  slotId: UserModelSlotId
  profileId?: string
  sourceFileName: string
  sizeBytes: number
  sha256: string
  installedAt: string
  responsibility: 'user-supplied-unreviewed'
  inspection?: UserModelInspection
}

const MIN_MODEL_BYTES = 1024
const MAX_METADATA_BYTES = 256 * 1024
type BeforeMutationListener = (slotId: UserModelSlotId) => void | Promise<void>
const beforeMutationListeners = new Set<BeforeMutationListener>()

export function onBeforeUserModelMutation(listener: BeforeMutationListener): () => void {
  beforeMutationListeners.add(listener)
  return () => beforeMutationListeners.delete(listener)
}

async function prepareUserModelMutation(slotId: UserModelSlotId): Promise<void> {
  for (const listener of beforeMutationListeners) await listener(slotId)
}

export function getUserModelRoot(): string {
  return path.join(app.getPath('userData'), 'models')
}

function getSlotDirectory(slot: UserModelSlotDefinition): string {
  return path.join(getUserModelRoot(), slot.id)
}

export function getUserModelPath(slotId: UserModelSlotId): string {
  const slot = getUserModelSlotDefinition(slotId)
  if (!slot) throw new Error(`Unknown user model slot: ${slotId}`)
  return path.join(getSlotDirectory(slot), slot.targetFileName)
}

export function getUserModelFileSignature(slotId: UserModelSlotId): string | null {
  try {
    const filePath = getUserModelPath(slotId)
    const stat = fs.statSync(filePath)
    return stat.isFile()
      ? `${filePath}:${stat.size}:${stat.mtimeMs}:${getUserModelProfile(slotId).id}`
      : null
  } catch {
    return null
  }
}

function metadataPath(slot: UserModelSlotDefinition): string {
  return path.join(getSlotDirectory(slot), 'installation.json')
}

function normalizeStoredInspection(value: unknown): UserModelInspection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<UserModelInspection>
  const normalizeTensors = (tensors: unknown) => {
    if (!Array.isArray(tensors) || tensors.length > 128) return null
    const normalized: UserModelTensorDescriptor[] = []
    for (const tensor of tensors) {
      if (!tensor || typeof tensor !== 'object' || Array.isArray(tensor)) return null
      const item = tensor as { name?: unknown; type?: unknown; shape?: unknown }
      if (
        typeof item.name !== 'string' ||
        !item.name ||
        item.name.length > 256 ||
        typeof item.type !== 'string' ||
        item.type.length > 64 ||
        !Array.isArray(item.shape) ||
        item.shape.length > 8 ||
        item.shape.some(
          (dimension) =>
            !(
              (typeof dimension === 'number' && Number.isFinite(dimension)) ||
              (typeof dimension === 'string' && dimension.length <= 64)
            ),
        )
      ) {
        return null
      }
      normalized.push({
        name: item.name,
        type: item.type,
        shape: [...item.shape] as Array<number | string>,
      })
    }
    return normalized
  }
  const inputs = normalizeTensors(candidate.inputs)
  const outputs = normalizeTensors(candidate.outputs)
  if (
    typeof candidate.inspectedAt !== 'string' ||
    candidate.inspectedAt.length > 64 ||
    typeof candidate.compatible !== 'boolean' ||
    !inputs ||
    !outputs ||
    !Array.isArray(candidate.warnings) ||
    candidate.warnings.length > 32 ||
    candidate.warnings.some((warning) => typeof warning !== 'string' || warning.length > 512)
  ) {
    return undefined
  }
  return {
    inspectedAt: candidate.inspectedAt,
    compatible: candidate.compatible,
    inputs,
    outputs,
    warnings: [...candidate.warnings],
  }
}

function readMetadata(slot: UserModelSlotDefinition): UserModelMetadata | null {
  try {
    const filePath = metadataPath(slot)
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_METADATA_BYTES) return null
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as UserModelMetadata
    return (parsed.schemaVersion === 1 ||
      parsed.schemaVersion === 2 ||
      parsed.schemaVersion === 3) &&
      parsed.slotId === slot.id
      ? { ...parsed, inspection: normalizeStoredInspection(parsed.inspection) }
      : null
  } catch {
    return null
  }
}

function buildStatus(slot: UserModelSlotDefinition): UserModelSlotStatus {
  const filePath = getUserModelPath(slot.id)
  const metadata = readMetadata(slot)
  const profile =
    getUserModelProfileDefinition(slot.id, metadata?.profileId) ??
    getUserModelProfileDefinition(slot.id, slot.defaultProfileId)!
  let sizeBytes: number | undefined
  try {
    const stat = fs.statSync(filePath)
    if (stat.isFile()) sizeBytes = stat.size
  } catch {
    /* not installed */
  }
  return {
    ...slot,
    installed: sizeBytes !== undefined,
    activeProfileId: profile.id,
    activeProfileName: profile.displayName,
    sizeBytes,
    sha256: metadata?.sha256,
    installedAt: metadata?.installedAt,
    sourceFileName: metadata?.sourceFileName,
    inspection: metadata?.inspection,
    responsibility: 'user-supplied-unreviewed',
  }
}

export function listUserModelSlots(): UserModelSlotStatus[] {
  return USER_MODEL_SLOTS.map(buildStatus)
}

export function getUserModelProfile(slotId: UserModelSlotId): UserModelProfileDefinition {
  const slot = getUserModelSlotDefinition(slotId)
  if (!slot) throw new Error(`Unknown user model slot: ${slotId}`)
  const metadata = readMetadata(slot)
  return (
    getUserModelProfileDefinition(slotId, metadata?.profileId) ??
    getUserModelProfileDefinition(slotId, slot.defaultProfileId)!
  )
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

async function inspectPreparedModel(
  filePath: string,
  profile: UserModelProfileDefinition,
  maxBytes: number,
): Promise<UserModelInspection> {
  // The unvetted model is loaded inside the isolated runtime child; a native
  // crash, hang, or runaway allocation there can never take down main.
  return inspectUserModelInIsolation(filePath, profile, maxBytes)
}

export async function importUserModel(
  rawSlotId: unknown,
  acknowledgement: unknown,
  rawProfileId?: unknown,
): Promise<UserModelMutationResult> {
  const slot = getUserModelSlotDefinition(rawSlotId)
  if (!slot) return { ok: false, error: 'Unknown model slot' }
  const profile = getUserModelProfileDefinition(slot.id, rawProfileId)
  if (!profile) return { ok: false, error: 'Unknown or incompatible model profile' }
  if (acknowledgement !== true) {
    return { ok: false, error: 'License and compatibility acknowledgement is required' }
  }
  const selection = await dialog.showOpenDialog({
    title: `Import ${slot.displayName}`,
    properties: ['openFile'],
    filters: [{ name: 'ONNX model', extensions: ['onnx'] }],
  })
  if (selection.canceled || selection.filePaths.length !== 1) {
    return { ok: false, cancelled: true }
  }
  const sourcePath = selection.filePaths[0]
  try {
    const stat = await fsp.stat(sourcePath)
    if (!stat.isFile() || stat.size < MIN_MODEL_BYTES || stat.size > slot.maxSizeBytes) {
      return { ok: false, error: 'Selected model file has an unsupported size' }
    }
    if (path.extname(sourcePath).toLowerCase() !== '.onnx') {
      return { ok: false, error: 'Only ONNX model files are supported' }
    }
    const root = getUserModelRoot()
    await fsp.mkdir(root, { recursive: true })
    recoverPreparedPathTransactions(root)
    await prepareUserModelMutation(slot.id)
    const finalDirectory = getSlotDirectory(slot)
    const preparedDirectory = createPreparedSiblingPath(finalDirectory)
    const preparedModelPath = path.join(preparedDirectory, slot.targetFileName)
    try {
      await fsp.mkdir(preparedDirectory)
      await fsp.copyFile(sourcePath, preparedModelPath)
      const installedStat = await fsp.stat(preparedModelPath)
      if (!installedStat.isFile() || installedStat.size < MIN_MODEL_BYTES) {
        throw new Error('Imported model file is invalid after copy')
      }
      const inspection = await inspectPreparedModel(preparedModelPath, profile, slot.maxSizeBytes)
      if (!inspection.compatible) {
        throw new Error(
          `Model does not match the selected profile: ${inspection.warnings.join('; ')}`,
        )
      }
      const metadata: UserModelMetadata = {
        schemaVersion: 3,
        slotId: slot.id,
        profileId: profile.id,
        sourceFileName: path.basename(sourcePath),
        sizeBytes: installedStat.size,
        sha256: await sha256File(preparedModelPath),
        installedAt: new Date().toISOString(),
        responsibility: 'user-supplied-unreviewed',
        inspection,
      }
      await fsp.writeFile(
        path.join(preparedDirectory, 'installation.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        'utf8',
      )
      await commitPreparedPath(preparedDirectory, finalDirectory)
    } catch (error) {
      await discardPreparedPath(preparedDirectory)
      throw error
    }
    return { ok: true, status: buildStatus(slot) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function removeUserModel(rawSlotId: unknown): Promise<UserModelMutationResult> {
  const slot = getUserModelSlotDefinition(rawSlotId)
  if (!slot) return { ok: false, error: 'Unknown model slot' }
  try {
    await prepareUserModelMutation(slot.id)
    await fsp.rm(getSlotDirectory(slot), { recursive: true, force: true })
    return { ok: true, status: buildStatus(slot) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function openUserModelFolder(): Promise<{ ok: boolean; error?: string }> {
  await fsp.mkdir(getUserModelRoot(), { recursive: true })
  const result = await openSafeShellPath(shell, getUserModelRoot(), { requireExists: true })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}
