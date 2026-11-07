import React from 'react'
import { createRoot } from 'react-dom/client'
import { useManagedSearchModels } from '../../src/hooks/useManagedSearchModels'

const listeners = new Set<(status: any) => void>()
const statuses: Record<string, any> = {}
let calls = 0
Object.assign(window, {
  electronAPI: {
    vector: {
      getModelStatus: async (name: string) => {
        calls++
        return statuses[name] || { name, state: 'not-downloaded' }
      },
      onModelStatusChanged: (callback: (status: any) => void) => {
        listeners.add(callback)
        return () => listeners.delete(callback)
      },
    },
  },
  __modelLifecycle: {
    snapshot: () => ({ calls, listeners: listeners.size }),
    announceReady: () => {
      for (const name of ['dinov2_vitb14', 'clip_vit_base_patch32']) {
        const status = {
          name,
          state: 'downloaded',
          installedPath: `C:/synthetic-models/${name}.onnx`,
        }
        statuses[name] = status
        listeners.forEach((callback) => callback(status))
      }
    },
  },
})
function Probe({ active }: { active: boolean }) {
  const models = useManagedSearchModels(active)
  return (
    <>
      <output id="readiness">{models.readiness.state}</output>
      <button id="explicit-refresh" onClick={() => void models.refresh()}>
        Explicit task refresh
      </button>
    </>
  )
}
function Fixture() {
  const [active, setActive] = React.useState(true)
  const [mounted, setMounted] = React.useState(true)
  return (
    <>
      <button id="visibility" onClick={() => setActive((value) => !value)}>
        Toggle visibility
      </button>
      <button id="mount" onClick={() => setMounted((value) => !value)}>
        Toggle mount
      </button>
      {mounted && <Probe active={active} />}
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
