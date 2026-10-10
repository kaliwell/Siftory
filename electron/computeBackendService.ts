import { app } from 'electron'
import type { ComputeBackendCapability } from '../shared/vectorTypes'
import { resolveComputeBackend, selectUsableGpuDevice } from './computeBackendPolicy'

let cachedCapability: ComputeBackendCapability | null = null
let pendingCapability: Promise<ComputeBackendCapability> | null = null

export async function getComputeBackendCapability(): Promise<ComputeBackendCapability> {
  if (cachedCapability) return cachedCapability
  if (pendingCapability) return pendingCapability
  pendingCapability = (async () => {
    try {
      const info = (await app.getGPUInfo('basic')) as {
        gpuDevice?: Array<{
          active?: boolean
          deviceString?: string
          vendorId?: number
          deviceId?: number
        }>
      }
      const device = selectUsableGpuDevice(info.gpuDevice || [])
      cachedCapability = device
        ? {
            gpuAvailable: true,
            recommendedBackend: 'gpu',
            reason: 'usable-hardware-adapter',
            deviceName: device.deviceString || 'Hardware GPU',
            checkedAt: Date.now(),
          }
        : {
            gpuAvailable: false,
            recommendedBackend: 'cpu',
            reason: 'no-usable-hardware-adapter',
            checkedAt: Date.now(),
          }
    } catch (error) {
      cachedCapability = {
        gpuAvailable: false,
        recommendedBackend: 'cpu',
        reason: `gpu-detection-failed: ${error instanceof Error ? error.message : String(error)}`,
        checkedAt: Date.now(),
      }
    } finally {
      pendingCapability = null
    }
    return cachedCapability
  })()
  return pendingCapability
}

export async function resolveRequestedComputeBackend(
  preference: 'auto' | 'cpu' | 'gpu' | undefined,
): Promise<'cpu' | 'gpu'> {
  return resolveComputeBackend(preference, await getComputeBackendCapability())
}
