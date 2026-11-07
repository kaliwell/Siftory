import React from 'react'
import { createRoot } from 'react-dom/client'
import ThumbnailImage from '../../src/components/filemanager/ThumbnailImage'

const calls: Array<{ path: string; maxDim: number }> = []
const picture = (file: string) =>
  'data:image/svg+xml;base64,' +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${file.includes('a.jpg') ? '#e23' : '#23e'}"/></svg>`,
  )
Object.assign(window, {
  __thumbnailCacheLifecycle: { calls, picture },
  electronAPI: {
    fmGetThumbnailsBatch: async (requests: Array<{ path: string; maxDim: number }>) => {
      calls.push(...requests)
      return requests.map(({ path }) => ({ path, dataUrl: picture(path) }))
    },
    fmGetFileIcons: async () => [],
  },
})
function Fixture() {
  const [mounted, setMounted] = React.useState(true)
  const [deferred, setDeferred] = React.useState(false)
  const [file, setFile] = React.useState('C:/fixture/a.jpg')
  const [size, setSize] = React.useState(256)
  return (
    <>
      <button id="mount" onClick={() => setMounted((v) => !v)}>
        Mount
      </button>
      <button id="defer" onClick={() => setDeferred((v) => !v)}>
        Defer
      </button>
      <button
        id="path"
        onClick={() =>
          setFile((v) => (v.includes('a.jpg') ? 'C:/fixture/b.jpg' : 'C:/fixture/a.jpg'))
        }
      >
        Path
      </button>
      <button id="size" onClick={() => setSize((v) => (v === 256 ? 128 : 256))}>
        Size
      </button>
      <div id="preview">
        {mounted && (
          <ThumbnailImage
            filePath={file}
            ext=".jpg"
            isDirectory={false}
            targetSize={size}
            viewMode="xlarge-icon"
            deferLoading={deferred}
            loadWhenRendered
          />
        )}
      </div>
    </>
  )
}
createRoot(document.getElementById('root')!).render(<Fixture />)
