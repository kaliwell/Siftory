import type { WorkspacePanel } from './focusedWorkspace'

export type WorkspaceRoute =
  | 'all-search'
  | 'image-search'
  | 'video-search'
  | 'image-sources'
  | 'video-sources'
export const WORKSPACE_ROUTES: Record<
  WorkspaceRoute,
  { panel: WorkspacePanel; view?: 'search' | 'sources' }
> = {
  // Compatibility for old callers; combined search is retired.
  'all-search': { panel: 'imageSearch', view: 'search' },
  'image-search': { panel: 'imageSearch', view: 'search' },
  'video-search': { panel: 'mediaSearch', view: 'search' },
  'image-sources': { panel: 'imageSearch', view: 'sources' },
  'video-sources': { panel: 'mediaSearch', view: 'sources' },
}

export function resolveWorkspaceRoute(
  panel: WorkspacePanel | undefined,
  imageView?: string,
  videoView?: string,
): WorkspaceRoute | undefined {
  if (panel === 'unifiedSearch') return 'image-search'
  if (panel === 'imageSearch') return imageView === 'search' ? 'image-search' : 'image-sources'
  // Saved video indexing layouts continue to open library preparation.
  if (panel === 'mediaSearch') return videoView === 'search' ? 'video-search' : 'video-sources'
  return undefined
}
