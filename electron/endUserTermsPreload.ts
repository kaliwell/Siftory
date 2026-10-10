import { contextBridge, ipcRenderer } from 'electron'
import type { TermsWindowAPI } from '../shared/ipc/end-user-terms'

const api: TermsWindowAPI = Object.freeze({
  get: () => ipcRenderer.invoke('terms:get'),
  accept: (identity: Parameters<TermsWindowAPI['accept']>[0]) =>
    ipcRenderer.invoke('terms:accept', identity),
  close: () => ipcRenderer.invoke('terms:close'),
})
contextBridge.exposeInMainWorld('termsAPI', api)
