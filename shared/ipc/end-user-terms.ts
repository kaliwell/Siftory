export interface EndUserTerms {
  title: string
  version: string
  publisher: string
  effectiveDate: string
  text: string
  sha256: string
}

export interface TermsWindowPayload {
  terms: EndUserTerms
  mode: 'accept' | 'view'
  language: 'en' | 'zh-CN'
}

export type TermsAcceptResult =
  | { ok: true }
  | { ok: false; reason: 'invalid-request' | 'stale-terms' | 'save-failed' }

export type ViewEndUserTermsResult =
  | { ok: true }
  | { ok: false; reason: 'not-published' | 'unavailable' }

export interface TermsWindowAPI {
  get: () => Promise<TermsWindowPayload>
  accept: (identity: { version: string; sha256: string }) => Promise<TermsAcceptResult>
  close: () => Promise<void>
}
