import type { ModelStatus } from '../../shared/vectorTypes'
import {
  MANAGED_SEARCH_MODEL_NAMES,
  isManagedSearchModelReady,
} from './managedSearchModelReadiness'

interface SearchModelInstallerApi {
  getModelStatus: (name: string) => Promise<ModelStatus>
  downloadModel: (name: string) => Promise<{ ok: boolean; error?: string }>
}

/** Resume missing pinned files in sequence; never delete a working model to repair another file. */
export async function installSearchModels(
  api: SearchModelInstallerApi,
  onStatus: (status: ModelStatus) => void,
): Promise<void> {
  for (const name of MANAGED_SEARCH_MODEL_NAMES) {
    let status = await api.getModelStatus(name)
    onStatus(status)
    if (!isManagedSearchModelReady(status)) {
      const result = await api.downloadModel(name)
      status = await api.getModelStatus(name)
      onStatus(status)
      if (!result.ok) throw new Error(result.error || `Model download failed: ${name}`)
      if (!isManagedSearchModelReady(status))
        throw new Error(status.error || `Model verification failed: ${name}`)
    }
  }
}
