import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const AssetLibraryControlsTarget = createContext<HTMLElement | null | undefined>(undefined)

/** Browsing uses inline controls; specialist views share a control sidebar. */
export default function AssetLibraryControls({ children }: { children: ReactNode }) {
  const target = useContext(AssetLibraryControlsTarget)
  const content = <div className="asset-library-control-group">{children}</div>
  if (target === null) return content
  return target ? createPortal(content, target) : null
}
