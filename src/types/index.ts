// ── Theme ──────────────────────────────────────────────────

export interface Theme {
  name: string
  bg: [number, number, number, number]
  fg: [number, number, number, number]
  date: [number, number, number, number]
}

// ── Data models ────────────────────────────────────────────

export interface Shortcut {
  name: string
  path: string
}

export interface Prompt {
  name: string
  text: string
}

export interface Tab {
  name: string
  shortcuts: Shortcut[]
}

export interface PromptTab {
  name: string
  prompts: Prompt[]
}

// ── Window positions ───────────────────────────────────────

// ── Constants ──────────────────────────────────────────────

export const THEME_COUNT = 17
export const FONT_SCALE_STEPS = [1.0, 1.25, 1.5, 2.0]
export const FONT_SCALE_COUNT = 4

export const PANEL_SIZE_DEFAULTS_VERSION = 1
export const PANEL_VISIBILITY_DEFAULTS_VERSION = 2
export const DEFAULT_LARGE_PANEL_W = 1135
export const DEFAULT_LARGE_PANEL_H = 950

export const DEFAULT_CLOCK_W = 269
export const DEFAULT_CLOCK_H = 106
export const DEFAULT_FOLDERS_W = DEFAULT_LARGE_PANEL_W
export const DEFAULT_FOLDERS_H = DEFAULT_LARGE_PANEL_H
export const DEFAULT_PROMPTS_W = 240
export const DEFAULT_PROMPTS_H = 240
export const DEFAULT_SETTINGS_W = 269
export const DEFAULT_SETTINGS_H = 996
export const DEFAULT_CALC_W = DEFAULT_LARGE_PANEL_W
export const DEFAULT_CALC_H = DEFAULT_LARGE_PANEL_H
export const DEFAULT_EDIT_W = 480
export const DEFAULT_EDIT_H = 340
export const DEFAULT_FM_W = DEFAULT_LARGE_PANEL_W
export const DEFAULT_FM_H = DEFAULT_LARGE_PANEL_H
export const DEFAULT_IMAGESEARCH_W = DEFAULT_LARGE_PANEL_W
export const DEFAULT_IMAGESEARCH_H = DEFAULT_LARGE_PANEL_H
export const DEFAULT_UNIFIED_SEARCH_W = DEFAULT_LARGE_PANEL_W
export const DEFAULT_UNIFIED_SEARCH_H = DEFAULT_LARGE_PANEL_H
export const DEFAULT_APPSTORAGE_W = DEFAULT_LARGE_PANEL_W
export const DEFAULT_APPSTORAGE_H = DEFAULT_LARGE_PANEL_H
export const DEFAULT_REMOTE_TERMINAL_W = DEFAULT_LARGE_PANEL_W
export const DEFAULT_REMOTE_TERMINAL_H = DEFAULT_LARGE_PANEL_H
export const DEFAULT_DUPLICATE_FINDER_W = DEFAULT_LARGE_PANEL_W
export const DEFAULT_DUPLICATE_FINDER_H = DEFAULT_LARGE_PANEL_H
export const DEFAULT_MEDIA_SEARCH_W = DEFAULT_LARGE_PANEL_W
export const DEFAULT_MEDIA_SEARCH_H = DEFAULT_LARGE_PANEL_H
export const DEFAULT_ASSET_LIBRARY_W = DEFAULT_LARGE_PANEL_W
export const DEFAULT_ASSET_LIBRARY_H = DEFAULT_LARGE_PANEL_H
export const DEFAULT_BATCH_RENAME_W = 420
export const DEFAULT_BATCH_RENAME_H = 480
