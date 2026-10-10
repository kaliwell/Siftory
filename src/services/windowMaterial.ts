export type WindowSurfaceMode = 'solid' | 'glass'

export interface WindowMaterial {
  mode: WindowSurfaceMode
  transparency: number
  surfaceAlpha: number
  blurPx: number
  saturation: number
}

export function resolveWindowMaterial(value: unknown): WindowMaterial {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0
  const transparency = Math.max(0, Math.min(60, Math.round(numeric)))
  if (transparency === 0) {
    return {
      mode: 'solid',
      transparency,
      surfaceAlpha: 0.98,
      blurPx: 0,
      saturation: 1,
    }
  }

  const strength = (transparency - 1) / 59
  return {
    mode: 'glass',
    transparency,
    surfaceAlpha: Number((0.92 - strength * 0.4).toFixed(3)),
    blurPx: Number((14 + strength * 14).toFixed(2)),
    saturation: Number((1.18 + strength * 0.22).toFixed(3)),
  }
}
