// Synthetic bridge benchmark: production virtual grid and scheduler, generated images.
// Native IPC throughput is measured separately by run-thumbnail-performance-baseline.cjs.
import React from 'react'
import { createRoot } from 'react-dom/client'
import AssetLibraryAssetGrid from '../../src/components/AssetLibraryAssetGrid'
import '../../src/styles/global.css'

const count = Number(new URLSearchParams(location.search).get('count') || 1000)
const picture =
  'data:image/svg+xml;base64,' +
  btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="192"><rect width="256" height="192" fill="#6493b1"/></svg>',
  )
const measurements = { requests: 0, batches: 0 }
Object.assign(window, {
  __galleryPerformance: measurements,
  electronAPI: {
    fmGetThumbnailsBatch: async (requests: Array<{ path: string }>) => {
      measurements.requests += requests.length
      measurements.batches++
      return requests.map(({ path }) => ({ path, dataUrl: picture }))
    },
    fmGetFileIcons: async () => [],
  },
})
const items = Array.from({ length: count }, (_, id) => ({
  asset: {
    id,
    path: `C:/synthetic-performance/${id}.jpg`,
    kind: 'image',
    source: 'manual',
    width: 1200,
    height: 800,
    fileSize: 10000,
    modifiedTime: 1,
    createdAt: 1,
    updatedAt: 1,
    missing: false,
    favorite: false,
    rating: 0,
  },
  categories: [],
  tags: [],
}))
function Fixture() {
  const [selected, setSelected] = React.useState(new Set<number>())
  return (
    <div
      className="focused-workspace"
      style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}
    >
      <AssetLibraryAssetGrid
        items={items as never}
        categories={[]}
        tags={[]}
        selectedIds={selected}
        resetToken={count}
        onSetSelected={(ids, checked) =>
          setSelected((current) => {
            const next = new Set(current)
            ids.forEach((id) => (checked ? next.add(id) : next.delete(id)))
            return next
          })
        }
        onOpen={() => {}}
        onReveal={() => {}}
      />
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
