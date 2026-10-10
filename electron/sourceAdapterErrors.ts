export type SourceAdapterErrorCode =
  | 'ADAPTER_UNAVAILABLE'
  | 'SCAN_START_FAILED'
  | 'SCAN_FAILED'
  | 'SOURCE_OFFLINE'
  | 'PERMISSION_DENIED'
  | 'SCAN_CANCELLED'
  | 'HOST_KEY_UNVERIFIED'
  | 'HOST_KEY_CHANGED'
  | 'CREDENTIAL_UNAVAILABLE'

export class SourceAdapterError extends Error {
  constructor(
    readonly code: SourceAdapterErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SourceAdapterError'
  }
}
