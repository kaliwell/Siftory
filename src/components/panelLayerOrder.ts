export type PanelLayerEntry = {
  id: symbol
  pinned: boolean
  setZ: (z: number) => void
}

function removePanel(entries: PanelLayerEntry[], id: symbol) {
  const index = entries.findIndex((entry) => entry.id === id)
  if (index < 0) return null
  return entries.splice(index, 1)[0]
}

function insertAtFrontOfGroup(entries: PanelLayerEntry[], entry: PanelLayerEntry) {
  if (entry.pinned) {
    entries.push(entry)
    return
  }
  const firstPinned = entries.findIndex((item) => item.pinned)
  entries.splice(firstPinned < 0 ? entries.length : firstPinned, 0, entry)
}

export function updatePanelLayerZIndices(entries: PanelLayerEntry[]) {
  entries.forEach((entry, index) => entry.setZ(10 + index))
}

export function bringPanelLayerToFront(entries: PanelLayerEntry[], id: symbol) {
  const entry = removePanel(entries, id)
  if (!entry) return
  insertAtFrontOfGroup(entries, entry)
  updatePanelLayerZIndices(entries)
}

export function sendPanelLayerToBack(entries: PanelLayerEntry[], id: symbol) {
  const entry = removePanel(entries, id)
  if (!entry) return
  if (entry.pinned) {
    const firstPinned = entries.findIndex((item) => item.pinned)
    entries.splice(firstPinned < 0 ? entries.length : firstPinned, 0, entry)
  } else {
    entries.unshift(entry)
  }
  updatePanelLayerZIndices(entries)
}

export function setPanelLayerPinned(entries: PanelLayerEntry[], id: symbol, pinned: boolean) {
  const entry = removePanel(entries, id)
  if (!entry) return
  entry.pinned = pinned
  insertAtFrontOfGroup(entries, entry)
  updatePanelLayerZIndices(entries)
}
