import type { ComputeBackendCapability } from '../shared/vectorTypes'

export interface GpuDeviceCandidate {
  active?: boolean
  deviceString?: string
  vendorId?: number
  deviceId?: number
}

const SOFTWARE_ADAPTER_NAMES = [
  'swiftshader',
  'microsoft basic render',
  'software adapter',
  'llvmpipe',
]

export function selectUsableGpuDevice(
  devices: readonly GpuDeviceCandidate[],
): GpuDeviceCandidate | null {
  const usable = devices.filter((device) => {
    const name = String(device.deviceString || '').toLowerCase()
    if (SOFTWARE_ADAPTER_NAMES.some((token) => name.includes(token))) return false
    return Boolean(name || device.vendorId || device.deviceId)
  })
  return usable.find((device) => device.active) ?? usable[0] ?? null
}

export function resolveComputeBackend(
  preference: 'auto' | 'cpu' | 'gpu' | undefined,
  capability: ComputeBackendCapability,
): 'cpu' | 'gpu' {
  if (preference === 'cpu') return 'cpu'
  return capability.gpuAvailable ? 'gpu' : 'cpu'
}
