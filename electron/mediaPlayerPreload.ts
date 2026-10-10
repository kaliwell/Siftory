import { contextBridge, ipcRenderer } from 'electron'
import {
  MEDIA_PLAYER_EXPORT_IPC,
  type MediaPlayerExportApi,
  type MediaPlayerExportRequest,
} from '../shared/ipc/media-player-export'

const tokenPrefix = '--siftory-player-export-token='
const exportToken = process.argv
  .find((argument) => argument.startsWith(tokenPrefix))
  ?.slice(tokenPrefix.length)

const api: MediaPlayerExportApi = Object.freeze({
  exportSelection: (request: MediaPlayerExportRequest) => {
    if (!exportToken) {
      return Promise.resolve({ ok: false, error: 'The player export permission is unavailable' })
    }
    return ipcRenderer.invoke(MEDIA_PLAYER_EXPORT_IPC.SAVE_SELECTION, {
      ...request,
      token: exportToken,
    })
  },
})

contextBridge.exposeInMainWorld('siftoryMediaPlayer', api)
