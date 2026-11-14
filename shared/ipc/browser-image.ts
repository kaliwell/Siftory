export type BrowserImageImportSource =
  | { kind: 'url'; url: string }
  | { kind: 'bytes'; bytes: Uint8Array }

export const BROWSER_IMAGE_IPC = {
  IMPORT: 'imageSearch:importBrowserImage',
} as const
