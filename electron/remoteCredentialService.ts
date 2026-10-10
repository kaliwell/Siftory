import path from 'path'
import fsp from 'fs/promises'
import { safeStorage } from 'electron'

interface StoredCredential {
  kind: 'password' | 'passphrase'
  encrypted: string
  updatedAt: number
}

interface CredentialStore {
  version: 1
  credentials: Record<string, StoredCredential>
}

const stores = new Map<string, CredentialStore>()

function storePath(userDataPath: string): string {
  return path.join(userDataPath, 'remote-terminal-credentials.json')
}

async function loadStore(userDataPath: string): Promise<CredentialStore> {
  const cached = stores.get(userDataPath)
  if (cached) return cached
  try {
    const parsed = JSON.parse(
      await fsp.readFile(storePath(userDataPath), 'utf8'),
    ) as CredentialStore
    if (parsed?.version === 1 && parsed.credentials && typeof parsed.credentials === 'object') {
      stores.set(userDataPath, parsed)
      return parsed
    }
  } catch {
    // Missing or invalid stores start empty. No decrypted secret is ever persisted.
  }
  const empty: CredentialStore = { version: 1, credentials: {} }
  stores.set(userDataPath, empty)
  return empty
}

async function persistStore(userDataPath: string, store: CredentialStore): Promise<void> {
  await fsp.mkdir(userDataPath, { recursive: true })
  const target = storePath(userDataPath)
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(temp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(temp, target)
}

export async function credentialStatus(
  userDataPath: string,
  profileId: string,
): Promise<{ available: boolean; stored: boolean; kind?: 'password' | 'passphrase' }> {
  const available = safeStorage.isEncryptionAvailable()
  if (!available) return { available: false, stored: false }
  const entry = (await loadStore(userDataPath)).credentials[profileId]
  return { available: true, stored: Boolean(entry), kind: entry?.kind }
}

export async function saveCredential(
  userDataPath: string,
  profileId: string,
  kind: 'password' | 'passphrase',
  secret: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!profileId || !secret) return { ok: false, error: 'Profile and credential are required' }
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, error: 'OS credential encryption is unavailable' }
  }
  try {
    const store = await loadStore(userDataPath)
    store.credentials[profileId] = {
      kind,
      encrypted: safeStorage.encryptString(secret).toString('base64'),
      updatedAt: Date.now(),
    }
    await persistStore(userDataPath, store)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function getCredential(
  userDataPath: string,
  profileId: string,
  expectedKind: 'password' | 'passphrase',
): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null
  const entry = (await loadStore(userDataPath)).credentials[profileId]
  if (!entry || entry.kind !== expectedKind) return null
  try {
    return safeStorage.decryptString(Buffer.from(entry.encrypted, 'base64'))
  } catch {
    return null
  }
}

export async function deleteCredential(
  userDataPath: string,
  profileId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const store = await loadStore(userDataPath)
    if (store.credentials[profileId]) {
      delete store.credentials[profileId]
      await persistStore(userDataPath, store)
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
