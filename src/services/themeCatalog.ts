export type ThemeId =
  | 'matrix-dark'
  | 'midnight-dark'
  | 'amber-dark'
  | 'frost-dark'
  | 'rose-night'
  | 'mono-dark'
  | 'pearl-rose-light'
  | 'lilac-mist-light'
  | 'violet-night'
  | 'steel-light'
  | 'graphite-dark'
  | 'deep-ocean'
  | 'forest-night'
  | 'paper-light'
  | 'slate-dark'
  | 'system-auto'
  | 'high-contrast'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ThemeGroup = 'classic' | 'soft' | 'bold' | 'neutral'
export type ThemeMaterial = 'technical' | 'glass' | 'soft' | 'flat'
export type ThemeDensity = 'compact' | 'comfortable'
export type Rgb = readonly [number, number, number]

export interface ThemePalette {
  canvas: Rgb
  surface: Rgb
  surfaceElevated: Rgb
  text: Rgb
  textMuted: Rgb
  border: Rgb
  accent: Rgb
  focus: Rgb
  success: Rgb
  warning: Rgb
  danger: Rgb
  selection: Rgb
}

export interface ThemePreset {
  id: ThemeId
  name: string
  group: ThemeGroup
  defaultMode: ThemeMode
  material: ThemeMaterial
  density: ThemeDensity
  lightAccent: Rgb
  darkAccent: Rgb
  lightTint?: Rgb
  darkTint?: Rgb
}

const rgb = (red: number, green: number, blue: number): Rgb => [red, green, blue]

export const THEME_PRESETS: readonly ThemePreset[] = Object.freeze([
  preset(
    'matrix-dark',
    'Matrix',
    'classic',
    'dark',
    'technical',
    'compact',
    rgb(0, 122, 45),
    rgb(0, 255, 92),
  ),
  preset(
    'midnight-dark',
    'Midnight',
    'classic',
    'dark',
    'glass',
    'comfortable',
    rgb(32, 92, 181),
    rgb(125, 184, 255),
  ),
  preset(
    'amber-dark',
    'Amber',
    'classic',
    'dark',
    'technical',
    'compact',
    rgb(150, 86, 0),
    rgb(255, 184, 28),
  ),
  preset(
    'frost-dark',
    'Frost',
    'classic',
    'dark',
    'glass',
    'comfortable',
    rgb(0, 117, 126),
    rgb(55, 224, 224),
  ),
  preset(
    'rose-night',
    'Rose Night',
    'soft',
    'dark',
    'soft',
    'comfortable',
    rgb(177, 49, 91),
    rgb(255, 126, 164),
  ),
  preset(
    'mono-dark',
    'Mono',
    'classic',
    'dark',
    'flat',
    'compact',
    rgb(52, 58, 67),
    rgb(240, 240, 240),
  ),
  preset(
    'pearl-rose-light',
    'Pearl Rose',
    'soft',
    'light',
    'soft',
    'comfortable',
    rgb(174, 54, 104),
    rgb(255, 137, 184),
    rgb(255, 245, 249),
  ),
  preset(
    'lilac-mist-light',
    'Lilac Mist',
    'soft',
    'light',
    'glass',
    'comfortable',
    rgb(109, 69, 174),
    rgb(199, 158, 255),
    rgb(249, 245, 255),
  ),
  preset(
    'violet-night',
    'Violet Night',
    'soft',
    'dark',
    'soft',
    'comfortable',
    rgb(104, 66, 177),
    rgb(194, 151, 255),
    undefined,
    rgb(27, 18, 45),
  ),
  preset(
    'steel-light',
    'Steel',
    'bold',
    'light',
    'flat',
    'compact',
    rgb(48, 83, 119),
    rgb(128, 179, 224),
    rgb(241, 246, 250),
  ),
  preset(
    'graphite-dark',
    'Graphite',
    'bold',
    'dark',
    'flat',
    'compact',
    rgb(67, 76, 88),
    rgb(188, 201, 216),
    undefined,
    rgb(23, 26, 31),
  ),
  preset(
    'deep-ocean',
    'Deep Ocean',
    'bold',
    'dark',
    'glass',
    'comfortable',
    rgb(0, 92, 148),
    rgb(48, 190, 255),
    undefined,
    rgb(4, 24, 39),
  ),
  preset(
    'forest-night',
    'Forest Night',
    'bold',
    'dark',
    'technical',
    'compact',
    rgb(36, 105, 70),
    rgb(91, 218, 139),
    undefined,
    rgb(10, 31, 23),
  ),
  preset(
    'paper-light',
    'Paper',
    'neutral',
    'light',
    'flat',
    'comfortable',
    rgb(69, 76, 88),
    rgb(182, 190, 203),
    rgb(252, 250, 246),
  ),
  preset(
    'slate-dark',
    'Slate',
    'neutral',
    'dark',
    'flat',
    'comfortable',
    rgb(61, 81, 108),
    rgb(160, 190, 225),
    undefined,
    rgb(22, 27, 35),
  ),
  preset(
    'system-auto',
    'System Auto',
    'neutral',
    'system',
    'glass',
    'comfortable',
    rgb(31, 98, 179),
    rgb(113, 180, 255),
  ),
  preset(
    'high-contrast',
    'High Contrast',
    'neutral',
    'system',
    'flat',
    'compact',
    rgb(0, 82, 204),
    rgb(255, 255, 0),
  ),
])

export const LEGACY_THEME_IDS: readonly ThemeId[] = THEME_PRESETS.slice(0, 6).map(
  (theme) => theme.id,
)

function preset(
  id: ThemeId,
  name: string,
  group: ThemeGroup,
  defaultMode: ThemeMode,
  material: ThemeMaterial,
  density: ThemeDensity,
  lightAccent: Rgb,
  darkAccent: Rgb,
  lightTint?: Rgb,
  darkTint?: Rgb,
): ThemePreset {
  return {
    id,
    name,
    group,
    defaultMode,
    material,
    density,
    lightAccent,
    darkAccent,
    lightTint,
    darkTint,
  }
}

export function normalizeThemeId(value: unknown, legacyIndex?: unknown): ThemeId {
  if (typeof value === 'string' && THEME_PRESETS.some((theme) => theme.id === value)) {
    return value as ThemeId
  }
  const index = typeof legacyIndex === 'number' ? legacyIndex : Number(legacyIndex)
  return LEGACY_THEME_IDS[Number.isInteger(index) ? index : 0] ?? 'matrix-dark'
}

export function normalizeThemeMode(value: unknown, themeId: ThemeId): ThemeMode {
  if (value === 'system' || value === 'light' || value === 'dark') return value
  return getThemePreset(themeId).defaultMode
}

export function getThemePreset(themeId: ThemeId): ThemePreset {
  return THEME_PRESETS.find((theme) => theme.id === themeId) ?? THEME_PRESETS[0]
}

export function legacyThemeIndex(themeId: ThemeId): number {
  const index = LEGACY_THEME_IDS.indexOf(themeId)
  return index >= 0 ? index : 0
}

export function resolveThemeMode(mode: ThemeMode, systemPrefersDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? (systemPrefersDark ? 'dark' : 'light') : mode
}

export function buildThemePalette(themeId: ThemeId, mode: 'light' | 'dark'): ThemePalette {
  if (themeId === 'high-contrast') {
    return mode === 'dark'
      ? {
          canvas: rgb(0, 0, 0),
          surface: rgb(0, 0, 0),
          surfaceElevated: rgb(16, 16, 16),
          text: rgb(255, 255, 255),
          textMuted: rgb(230, 230, 230),
          border: rgb(255, 255, 255),
          accent: rgb(255, 255, 0),
          focus: rgb(0, 255, 255),
          success: rgb(0, 255, 120),
          warning: rgb(255, 214, 0),
          danger: rgb(255, 92, 92),
          selection: rgb(40, 70, 145),
        }
      : {
          canvas: rgb(255, 255, 255),
          surface: rgb(255, 255, 255),
          surfaceElevated: rgb(242, 242, 242),
          text: rgb(0, 0, 0),
          textMuted: rgb(32, 32, 32),
          border: rgb(0, 0, 0),
          accent: rgb(0, 60, 170),
          focus: rgb(125, 0, 180),
          success: rgb(0, 95, 42),
          warning: rgb(135, 76, 0),
          danger: rgb(175, 0, 20),
          selection: rgb(190, 215, 255),
        }
  }
  const theme = getThemePreset(themeId)
  if (mode === 'light') {
    const canvas = theme.lightTint ?? rgb(247, 249, 252)
    return {
      canvas,
      surface: mix(canvas, rgb(255, 255, 255), 0.72),
      surfaceElevated: rgb(255, 255, 255),
      text: rgb(25, 29, 38),
      textMuted: rgb(75, 84, 101),
      border: rgb(112, 122, 140),
      accent: theme.lightAccent,
      focus: theme.lightAccent,
      success: rgb(20, 120, 70),
      warning: rgb(154, 91, 0),
      danger: rgb(185, 43, 55),
      selection: mix(canvas, theme.lightAccent, 0.2),
    }
  }
  const canvas = theme.darkTint ?? rgb(11, 15, 22)
  return {
    canvas,
    surface: mix(canvas, rgb(35, 42, 55), 0.62),
    surfaceElevated: mix(canvas, rgb(48, 56, 72), 0.68),
    text: rgb(240, 244, 249),
    textMuted: rgb(172, 182, 198),
    border: rgb(103, 116, 137),
    accent: theme.darkAccent,
    focus: theme.darkAccent,
    success: rgb(86, 212, 139),
    warning: rgb(255, 191, 71),
    danger: rgb(255, 104, 116),
    selection: mix(canvas, theme.darkAccent, 0.3),
  }
}

function mix(first: Rgb, second: Rgb, ratio: number): Rgb {
  return first.map((value, index) =>
    Math.round(value * (1 - ratio) + second[index] * ratio),
  ) as unknown as Rgb
}

export function rgbCss(value: Rgb): string {
  return value.join(', ')
}

export function themeCssVariables(
  themeId: ThemeId,
  mode: 'light' | 'dark',
): Record<string, string> {
  const palette = buildThemePalette(themeId, mode)
  return {
    '--color-canvas': rgbCss(palette.canvas),
    '--color-surface': rgbCss(palette.surface),
    '--color-surface-elevated': rgbCss(palette.surfaceElevated),
    '--color-text': rgbCss(palette.text),
    '--color-text-muted': rgbCss(palette.textMuted),
    '--color-border': rgbCss(palette.border),
    '--color-accent': rgbCss(palette.accent),
    '--color-focus': rgbCss(palette.focus),
    '--color-success': rgbCss(palette.success),
    '--color-warning': rgbCss(palette.warning),
    '--color-danger': rgbCss(palette.danger),
    '--color-selection': rgbCss(palette.selection),
    '--bg': rgbCss(palette.canvas),
    '--fg': rgbCss(palette.accent),
    '--date': rgbCss(palette.border),
  }
}

export function contrastRatio(first: Rgb, second: Rgb): number {
  const luminance = (value: Rgb) => {
    const channels = value.map((channel) => {
      const normalized = channel / 255
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const light = Math.max(luminance(first), luminance(second))
  const dark = Math.min(luminance(first), luminance(second))
  return (light + 0.05) / (dark + 0.05)
}
