import crypto from 'crypto'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import type { Readable, Writable } from 'stream'
import { Client, type SFTPWrapper } from 'ssh2'
import type { RemoteTerminalProfile, RemoteTransferTask } from '../shared/ipc-contract'
import {
  buildSshConfig,
  hostKeyFailure,
  normalizeSshError,
  prepareAuthConfig,
} from './remoteTerminalService'
import { normalizeRemotePath } from './remoteSftpService'
import { publishFileWithoutOverwrite } from './localFileNoReplace'

interface TransferJob {
  task: RemoteTransferTask
  profile: RemoteTerminalProfile
  localPath: string
  remotePath: string
  password?: string
  passphrase?: string
  client?: Client
  stream?: Readable | Writable
}

type TransferCallback = (task: RemoteTransferTask) => void

const MAX_CONCURRENT_TRANSFERS = 2
export const MAX_TRANSFER_HISTORY = 200

function isTerminalTransferTask(task: RemoteTransferTask): boolean {
  return task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled'
}

export class RemoteTransferHistory {
  private readonly tasks = new Map<string, RemoteTransferTask>()

  constructor(readonly maxTerminalTasks = MAX_TRANSFER_HISTORY) {
    if (!Number.isSafeInteger(maxTerminalTasks) || maxTerminalTasks < 0) {
      throw new Error(`Invalid transfer history limit: ${maxTerminalTasks}`)
    }
  }

  get size(): number {
    return this.tasks.size
  }

  remember(task: RemoteTransferTask): void {
    this.tasks.set(task.id, task)
    if (isTerminalTransferTask(task)) this.prune()
  }

  get(taskId: string): RemoteTransferTask | undefined {
    return this.tasks.get(taskId)
  }

  list(): RemoteTransferTask[] {
    this.prune()
    return [...this.tasks.values()].sort((left, right) => right.createdAt - left.createdAt)
  }

  clearTerminal(): string[] {
    const removed: string[] = []
    for (const [taskId, task] of this.tasks) {
      if (!isTerminalTransferTask(task)) continue
      this.tasks.delete(taskId)
      removed.push(taskId)
    }
    return removed
  }

  clear(): void {
    this.tasks.clear()
  }

  prune(): string[] {
    const terminalTasks = [...this.tasks.values()]
      .filter(isTerminalTransferTask)
      .sort(
        (left, right) =>
          (right.finishedAt ?? right.createdAt) - (left.finishedAt ?? left.createdAt),
      )
    const removed: string[] = []
    for (const task of terminalTasks.slice(this.maxTerminalTasks)) {
      this.tasks.delete(task.id)
      removed.push(task.id)
    }
    return removed
  }
}

const transferHistory = new RemoteTransferHistory()
const jobs = new Map<string, TransferJob>()
let runningCount = 0
let transferCallback: TransferCallback | null = null

function isCancelled(job: TransferJob): boolean {
  return job.task.state === 'cancelled'
}

function publicTask(task: RemoteTransferTask): RemoteTransferTask {
  return { ...task }
}

function publish(task: RemoteTransferTask): void {
  transferCallback?.(publicTask(task))
}

export function setTransferCallback(callback: TransferCallback): void {
  transferCallback = callback
}

export function listTransfers(): RemoteTransferTask[] {
  pruneTransferHistory()
  return transferHistory.list().map(publicTask)
}

export function clearTransferHistory(): void {
  for (const taskId of transferHistory.clearTerminal()) {
    const job = jobs.get(taskId)
    if (job && job.task.startedAt === undefined) forgetTransferJob(job)
  }
}

function forgetTransferJob(job: TransferJob): void {
  delete job.password
  delete job.passphrase
  job.client = undefined
  job.stream = undefined
  jobs.delete(job.task.id)
}

function pruneTransferHistory(): void {
  for (const taskId of transferHistory.prune()) {
    const job = jobs.get(taskId)
    if (job && job.task.startedAt === undefined) forgetTransferJob(job)
  }
}

export function getTransferRetentionStatsForTests(): {
  historyTasks: number
  retainedJobs: number
  running: number
} {
  return {
    historyTasks: transferHistory.size,
    retainedJobs: jobs.size,
    running: runningCount,
  }
}

export function resetTransferRetentionForTests(): void {
  if (runningCount !== 0) throw new Error('Cannot reset transfer retention while jobs are running')
  for (const job of jobs.values()) {
    job.stream?.destroy()
    job.client?.end()
    forgetTransferJob(job)
  }
  transferHistory.clear()
  transferCallback = null
}

export function disposeRemoteTransfers(): void {
  transferCallback = null
  for (const job of [...jobs.values()]) {
    if (!isTerminalTransferTask(job.task)) {
      job.task.state = 'cancelled'
      job.task.finishedAt = Date.now()
    }
    job.stream?.destroy()
    job.client?.end()
    forgetTransferJob(job)
  }
  transferHistory.clear()
}

export function createTransferTask(
  profileId: string,
  direction: 'upload' | 'download',
  sourceDisplayName: string,
  destinationDisplayPath: string,
  totalBytes: number,
  conflictPolicy: RemoteTransferTask['conflictPolicy'] = 'ask',
): RemoteTransferTask {
  return {
    id: `transfer-${crypto.randomUUID()}`,
    profileId,
    direction,
    sourceDisplayName,
    destinationDisplayPath,
    totalBytes,
    transferredBytes: 0,
    speedBytesPerSecond: 0,
    state: 'queued',
    conflictPolicy,
    createdAt: Date.now(),
  }
}

export async function enqueueUpload(
  profile: RemoteTerminalProfile,
  localPath: string,
  remoteDirectory: string,
  credential: { password?: string; passphrase?: string },
  conflictPolicy: RemoteTransferTask['conflictPolicy'] = 'ask',
): Promise<RemoteTransferTask> {
  const normalizedDirectory = normalizeRemotePath(remoteDirectory)
  if (!normalizedDirectory) throw new Error('Invalid remote directory')
  const stats = await fsp.stat(localPath)
  if (!stats.isFile()) throw new Error('Only single-file upload is supported in this milestone')
  const remotePath = path.posix.join(normalizedDirectory, path.basename(localPath))
  const task = createTransferTask(
    profile.id,
    'upload',
    path.basename(localPath),
    remotePath,
    stats.size,
    conflictPolicy,
  )
  transferHistory.remember(task)
  jobs.set(task.id, { task, profile, localPath, remotePath, ...credential })
  publish(task)
  pumpQueue()
  return publicTask(task)
}

export async function enqueueDownload(
  profile: RemoteTerminalProfile,
  remoteFilePath: string,
  localDirectory: string,
  totalBytes: number,
  credential: { password?: string; passphrase?: string },
  conflictPolicy: RemoteTransferTask['conflictPolicy'] = 'ask',
): Promise<RemoteTransferTask> {
  const remotePath = normalizeRemotePath(remoteFilePath)
  if (!remotePath) throw new Error('Invalid remote file path')
  const localPath = path.join(localDirectory, path.posix.basename(remotePath))
  if (conflictPolicy !== 'overwrite') {
    try {
      await fsp.access(localPath)
      if (conflictPolicy === 'rename') {
        // rename handled later in runDownload
      } else if (conflictPolicy === 'skip') {
        const task = createTransferTask(
          profile.id,
          'download',
          path.posix.basename(remotePath),
          path.basename(localPath),
          totalBytes,
          conflictPolicy,
        )
        task.state = 'completed'
        task.transferredBytes = 0
        task.finishedAt = Date.now()
        return publicTask(task)
      } else {
        throw new Error(
          'Local destination already exists; use overwrite/skip/rename conflict policy',
        )
      }
    } catch (error) {
      if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
    }
  }
  const task = createTransferTask(
    profile.id,
    'download',
    path.posix.basename(remotePath),
    path.basename(localPath),
    totalBytes,
    conflictPolicy,
  )
  transferHistory.remember(task)
  jobs.set(task.id, { task, profile, localPath, remotePath, ...credential })
  publish(task)
  pumpQueue()
  return publicTask(task)
}

export function cancelTransfer(taskId: string): { ok: boolean; error?: string } {
  const job = jobs.get(taskId)
  if (!job) {
    const historicalTask = transferHistory.get(taskId)
    if (historicalTask && isTerminalTransferTask(historicalTask)) {
      return { ok: false, error: 'Transfer already finished' }
    }
    return { ok: false, error: 'Transfer not found' }
  }
  if (job.task.state === 'completed' || job.task.state === 'failed') {
    return { ok: false, error: 'Transfer already finished' }
  }
  job.task.state = 'cancelled'
  job.task.finishedAt = Date.now()
  job.stream?.destroy()
  job.client?.end()
  publish(job.task)
  if (job.task.startedAt === undefined) forgetTransferJob(job)
  pruneTransferHistory()
  return { ok: true }
}

function pumpQueue(): void {
  while (runningCount < MAX_CONCURRENT_TRANSFERS) {
    const job = [...jobs.values()].find((candidate) => candidate.task.state === 'queued')
    if (!job) return
    runningCount++
    void runJob(job).finally(() => {
      runningCount--
      pumpQueue()
    })
  }
}

async function openSftp(job: TransferJob): Promise<{ client: Client; sftp: SFTPWrapper }> {
  const client = new Client()
  job.client = client
  const { config, hostKeyState } = buildSshConfig(job.profile)
  const authError = await prepareAuthConfig(client, config, job.profile, job)
  if (authError) throw new Error(authError)

  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      const hostError = hostKeyFailure(hostKeyState)
      reject(new Error(hostError?.message || normalizeSshError(error.message)))
    }
    client.once('ready', () => {
      client.sftp((error, sftp) => {
        if (error) {
          fail(error)
          return
        }
        settled = true
        resolve({ client, sftp })
      })
    })
    client.once('error', fail)
    client.once('close', () => fail(new Error('Connection closed before SFTP opened')))
    client.connect(config)
  })
}

function updateProgress(job: TransferJob, bytes: number, startedAt: number): void {
  job.task.transferredBytes = Math.min(bytes, job.task.totalBytes || bytes)
  const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001)
  job.task.speedBytesPerSecond = Math.round(job.task.transferredBytes / elapsedSeconds)
  const remaining = Math.max(job.task.totalBytes - job.task.transferredBytes, 0)
  job.task.etaSeconds = job.task.speedBytesPerSecond
    ? Math.ceil(remaining / job.task.speedBytesPerSecond)
    : undefined
  publish(job.task)
}

async function remoteExists(sftp: SFTPWrapper, remotePath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error) => {
      if (!error) resolve(true)
      else if (
        Number((error as NodeJS.ErrnoException).code) === 2 ||
        /no such file/i.test(error.message)
      )
        resolve(false)
      else reject(error)
    })
  })
}

async function renameRemote(sftp: SFTPWrapper, oldPath: string, newPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.rename(oldPath, newPath, (error) => (error ? reject(error) : resolve()))
  })
}

async function unlinkRemote(sftp: SFTPWrapper, remotePath: string): Promise<void> {
  await new Promise<void>((resolve) => sftp.unlink(remotePath, () => resolve()))
}

async function replaceRemoteFile(
  sftp: SFTPWrapper,
  partPath: string,
  finalPath: string,
  taskId: string,
): Promise<void> {
  const backupPath = `${finalPath}.floatingclock-${taskId}.bak`
  await renameRemote(sftp, finalPath, backupPath)
  try {
    await renameRemote(sftp, partPath, finalPath)
  } catch (error) {
    try {
      await renameRemote(sftp, backupPath, finalPath)
    } catch (rollbackError) {
      throw new Error(
        `Remote replace failed and rollback failed: ${String(error)}; ${String(rollbackError)}`,
        { cause: rollbackError },
      )
    }
    throw error
  }
  await unlinkRemote(sftp, backupPath)
}

export async function replaceLocalFile(
  partPath: string,
  finalPath: string,
  taskId: string,
): Promise<void> {
  const backupPath = `${finalPath}.floatingclock-${taskId}.bak`
  await fsp.rename(finalPath, backupPath)
  try {
    await fsp.rename(partPath, finalPath)
  } catch (error) {
    try {
      await fsp.rename(backupPath, finalPath)
    } catch (rollbackError) {
      throw new Error(
        `Local replace failed and rollback failed: ${String(error)}; ${String(rollbackError)}`,
        { cause: rollbackError },
      )
    }
    throw error
  }
  await fsp.rm(backupPath, { force: true })
}

/** Generate a non-conflicting remote path by appending (1), (2), etc. */
async function getNonConflictingRemotePath(sftp: SFTPWrapper, remotePath: string): Promise<string> {
  const dir = path.posix.dirname(remotePath)
  const ext = path.posix.extname(remotePath)
  const base = path.posix.basename(remotePath, ext)
  for (let i = 1; i < 1000; i++) {
    const candidate = path.posix.join(dir, `${base} (${i})${ext}`)
    if (!(await remoteExists(sftp, candidate))) return candidate
  }
  const ts = Date.now()
  return path.posix.join(dir, `${base}_${ts}${ext}`)
}

/** Generate a non-conflicting local path by appending (1), (2), etc. */
async function getNonConflictingLocalPath(localPath: string): Promise<string> {
  const dir = path.dirname(localPath)
  const ext = path.extname(localPath)
  const base = path.basename(localPath, ext)
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`)
    try {
      await fsp.access(candidate)
    } catch {
      return candidate
    }
  }
  const ts = Date.now()
  return path.join(dir, `${base}_${ts}${ext}`)
}

async function runUpload(job: TransferJob, sftp: SFTPWrapper): Promise<void> {
  const exists = await remoteExists(sftp, job.remotePath)
  if (exists) {
    if (job.task.conflictPolicy === 'skip') return
    if (job.task.conflictPolicy === 'rename') {
      job.remotePath = await getNonConflictingRemotePath(sftp, job.remotePath)
      job.task.destinationDisplayPath = job.remotePath
    } else if (job.task.conflictPolicy !== 'overwrite') {
      throw new Error(
        'Remote destination already exists; use overwrite/skip/rename conflict policy',
      )
    }
  }
  const partPath = `${job.remotePath}.floatingclock-${job.task.id}.part`
  const input = fs.createReadStream(job.localPath)
  const output = sftp.createWriteStream(partPath, { flags: 'wx', mode: 0o600 })
  job.stream = output
  let transferred = 0
  let lastPublished = 0
  const startedAt = Date.now()
  input.on('data', (chunk: string | Buffer) => {
    transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    if (Date.now() - lastPublished >= 150) {
      lastPublished = Date.now()
      updateProgress(job, transferred, startedAt)
    }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      input.once('error', reject)
      output.once('error', reject)
      output.once('close', resolve)
      input.pipe(output)
    })
    if (isCancelled(job)) throw new Error('Transfer cancelled')
    if (exists && job.task.conflictPolicy === 'overwrite') {
      await replaceRemoteFile(sftp, partPath, job.remotePath, job.task.id)
    } else if (await remoteExists(sftp, job.remotePath)) {
      throw new Error('Remote destination appeared during upload; overwrite blocked')
    } else {
      await renameRemote(sftp, partPath, job.remotePath)
    }
    updateProgress(job, job.task.totalBytes, startedAt)
  } catch (error) {
    input.destroy()
    output.destroy()
    await unlinkRemote(sftp, partPath)
    throw error
  }
}

async function runDownload(job: TransferJob, sftp: SFTPWrapper): Promise<void> {
  let finalLocalPath = job.localPath
  let destinationExists = false
  try {
    await fsp.access(finalLocalPath)
    destinationExists = true
    if (job.task.conflictPolicy === 'rename') {
      finalLocalPath = await getNonConflictingLocalPath(finalLocalPath)
      job.localPath = finalLocalPath
      job.task.destinationDisplayPath = path.basename(finalLocalPath)
      destinationExists = false
    } else if (job.task.conflictPolicy !== 'overwrite') {
      throw new Error('Local destination already exists')
    }
  } catch (error) {
    if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
  }
  const partPath = `${finalLocalPath}.floatingclock-${job.task.id}.part`
  const input = sftp.createReadStream(job.remotePath)
  const output = fs.createWriteStream(partPath, { flags: 'wx', mode: 0o600 })
  job.stream = input
  let transferred = 0
  let lastPublished = 0
  const startedAt = Date.now()
  input.on('data', (chunk: string | Buffer) => {
    transferred += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
    if (Date.now() - lastPublished >= 150) {
      lastPublished = Date.now()
      updateProgress(job, transferred, startedAt)
    }
  })
  try {
    await new Promise<void>((resolve, reject) => {
      input.once('error', reject)
      output.once('error', reject)
      output.once('close', resolve)
      input.pipe(output)
    })
    if (isCancelled(job)) throw new Error('Transfer cancelled')
    if (destinationExists && job.task.conflictPolicy === 'overwrite') {
      await replaceLocalFile(partPath, job.localPath, job.task.id)
    } else {
      await publishFileWithoutOverwrite(partPath, job.localPath)
      await fsp.unlink(partPath)
    }
    updateProgress(job, job.task.totalBytes || transferred, startedAt)
  } catch (error) {
    input.destroy()
    output.destroy()
    await fsp.rm(partPath, { force: true })
    throw error
  }
}

async function runJob(job: TransferJob): Promise<void> {
  if (isCancelled(job)) return
  job.task.state = 'preparing'
  job.task.startedAt = Date.now()
  publish(job.task)
  let sftp: SFTPWrapper | undefined
  try {
    const opened = await openSftp(job)
    sftp = opened.sftp
    if (isCancelled(job)) return
    job.task.state = 'running'
    publish(job.task)
    if (job.task.direction === 'upload') await runUpload(job, sftp)
    else await runDownload(job, sftp)
    if (!isCancelled(job)) {
      job.task.state = 'completed'
      job.task.finishedAt = Date.now()
      job.task.etaSeconds = 0
      publish(job.task)
    }
  } catch (error) {
    if (!isCancelled(job)) {
      job.task.state = 'failed'
      job.task.error = error instanceof Error ? error.message : String(error)
      job.task.finishedAt = Date.now()
      publish(job.task)
    }
  } finally {
    try {
      sftp?.end()
    } catch {
      // Best effort.
    }
    job.client?.end()
    forgetTransferJob(job)
    pruneTransferHistory()
  }
}
