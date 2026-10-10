// Remote terminal, SFTP, and transfer IPC contracts.

export interface RemoteTerminalProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey' | 'agent'
  privateKeyPath?: string
  /** OpenSSH-style SHA-256 fingerprint pinned after explicit user confirmation. */
  hostFingerprint?: string
  tags: string[]
  group?: string
  lastConnectedAt?: number
  lastTest?: {
    ok: boolean
    stage: 'profile' | 'host-key' | 'auth' | 'ready'
    durationMs: number
    message: string
    testedAt: number
  }
  lastMetrics?: RemoteServerMetricsSnapshot
  createdAt: number
  updatedAt: number
  /** Credential persistence mode. Default: 'none' (never save). */
  credentialMode?: 'none' | 'session' | 'os' | 'portableVault'
  /** Opaque credential index — must NOT contain passwords or secrets. */
  credentialRef?: string
}

export interface RemoteTerminalConnectRequest {
  profileId: string
  password?: string
  passphrase?: string
  cols: number
  rows: number
}

export interface RemoteTerminalTestRequest {
  profileId: string
  password?: string
  passphrase?: string
}

export interface RemoteTerminalTestResult {
  ok: boolean
  profileId: string
  stage: 'profile' | 'host-key' | 'auth' | 'ready'
  durationMs: number
  message: string
  hostFingerprint?: string
}

export interface RemoteServerMetricsRequest {
  profileId: string
  password?: string
  passphrase?: string
}

export interface RemoteServerMetricsSnapshot {
  ok: boolean
  profileId: string
  collectedAt: number
  durationMs: number
  host?: {
    hostname?: string
    os?: string
    kernel?: string
    arch?: string
    uptimeSeconds?: number
    loadavg?: [number, number, number]
  }
  cpu?: {
    usagePercent?: number
    cores?: number
  }
  memory?: {
    totalBytes?: number
    usedBytes?: number
    freeBytes?: number
    availableBytes?: number
    swapTotalBytes?: number
    swapUsedBytes?: number
  }
  disks?: {
    filesystem: string
    mount: string
    totalBytes: number
    usedBytes: number
    availableBytes: number
    usedPercent: number
  }[]
  network?: {
    iface: string
    rxBytes: number
    txBytes: number
  }[]
  error?: string
}

export interface RemoteTerminalSessionStatus {
  sessionId: string
  profileId: string
  state: 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'error'
  message?: string
  hostFingerprint?: string
  connectedAt?: number
  disconnectedAt?: number
}

export interface RemoteTerminalDataEvent {
  sessionId: string
  data: string
}

export interface RemoteFileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modifiedAt?: number
  accessedAt?: number
  mode?: number
  uid?: number
  gid?: number
}

export interface RemoteDirectoryResult {
  ok: boolean
  profileId: string
  path: string
  entries: RemoteFileEntry[]
  error?: string
  hostFingerprint?: string
}

/** Paginated directory listing for directories with >5000 entries. */
export interface RemoteDirectoryPage {
  ok: boolean
  profileId: string
  path: string
  entries: RemoteFileEntry[]
  total: number
  hasMore: boolean
  cursor?: string
  error?: string
  hostFingerprint?: string
}

/** Generic result for SFTP mkdir/rename/delete operations. */
export interface RemoteOperationResult {
  ok: boolean
  profileId: string
  path: string
  error?: string
  hostFingerprint?: string
}

export interface RemoteTransferTask {
  id: string
  profileId: string
  direction: 'upload' | 'download'
  sourceDisplayName: string
  destinationDisplayPath: string
  totalBytes: number
  transferredBytes: number
  speedBytesPerSecond: number
  etaSeconds?: number
  state: 'queued' | 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled'
  conflictPolicy: 'ask' | 'overwrite' | 'skip' | 'rename'
  error?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
}

export interface RemoteTransferSelection {
  ok: boolean
  token?: string
  displayName?: string
  error?: string
}

export interface RemoteTerminalResizeRequest {
  sessionId: string
  cols: number
  rows: number
}

// ── AppStorage Types ─────────────────────────────────
