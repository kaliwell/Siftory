// ── Panel Auto-Arrange Engine ──────────────────────────────
// Extracted from useStore.ts to keep the store focused on state.
//
// All functions are pure (except placeNewPanel which calls setFn).
// They operate on a snapshot of the store state to compute new
// positions, then write back via Zustand's set().

import type { AppStore } from './useStore'

export type PanelRef = { name: string; x: number; y: number; w: number; h: number }
type PanelPoint = { x: number; y: number }

export const GAP = 8

function positionPatch(name: string, point: PanelPoint): Partial<AppStore> {
  switch (name) {
    case 'clock':
      return { clockPos: point }
    case 'folders':
      return { foldersPos: point }
    case 'prompts':
      return { promptsPos: point }
    case 'settings':
      return { settingsPos: point }
    case 'calc':
      return { calcPos: point }
    case 'fm':
      return { fmPos: point }
    case 'imageSearch':
      return { imageSearchPos: point }
    case 'appStorage':
      return { appStoragePos: point }
    case 'remoteTerminal':
      return { remoteTerminalPos: point }
    case 'duplicateFinder':
      return { dupFinderPos: point }
    case 'mediaSearch':
      return { mediaSearchPos: point }
    case 'assetLibrary':
      return { assetLibraryPos: point }
    default:
      return {}
  }
}

// ── Panel collection helpers ──────────────────────────────

export function collectPanels(s: AppStore): PanelRef[] {
  const all: {
    name: string
    pos: { x: number; y: number }
    size: { w: number; h: number }
    show: boolean
  }[] = [
    { name: 'clock', pos: s.clockPos, size: s.clockSize, show: s.showClock },
    { name: 'folders', pos: s.foldersPos, size: s.foldersSize, show: s.showFolders },
    { name: 'prompts', pos: s.promptsPos, size: s.promptsSize, show: s.showPrompts },
    { name: 'settings', pos: s.settingsPos, size: s.settingsSize, show: s.showSettings },
    { name: 'calc', pos: s.calcPos, size: s.calcSize, show: s.showCalc },
    { name: 'fm', pos: s.fmPos, size: s.fmSize, show: s.showFM },
    {
      name: 'imageSearch',
      pos: s.imageSearchPos,
      size: s.imageSearchSize,
      show: s.showImageSearch,
    },
    {
      name: 'mediaSearch',
      pos: s.mediaSearchPos,
      size: s.mediaSearchSize,
      show: s.showMediaSearch,
    },
    {
      name: 'assetLibrary',
      pos: s.assetLibraryPos,
      size: s.assetLibrarySize,
      show: s.showAssetLibrary,
    },
  ]
  return all
    .filter((p) => p.show && !s.lockedPanels[p.name])
    .map((p) => ({ name: p.name, x: p.pos.x, y: p.pos.y, w: p.size.w, h: p.size.h }))
}

export function collectLockedPanels(s: AppStore): PanelRef[] {
  const all: {
    name: string
    pos: { x: number; y: number }
    size: { w: number; h: number }
    show: boolean
  }[] = [
    { name: 'clock', pos: s.clockPos, size: s.clockSize, show: s.showClock },
    { name: 'folders', pos: s.foldersPos, size: s.foldersSize, show: s.showFolders },
    { name: 'prompts', pos: s.promptsPos, size: s.promptsSize, show: s.showPrompts },
    { name: 'settings', pos: s.settingsPos, size: s.settingsSize, show: s.showSettings },
    { name: 'calc', pos: s.calcPos, size: s.calcSize, show: s.showCalc },
    { name: 'fm', pos: s.fmPos, size: s.fmSize, show: s.showFM },
    {
      name: 'imageSearch',
      pos: s.imageSearchPos,
      size: s.imageSearchSize,
      show: s.showImageSearch,
    },
    {
      name: 'mediaSearch',
      pos: s.mediaSearchPos,
      size: s.mediaSearchSize,
      show: s.showMediaSearch,
    },
    {
      name: 'assetLibrary',
      pos: s.assetLibraryPos,
      size: s.assetLibrarySize,
      show: s.showAssetLibrary,
    },
  ]
  return all
    .filter((p) => p.show && !!s.lockedPanels[p.name])
    .map((p) => ({ name: p.name, x: p.pos.x, y: p.pos.y, w: p.size.w, h: p.size.h }))
}

// ── Viewport / clamping ───────────────────────────────────

export function getViewportSize(s: AppStore): { width: number; height: number } {
  const width =
    s.workArea.width > 0
      ? s.workArea.width
      : typeof window !== 'undefined'
        ? window.innerWidth
        : 1920
  const height =
    s.workArea.height > 0
      ? s.workArea.height
      : typeof window !== 'undefined'
        ? window.innerHeight
        : 1080
  return { width, height }
}

export function clampPanelToViewport(panel: PanelRef, s: AppStore): PanelRef {
  const { width, height } = getViewportSize(s)
  return {
    ...panel,
    x: Math.max(0, Math.min(panel.x, Math.max(0, width - panel.w))),
    y: Math.max(0, Math.min(panel.y, Math.max(0, height - panel.h))),
  }
}

export function panelsOverlap(a: PanelRef, b: PanelRef): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function clampAnchor(x: number, y: number, s: AppStore): { x: number; y: number } {
  const { width, height } = getViewportSize(s)
  return {
    x: Math.max(0, Math.min(x, Math.max(0, width - 1))),
    y: Math.max(0, Math.min(y, Math.max(0, height - 1))),
  }
}

// ── Collision resolution ──────────────────────────────────

export function resolveCollisions(panels: PanelRef[], obstacles: PanelRef[]): PanelRef[] {
  if (obstacles.length === 0) return panels

  return panels.map((p) => {
    const { w, h } = p
    let { x, y } = p
    let iterations = 0
    outer: while (iterations < 20) {
      iterations++
      for (const obs of obstacles) {
        if (obs.name === p.name) continue
        if (x < obs.x + obs.w && x + w > obs.x && y < obs.y + obs.h && y + h > obs.y) {
          const shiftRight = obs.x + obs.w - x + GAP
          const shiftDown = obs.y + obs.h - y + GAP
          if (shiftRight <= shiftDown) {
            x = obs.x + obs.w + GAP
          } else {
            y = obs.y + obs.h + GAP
          }
          continue outer
        }
      }
      break
    }
    return { ...p, x, y }
  })
}

// ── Placement ─────────────────────────────────────────────

export function placeNewPanel(
  s: AppStore,
  name: string,
  setFn: (partial: Partial<AppStore>) => void,
) {
  const panels = collectPanels(s)
  let rightmost = 50
  for (const p of panels) {
    if (p.name === name) continue
    rightmost = Math.max(rightmost, p.x + p.w)
  }
  const newX = rightmost + GAP
  const newY = panels.length <= 1 ? 50 : s.clockPos.y

  const posKey = (name + 'Pos') as keyof AppStore
  const sizeKey = (name + 'Size') as keyof AppStore
  const sz = s[sizeKey] as { w: number; h: number } | undefined
  const clamped = clampPanelToViewport(
    {
      name,
      x: newX,
      y: newY,
      w: sz?.w ?? 240,
      h: sz?.h ?? 200,
    },
    s,
  )
  setFn(positionPatch(String(posKey).replace(/Pos$/, ''), { x: clamped.x, y: clamped.y }))
}

// ── Packing / layout ──────────────────────────────────────

export function packPanels(
  panels: PanelRef[],
  s: AppStore,
  direction: 'row' | 'column' = 'row',
  startX?: number,
  startY?: number,
): PanelRef[] {
  if (panels.length === 0) return []
  const { width, height } = getViewportSize(s)
  const anchor = clampAnchor(
    startX ?? Math.min(...panels.map((p) => p.x)),
    startY ?? Math.min(...panels.map((p) => p.y)),
    s,
  )
  const obstacles = collectLockedPanels(s).map((p) => clampPanelToViewport(p, s))
  const placed: PanelRef[] = []

  const collides = (candidate: PanelRef) =>
    [...obstacles, ...placed].some((other) => panelsOverlap(candidate, other))

  const maxAttempts = Math.max(40, panels.length * 24)
  let cursorX = anchor.x
  let cursorY = anchor.y
  let laneSize = 0

  const nextCandidate = (p: PanelRef): PanelRef => {
    if (direction === 'row') {
      if (cursorX > anchor.x && cursorX + p.w > width) {
        cursorX = anchor.x
        cursorY += laneSize + GAP
        laneSize = 0
      }
      return { ...p, x: cursorX, y: cursorY }
    }
    if (cursorY > anchor.y && cursorY + p.h > height) {
      cursorY = anchor.y
      cursorX += laneSize + GAP
      laneSize = 0
    }
    return { ...p, x: cursorX, y: cursorY }
  }

  for (const p of panels) {
    let candidate = clampPanelToViewport(nextCandidate(p), s)
    let attempts = 0
    while (collides(candidate) && attempts < maxAttempts) {
      attempts++
      if (direction === 'row') {
        cursorX += Math.max(1, p.w + GAP)
        if (cursorX + p.w > width) {
          cursorX = anchor.x
          cursorY += Math.max(laneSize, p.h) + GAP
          laneSize = 0
        }
      } else {
        cursorY += Math.max(1, p.h + GAP)
        if (cursorY + p.h > height) {
          cursorY = anchor.y
          cursorX += Math.max(laneSize, p.w) + GAP
          laneSize = 0
        }
      }
      candidate = clampPanelToViewport(nextCandidate(p), s)
    }

    if (collides(candidate)) {
      const maxX = Math.max(0, width - p.w)
      const maxY = Math.max(0, height - p.h)
      const step = Math.max(GAP, Math.min(40, Math.floor(Math.min(p.w, p.h) / 2)))
      const yStarts = [anchor.y, 0]
      const xStarts = [anchor.x, 0]
      let found: PanelRef | null = null
      for (const yStart of yStarts) {
        for (let y = Math.min(yStart, maxY); y <= maxY && !found; y += step) {
          for (const xStart of xStarts) {
            for (let x = Math.min(xStart, maxX); x <= maxX; x += step) {
              const probe = { ...p, x, y }
              if (!collides(probe)) {
                found = probe
                break
              }
            }
            if (found) break
          }
        }
      }
      if (found) candidate = found
    }

    placed.push(candidate)
    if (direction === 'row') {
      cursorX = candidate.x + p.w + GAP
      laneSize = Math.max(laneSize, p.h)
    } else {
      cursorY = candidate.y + p.h + GAP
      laneSize = Math.max(laneSize, p.w)
    }
  }

  return placed
}

export function screenClamp(panels: PanelRef[], s: AppStore): PanelRef[] {
  if (panels.length === 0) return panels
  const { width: w, height: h } = getViewportSize(s)

  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const p of panels) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + p.w)
    maxY = Math.max(maxY, p.y + p.h)
  }

  let shiftX = 0,
    shiftY = 0
  if (minX < 0) shiftX -= minX
  if (minY < 0) shiftY -= minY
  if (maxX > w) shiftX -= maxX - w
  if (maxY > h) shiftY -= maxY - h

  if (shiftX === 0 && shiftY === 0) return panels

  return panels
    .map((p) => ({ ...p, x: p.x + shiftX, y: p.y + shiftY }))
    .map((p) => clampPanelToViewport(p, s))
}

export function applyPositions(
  set: (partial: Partial<AppStore>) => void,
  s: AppStore,
  result: Record<string, { x: number; y: number }>,
  direction: 'row' | 'column' = 'row',
) {
  const refs: PanelRef[] = []
  for (const name of Object.keys(result)) {
    const pos = result[name]
    const sizeKey = (name + 'Size') as keyof AppStore
    const sz = s[sizeKey] as { w: number; h: number } | undefined
    refs.push({ name, x: pos.x, y: pos.y, w: sz?.w ?? 240, h: sz?.h ?? 200 })
  }
  const bounded = packPanels(refs, s, direction)
  const final: Record<string, { x: number; y: number }> = {}
  for (const p of bounded) final[p.name] = { x: p.x, y: p.y }

  set({
    clockPos: final['clock'] ?? s.clockPos,
    foldersPos: final['folders'] ?? s.foldersPos,
    promptsPos: final['prompts'] ?? s.promptsPos,
    settingsPos: final['settings'] ?? s.settingsPos,
    calcPos: final['calc'] ?? s.calcPos,
    fmPos: final['fm'] ?? s.fmPos,
    imageSearchPos: final['imageSearch'] ?? s.imageSearchPos,
    mediaSearchPos: final['mediaSearch'] ?? s.mediaSearchPos,
    assetLibraryPos: final['assetLibrary'] ?? s.assetLibraryPos,
  })
}

// ── Top-level arrange actions ─────────────────────────────

export function autoArrange(set: (p: Partial<AppStore>) => void, get: () => AppStore) {
  const s = get()
  const allPanels = collectPanels(s)
  if (allPanels.length === 0) return

  const large = allPanels.filter((p) => p.w > 400)
  const small = allPanels.filter((p) => p.w <= 400)

  const anchorX = Math.min(...allPanels.map((p) => p.x))
  const anchorY = Math.min(...allPanels.map((p) => p.y))

  // Place large panels top-left, small panels below
  let yOffset = anchorY
  for (const p of large) {
    const clamped = clampPanelToViewport({ ...p, x: anchorX, y: yOffset }, s)
    set(positionPatch(p.name, { x: clamped.x, y: clamped.y }))
    yOffset += p.h + GAP
  }
  // Pack remaining small panels
  if (small.length > 0) {
    const result: Record<string, { x: number; y: number }> = {}
    for (const p of small) result[p.name] = { x: p.x, y: p.y }
    const obstacles = collectLockedPanels(s)
    let resolved = resolveCollisions(
      small.map((p) => clampPanelToViewport(p, s)),
      obstacles,
    )
    resolved = screenClamp(resolved, s)
    for (const p of resolved) result[p.name] = { x: p.x, y: p.y }
    applyPositions(set, s, result, 'row')
  }
}

export function arrangeHorizontal(set: (p: Partial<AppStore>) => void, get: () => AppStore) {
  const s = get()
  const { width: maxW } = getViewportSize(s)
  const panels = collectPanels(s).sort((a, b) => a.x - b.x)
  if (panels.length === 0) return
  const anchorX = Math.min(...panels.map((p) => p.x))
  const anchorY = Math.min(...panels.map((p) => p.y))

  const result: Record<string, { x: number; y: number }> = {}
  let rowY = anchorY
  let rowH = 0
  let cx = anchorX
  for (const p of panels) {
    if (cx > anchorX && cx + p.w > maxW) {
      rowY += rowH + GAP
      rowH = 0
      cx = anchorX
    }
    result[p.name] = { x: cx, y: rowY }
    cx += p.w + GAP
    rowH = Math.max(rowH, p.h)
  }
  applyPositions(set, s, result, 'row')
}

export function arrangeVertical(set: (p: Partial<AppStore>) => void, get: () => AppStore) {
  const s = get()
  const { height: maxH } = getViewportSize(s)
  const panels = collectPanels(s).sort((a, b) => a.y - b.y)
  if (panels.length === 0) return
  const anchorX = Math.min(...panels.map((p) => p.x))
  const anchorY = Math.min(...panels.map((p) => p.y))

  const result: Record<string, { x: number; y: number }> = {}
  let colX = anchorX
  let colW = 0
  let cy = anchorY
  for (const p of panels) {
    if (cy > anchorY && cy + p.h > maxH) {
      colX += colW + GAP
      colW = 0
      cy = anchorY
    }
    result[p.name] = { x: colX, y: cy }
    cy += p.h + GAP
    colW = Math.max(colW, p.w)
  }
  applyPositions(set, s, result, 'column')
}
