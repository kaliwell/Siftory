import { app, dialog } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { STORAGE_LOCATION_IPC } from '../shared/ipc/storage-location'
import { secureIpcMain } from './ipcAuthorization'
import { StorageLocationService, localStorageDirectory } from './storageLocationService'
import { migrateStorageDirectory } from './storageDirectoryMigration'
import { hardenDataDirectoryPermissions } from './dataDirectorySecurity'
import { createStorageMigrationWindow } from './storageMigrationWindow'

function externalMediaDirectory(): boolean {
  return Boolean(
    process.env.SIFTORY_MEDIA_SEARCH_DIR?.trim() ||
    process.env.FLOATING_CLOCK_MEDIA_SEARCH_DIR?.trim(),
  )
}

/** All business stores are closed at this point; only the isolated migration UI runs.
 * Relaunch after either result so Electron binds the regular session before ready.
 */
export async function prepareStorageLocationStartup(
  service: StorageLocationService,
  startupError: unknown,
): Promise<boolean> {
  if (startupError) {
    const answer = await dialog.showMessageBox({
      type: 'error',
      title: 'Siftory',
      message: '应用数据位置不可用 / Application data location unavailable',
      detail:
        '请连接原磁盘，或重新选择已有数据目录。不会自动创建空素材库。\nConnect the disk or locate your existing data directory. An empty library will not be created.',
      buttons: ['重新定位 / Locate', '退出 / Exit'],
      defaultId: 0,
      cancelId: 1,
    })
    if (answer.response === 0) {
      const selected = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (!selected.canceled && selected.filePaths[0]) {
        try {
          service.reconnect(selected.filePaths[0])
          app.relaunch()
        } catch {
          dialog.showErrorBox(
            'Siftory',
            '目录无法读取或库编号不匹配。\nThe directory is unavailable or its library identity does not match.',
          )
        }
      }
    }
    app.quit()
    return false
  }
  service.initialize()
  if (!service.read()?.pending) return true
  const controller = new AbortController()
  let progressWindow: Awaited<ReturnType<typeof createStorageMigrationWindow>> | undefined
  let result
  try {
    progressWindow = await createStorageMigrationWindow(() => controller.abort())
    result = await migrateStorageDirectory(service, {
      signal: controller.signal,
      onProgress: (value) => progressWindow?.update(value),
      protectDirectory: async (directory) => {
        const protection = await hardenDataDirectoryPermissions(directory, {
          enabled: app.isPackaged,
        })
        if (!protection.applied && protection.reason === 'failed')
          throw new Error('Cannot protect the destination data directory')
      },
    })
  } catch (error) {
    const current = service.read()
    if (!current?.pending) throw error
    // Window initialization failed before the migrator could clear its pending
    // task. Preserve the original root and recover on the next normal startup.
    service.save({
      ...current,
      pending: undefined,
      lastMigration: { state: 'failed', at: Date.now() },
    })
    result = {
      migrated: false,
      failed: true,
      reason: error instanceof Error ? error.message.slice(0, 500) : 'Migration window unavailable',
    }
  } finally {
    try {
      progressWindow?.close()
    } catch {
      // Window teardown cannot change a completed data transaction. Relaunch
      // below also disposes any remaining presentation resources.
    }
  }
  if (result.migrated) {
    app.relaunch()
    app.quit()
    return false
  }
  await dialog.showMessageBox({
    type: 'warning',
    title: 'Siftory',
    message: '迁移未完成，继续使用原数据 / Migration stopped; using the original data',
    detail:
      '旧数据没有删除或替换。请检查磁盘空间、目录权限和连接后重试。未完成的副本不会自动用于运行。\nThe original data is unchanged. Check space, permissions and disk connections before retrying.\n' +
      (result.reason ?? ''),
    buttons: ['继续 / Continue'],
  })
  // The migration UI used a temporary Chromium session root. Rebind the original
  // library's normal session in a fresh process instead of reusing that session.
  app.relaunch()
  app.quit()
  return false
}

export function registerStorageLocationIpc(
  service: StorageLocationService,
  disabled: boolean,
): void {
  let selection: { token: string; destination: string; sender: number; expires: number } | undefined
  const available = () => {
    if (disabled) throw new Error('Data migration is unavailable in an isolated test session')
  }
  secureIpcMain.handle(STORAGE_LOCATION_IPC.STATUS, () => {
    available()
    return service.status(externalMediaDirectory())
  })
  secureIpcMain.handle(STORAGE_LOCATION_IPC.SELECT, async (event) => {
    available()
    selection = undefined
    const selected = await dialog.showOpenDialog({
      title: '选择新数据目录的存放位置 / Select destination parent',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    const parent = localStorageDirectory(selected.filePaths[0])
    const destination = path.join(parent, `Siftory-data-${randomUUID().slice(0, 8)}`)
    selection = {
      token: randomUUID(),
      destination,
      sender: event.sender.id,
      expires: Date.now() + 10 * 60_000,
    }
    return { token: selection.token, destination }
  })
  secureIpcMain.handle(STORAGE_LOCATION_IPC.START, async (event, token: unknown) => {
    available()
    const chosen = selection
    selection = undefined
    if (
      !chosen ||
      token !== chosen.token ||
      event.sender.id !== chosen.sender ||
      Date.now() > chosen.expires
    )
      throw new Error('Select the destination again')
    if (externalMediaDirectory())
      throw new Error('Remove the custom video cache environment override before migrating data')
    const response = await dialog.showMessageBox({
      type: 'question',
      title: 'Siftory',
      message: '重启并迁移应用数据？ / Restart and migrate application data?',
      detail: `${service.resolveRoot()}\n→ ${chosen.destination}\n\n任务将在退出时停止。复制校验成功后切换，旧目录保留。原始素材和外部模型不会移动。\nTasks stop during exit. The old directory is retained. Original media and external models are not moved.`,
      buttons: ['取消 / Cancel', '重启并迁移 / Restart and migrate'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response.response !== 1) return { scheduled: false }
    service.schedule(chosen.destination)
    // Let the invoke settle before triggering the existing shutdown/flush chain.
    setImmediate(() => {
      app.relaunch()
      app.quit()
    })
    return { scheduled: true }
  })
}
