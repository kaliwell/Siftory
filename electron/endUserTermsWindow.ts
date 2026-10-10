import { BrowserWindow } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { authorizeIpcWebContents, secureIpcMain } from './ipcAuthorization'
import { acceptEndUserTerms, hasAcceptedEndUserTerms, loadEndUserTerms } from './endUserTerms'
import type {
  TermsWindowPayload,
  ViewEndUserTermsResult,
  TermsAcceptResult,
} from '../shared/ipc/end-user-terms'

interface Options {
  resourcesRoot: string
  userDataPath: string
  appPath: string
  devServerUrl?: string
  language: 'en' | 'zh-CN'
}
interface WindowState {
  window: BrowserWindow
  payload: TermsWindowPayload
  accepted: boolean
  finished: Promise<boolean>
}

export class EndUserTermsController {
  private active: WindowState | undefined
  constructor(private readonly options: Options) {}

  register(): void {
    secureIpcMain.handle('terms:get', (event) => this.forSender(event.sender.id).payload)
    secureIpcMain.handle('terms:accept', (event, identity: unknown): TermsAcceptResult => {
      const state = this.forSender(event.sender.id)
      if (state.payload.mode !== 'accept' || state.accepted)
        return { ok: false, reason: 'invalid-request' }
      const result = acceptEndUserTerms(
        this.options.resourcesRoot,
        this.options.userDataPath,
        state.payload.terms,
        identity,
      )
      if (result.ok) {
        state.accepted = true
        // Let the invocation reply reach the renderer before destroying its frame.
        setImmediate(() => {
          if (!state.window.isDestroyed()) state.window.close()
        })
      }
      return result
    })
    secureIpcMain.handle('terms:close', (event) => {
      const state = this.forSender(event.sender.id)
      setImmediate(() => {
        if (!state.window.isDestroyed()) state.window.close()
      })
    })
    secureIpcMain.handle('app:viewEndUserTerms', (): ViewEndUserTermsResult => this.view())
  }

  private forSender(senderId: number): WindowState {
    if (
      !this.active ||
      this.active.window.isDestroyed() ||
      this.active.window.webContents.id !== senderId
    )
      throw new Error('Unauthorized terms window')
    return this.active
  }

  focus(): boolean {
    if (!this.active || this.active.window.isDestroyed()) return false
    this.active.window.show()
    this.active.window.focus()
    return true
  }

  async ensureAccepted(): Promise<boolean> {
    const loaded = loadEndUserTerms(this.options.resourcesRoot)
    if (loaded.status === 'review') return true
    if (hasAcceptedEndUserTerms(this.options.userDataPath, loaded.terms)) return true
    return this.open({ terms: loaded.terms, mode: 'accept', language: this.options.language })
      .finished
  }

  view(): ViewEndUserTermsResult {
    try {
      const loaded = loadEndUserTerms(this.options.resourcesRoot)
      if (loaded.status === 'review') return { ok: false, reason: 'not-published' }
      if (!this.focus())
        this.open({ terms: loaded.terms, mode: 'view', language: this.options.language })
      return { ok: true }
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
  }

  private open(payload: TermsWindowPayload): WindowState {
    if (this.active) throw new Error('Terms window already open')
    const page = this.options.devServerUrl
      ? new URL('/terms.html', this.options.devServerUrl).href
      : pathToFileURL(path.join(this.options.appPath, 'dist', 'terms.html')).href
    const window = new BrowserWindow({
      width: 820,
      height: 680,
      minWidth: 480,
      minHeight: 420,
      show: false,
      autoHideMenuBar: true,
      title: payload.terms.title,
      backgroundColor: '#111827',
      webPreferences: {
        preload: path.join(this.options.appPath, 'dist-electron', 'endUserTermsPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    let finish!: (accepted: boolean) => void
    const state: WindowState = {
      window,
      payload,
      accepted: false,
      finished: new Promise((resolve) => {
        finish = resolve
      }),
    }
    this.active = state
    authorizeIpcWebContents(
      window.webContents,
      (url) => url === page,
      new Set(['terms:get', 'terms:accept', 'terms:close']),
    )
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-redirect', (event) => event.preventDefault())
    window.webContents.on('render-process-gone', () => {
      if (!window.isDestroyed()) window.destroy()
    })
    window.once('closed', () => {
      if (this.active === state) this.active = undefined
      finish(state.accepted)
    })
    void window
      .loadURL(page)
      .then(() => {
        if (!window.isDestroyed()) window.show()
      })
      .catch(() => {
        if (!window.isDestroyed()) window.destroy()
      })
    return state
  }
}
