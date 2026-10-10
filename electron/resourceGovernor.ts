import fs from 'fs'
import path from 'path'
import type {
  UnifiedResourceGovernorStats,
  UnifiedResourcePolicySnapshot,
  UnifiedResourcePressureReason,
  UnifiedResourceProfile,
  UnifiedTaskLane,
  UnifiedTaskPriority,
} from '../shared/ipc/unified-search'

const GIB = 1024 * 1024 * 1024
const RESOURCE_GOVERNOR_FILENAME = 'resource-governor.json'

export function resourceGovernorSettingsPath(userDataPath: string): string {
  return path.join(userDataPath, RESOURCE_GOVERNOR_FILENAME)
}

export function loadResourceGovernorProfile(userDataPath: string): UnifiedResourceProfile {
  try {
    const raw = fs.readFileSync(resourceGovernorSettingsPath(userDataPath), 'utf8')
    if (raw.length > 16_384) return 'balanced'
    const parsed = JSON.parse(raw) as { profile?: unknown }
    return normalizeUnifiedResourceProfile(parsed.profile) ?? 'balanced'
  } catch {
    return 'balanced'
  }
}

export function saveResourceGovernorProfile(
  userDataPath: string,
  profile: UnifiedResourceProfile,
): void {
  fs.mkdirSync(userDataPath, { recursive: true })
  const target = resourceGovernorSettingsPath(userDataPath)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ schema: 'siftory-resource-governor/v1', profile }, null, 2)}\n`,
      'utf8',
    )
    fs.renameSync(temporary, target)
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true })
    } catch {
      // Best-effort cleanup; the authoritative file was never replaced.
    }
    throw error
  }
}

const RESOURCE_POLICIES: Record<UnifiedResourceProfile, UnifiedResourcePolicySnapshot> = {
  'power-saver': {
    localConcurrency: 1,
    gpuConcurrency: 1,
    ioConcurrency: 1,
    maxQueued: 128,
    cpuTargetPercent: 50,
    maxWorkingSetBytes: 2 * GIB,
    minFreeMemoryBytes: 3 * GIB,
    minFreeVideoMemoryBytes: 2 * GIB,
    minFreeDiskBytes: 8 * GIB,
  },
  balanced: {
    localConcurrency: 3,
    gpuConcurrency: 1,
    ioConcurrency: 2,
    maxQueued: 512,
    cpuTargetPercent: 75,
    maxWorkingSetBytes: 4 * GIB,
    minFreeMemoryBytes: 2 * GIB,
    minFreeVideoMemoryBytes: 1 * GIB,
    minFreeDiskBytes: 4 * GIB,
  },
  quality: {
    localConcurrency: 6,
    gpuConcurrency: 2,
    ioConcurrency: 4,
    maxQueued: 1_024,
    cpuTargetPercent: 92,
    maxWorkingSetBytes: 8 * GIB,
    minFreeMemoryBytes: 1 * GIB,
    minFreeVideoMemoryBytes: 512 * 1024 * 1024,
    minFreeDiskBytes: 2 * GIB,
  },
}

export interface UnifiedResourcePressureSnapshot {
  cpuLoadPercent?: number
  processWorkingSetBytes?: number
  processTreeWorkingSetBytes?: number
  processTreePrivateBytes?: number
  electronWorkingSetBytes?: number
  electronPrivateBytes?: number
  freeSystemMemoryBytes?: number
  totalSystemMemoryBytes?: number
  freeVideoMemoryBytes?: number
  usedVideoMemoryBytes?: number
  totalVideoMemoryBytes?: number
  freeDiskBytes?: number
  onBattery?: boolean
}

export interface UnifiedResourcePressureUpdateOptions {
  hysteresis?: boolean
  enterSamples?: number
  exitSamples?: number
}

export function normalizeUnifiedResourceProfile(raw: unknown): UnifiedResourceProfile | undefined {
  return raw === 'power-saver' || raw === 'balanced' || raw === 'quality' ? raw : undefined
}

export function unifiedResourcePolicy(
  profile: UnifiedResourceProfile,
): UnifiedResourcePolicySnapshot {
  return { ...RESOURCE_POLICIES[profile] }
}

function boundedPercent(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : undefined
}

function positiveBytes(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

export class UnifiedResourceGovernor {
  private profile: UnifiedResourceProfile
  private pressure: UnifiedResourcePressureSnapshot = {}
  private cancelledForPolicy = 0
  private activePressureReasons = new Set<UnifiedResourcePressureReason>()
  private enterStreak = new Map<UnifiedResourcePressureReason, number>()
  private exitStreak = new Map<UnifiedResourcePressureReason, number>()

  constructor(profile: UnifiedResourceProfile = 'balanced') {
    this.profile = profile
  }

  setProfile(profile: UnifiedResourceProfile): void {
    this.profile = profile
    this.activePressureReasons = new Set(this.rawPressureReasons())
    this.enterStreak.clear()
    this.exitStreak.clear()
  }

  getProfile(): UnifiedResourceProfile {
    return this.profile
  }

  updatePressure(
    snapshot: UnifiedResourcePressureSnapshot,
    options: UnifiedResourcePressureUpdateOptions = {},
  ): void {
    this.pressure = {
      cpuLoadPercent: boundedPercent(snapshot.cpuLoadPercent),
      processWorkingSetBytes: positiveBytes(snapshot.processWorkingSetBytes),
      processTreeWorkingSetBytes: positiveBytes(snapshot.processTreeWorkingSetBytes),
      processTreePrivateBytes: positiveBytes(snapshot.processTreePrivateBytes),
      electronWorkingSetBytes: positiveBytes(snapshot.electronWorkingSetBytes),
      electronPrivateBytes: positiveBytes(snapshot.electronPrivateBytes),
      freeSystemMemoryBytes: positiveBytes(snapshot.freeSystemMemoryBytes),
      totalSystemMemoryBytes: positiveBytes(snapshot.totalSystemMemoryBytes),
      freeVideoMemoryBytes: positiveBytes(snapshot.freeVideoMemoryBytes),
      usedVideoMemoryBytes: positiveBytes(snapshot.usedVideoMemoryBytes),
      totalVideoMemoryBytes: positiveBytes(snapshot.totalVideoMemoryBytes),
      freeDiskBytes: positiveBytes(snapshot.freeDiskBytes),
      onBattery: snapshot.onBattery === true,
    }
    const rawReasons = new Set(this.rawPressureReasons())
    if (!options.hysteresis) {
      this.activePressureReasons = rawReasons
      this.enterStreak.clear()
      this.exitStreak.clear()
      return
    }
    const enterSamples = Math.max(1, Math.min(10, Math.floor(options.enterSamples ?? 2)))
    const exitSamples = Math.max(1, Math.min(10, Math.floor(options.exitSamples ?? 3)))
    const allReasons: UnifiedResourcePressureReason[] = ['cpu', 'memory', 'vram', 'disk', 'battery']
    for (const reason of allReasons) {
      if (rawReasons.has(reason)) {
        this.exitStreak.delete(reason)
        if (this.activePressureReasons.has(reason)) continue
        const streak = (this.enterStreak.get(reason) ?? 0) + 1
        this.enterStreak.set(reason, streak)
        if (streak >= enterSamples) {
          this.activePressureReasons.add(reason)
          this.enterStreak.delete(reason)
        }
      } else {
        this.enterStreak.delete(reason)
        if (!this.activePressureReasons.has(reason)) continue
        const streak = (this.exitStreak.get(reason) ?? 0) + 1
        this.exitStreak.set(reason, streak)
        if (streak >= exitSamples) {
          this.activePressureReasons.delete(reason)
          this.exitStreak.delete(reason)
        }
      }
    }
  }

  private rawPressureReasons(): UnifiedResourcePressureReason[] {
    const policy = RESOURCE_POLICIES[this.profile]
    const reasons: UnifiedResourcePressureReason[] = []
    if (
      this.pressure.cpuLoadPercent !== undefined &&
      this.pressure.cpuLoadPercent > policy.cpuTargetPercent
    ) {
      reasons.push('cpu')
    }
    const memoryRatio =
      this.pressure.freeSystemMemoryBytes !== undefined &&
      this.pressure.totalSystemMemoryBytes !== undefined &&
      this.pressure.totalSystemMemoryBytes > 0
        ? this.pressure.freeSystemMemoryBytes / this.pressure.totalSystemMemoryBytes
        : undefined
    const governedProcessBytes =
      this.pressure.processTreePrivateBytes ??
      this.pressure.electronPrivateBytes ??
      this.pressure.processTreeWorkingSetBytes ??
      this.pressure.electronWorkingSetBytes ??
      this.pressure.processWorkingSetBytes
    if (
      (governedProcessBytes !== undefined && governedProcessBytes > policy.maxWorkingSetBytes) ||
      (this.pressure.freeSystemMemoryBytes !== undefined &&
        this.pressure.freeSystemMemoryBytes < policy.minFreeMemoryBytes) ||
      (memoryRatio !== undefined && memoryRatio < 0.08)
    ) {
      reasons.push('memory')
    }
    if (
      this.pressure.freeVideoMemoryBytes !== undefined &&
      this.pressure.freeVideoMemoryBytes < policy.minFreeVideoMemoryBytes
    ) {
      reasons.push('vram')
    }
    if (
      this.pressure.freeDiskBytes !== undefined &&
      this.pressure.freeDiskBytes < policy.minFreeDiskBytes
    ) {
      reasons.push('disk')
    }
    if (this.profile === 'power-saver' && this.pressure.onBattery) reasons.push('battery')
    return reasons
  }

  pressureReasons(): UnifiedResourcePressureReason[] {
    return [...this.activePressureReasons]
  }

  effectiveConcurrency(lane: UnifiedTaskLane): number {
    const policy = RESOURCE_POLICIES[this.profile]
    const reasons = this.pressureReasons()
    const base = lane === 'local' ? policy.localConcurrency : policy.gpuConcurrency
    if (lane === 'gpu' && reasons.includes('vram')) return 1
    if (reasons.includes('memory') || reasons.includes('cpu'))
      return Math.max(1, Math.ceil(base / 2))
    return base
  }

  canRun(priority: UnifiedTaskPriority): boolean {
    return priority <= 2 || this.pressureReasons().length === 0
  }

  maximumQueuedTasks(): number {
    return RESOURCE_POLICIES[this.profile].maxQueued
  }

  recordPolicyCancellation(count: number): void {
    this.cancelledForPolicy += Math.max(0, Math.floor(count))
  }

  stats(overrides: Partial<Record<UnifiedTaskLane, number>> = {}): UnifiedResourceGovernorStats {
    const reasons = this.pressureReasons()
    const local = overrides.local ?? this.effectiveConcurrency('local')
    const gpu = overrides.gpu ?? this.effectiveConcurrency('gpu')
    return {
      profile: this.profile,
      policy: unifiedResourcePolicy(this.profile),
      effectiveLocalConcurrency: Math.max(1, Math.floor(local)),
      effectiveGpuConcurrency: Math.max(1, Math.floor(gpu)),
      backgroundPaused: reasons.length > 0,
      pressureReasons: reasons,
      cancelledForPolicy: this.cancelledForPolicy,
    }
  }
}
