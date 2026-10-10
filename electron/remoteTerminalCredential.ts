import type { RemoteTerminalProfile } from '../shared/ipc-contract'
import { getCredential } from './remoteCredentialService'

export type CredentialRequest = { profileId: string; password?: string; passphrase?: string }

export function normalizeCredentialRequest(raw: unknown): CredentialRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.profileId !== 'string' || !value.profileId || value.profileId.length > 256) {
    return null
  }
  if (
    (value.password !== undefined &&
      (typeof value.password !== 'string' || value.password.length > 65536)) ||
    (value.passphrase !== undefined &&
      (typeof value.passphrase !== 'string' || value.passphrase.length > 65536))
  ) {
    return null
  }
  return {
    profileId: value.profileId,
    password: typeof value.password === 'string' ? value.password : undefined,
    passphrase: typeof value.passphrase === 'string' ? value.passphrase : undefined,
  }
}

export function normalizeCredentialFields(
  credential: unknown,
): Pick<CredentialRequest, 'password' | 'passphrase'> | null {
  if (credential !== undefined && (typeof credential !== 'object' || credential === null)) {
    return null
  }
  const raw = credential as { password?: unknown; passphrase?: unknown } | undefined
  return {
    password:
      typeof raw?.password === 'string' && raw.password.length <= 65536 ? raw.password : undefined,
    passphrase:
      typeof raw?.passphrase === 'string' && raw.passphrase.length <= 65536
        ? raw.passphrase
        : undefined,
  }
}

export async function resolveStoredCredential<T extends CredentialRequest>(
  userDataPath: string,
  profile: RemoteTerminalProfile,
  request: T,
): Promise<T> {
  if (profile.authType === 'password' && !request.password) {
    const password = await getCredential(userDataPath, profile.id, 'password')
    if (password) return { ...request, password }
  }
  if (profile.authType === 'privateKey' && !request.passphrase) {
    const passphrase = await getCredential(userDataPath, profile.id, 'passphrase')
    if (passphrase) return { ...request, passphrase }
  }
  return request
}
