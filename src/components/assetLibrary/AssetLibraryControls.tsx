import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const AssetLibraryControlsTarget = createContext<HTMLElement | null>(null)

/** Keep each view's controls with its state while rendering them in the shared sidebar. */
export default function AssetLibraryControls({ children }: { children: ReactNode }) {
  const target = useContext(AssetLibraryControlsTarget)
  return target
    ? createPortal(<div className="asset-library-control-group">{children}</div>, target)
    : null
}
