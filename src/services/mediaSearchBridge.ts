import type {
  AudioSemanticUiStatus,
  AudioSemanticControlResult,
  MediaSearchCacheStats,
  MediaSearchBuildFramesArgs,
  MediaSearchClearCacheResult,
  MediaSearchFrameEmbeddingStats,
  MediaSearchImageDataResponse,
  MediaSearchFrameEmbeddingRequest,
  MediaSearchFrameListResponse,
  MediaSearchFrameImageSearchRequest,
  MediaSearchFrameImageSearchResponse,
  MediaSearchFrameSearchRequest,
  MediaSearchFrameSearchResponse,
  MediaSearchFrameTextSearchRequest,
  MediaSearchFrameTextSearchResponse,
  MediaSearchMultimodalSearchRequest,
  MediaSearchMultimodalSearchResponse,
  MediaSearchPrepareLibraryArgs,
  MediaSearchStartScanArgs,
  MediaSearchStatus,
  MediaSearchStatusRequest,
  MediaSearchSubtitleExtractResult,
  MediaSearchSubtitleStream,
  MediaSearchTaskProgress,
  MediaSearchToolConfigResult,
  MediaSearchTranscriptSearchRequest,
  MediaSearchTranscriptSearchResponse,
  MediaSearchVideoListResponse,
  MediaSearchVideoPathSelection,
  MediaSearchVideoPathSelectionMode,
  OpenMediaAtTimeInput,
  RevealMediaPathInput,
  VideoSemanticControlResult,
  VideoSemanticUiStatus,
} from '../../shared/ipc-contract'
import type { VideoSemanticProfileId } from '../../shared/videoSemantic'

function api() {
  const mediaSearchApi = window.electronAPI?.mediaSearch
  if (!mediaSearchApi) throw new Error('window.electronAPI.mediaSearch is unavailable')
  return mediaSearchApi
}

function logBridgeError(method: string, err: unknown): void {
  console.error(`[mediaSearchBridge.${method}]`, err)
}

export const mediaSearchBridge = {
  async getStatus(request?: MediaSearchStatusRequest): Promise<MediaSearchStatus | null> {
    try {
      return await api().getStatus(request)
    } catch (err) {
      logBridgeError('getStatus', err)
      return null
    }
  },

  async getCacheStats(): Promise<MediaSearchCacheStats | null> {
    try {
      return await api().getCacheStats()
    } catch (err) {
      logBridgeError('getCacheStats', err)
      return null
    }
  },

  async clearCache(): Promise<MediaSearchClearCacheResult> {
    try {
      return await api().clearCache()
    } catch (err) {
      logBridgeError('clearCache', err)
      return {
        ok: false,
        deletedEntries: 0,
        freedBytes: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },

  async clearData(): Promise<MediaSearchClearCacheResult> {
    try {
      return await api().clearData()
    } catch (err) {
      logBridgeError('clearData', err)
      return {
        ok: false,
        deletedEntries: 0,
        freedBytes: 0,
        removedEmbeddings: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },

  async listVideos(
    limit = 200,
    includeImages = false,
  ): Promise<MediaSearchVideoListResponse | null> {
    try {
      return await api().listVideos({ limit, includeImages })
    } catch (err) {
      logBridgeError('listVideos', err)
      return null
    }
  },

  async listFrames(
    limit = 500,
    includeImages = false,
  ): Promise<MediaSearchFrameListResponse | null> {
    try {
      return await api().listFrames({ limit, includeImages })
    } catch (err) {
      logBridgeError('listFrames', err)
      return null
    }
  },

  async getFrameImageDataUrl(imagePath: string): Promise<MediaSearchImageDataResponse> {
    try {
      return await api().getFrameImageDataUrl(imagePath)
    } catch (err) {
      logBridgeError('getFrameImageDataUrl', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async getFramePreview(frameId: string): Promise<MediaSearchImageDataResponse> {
    try {
      return await api().getFramePreview({ frameId })
    } catch (err) {
      logBridgeError('getFramePreview', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async getFrameEmbeddingStats(): Promise<MediaSearchFrameEmbeddingStats | null> {
    try {
      return await api().getFrameEmbeddingStats()
    } catch (err) {
      logBridgeError('getFrameEmbeddingStats', err)
      return null
    }
  },

  async buildFrameEmbeddings(
    request: MediaSearchFrameEmbeddingRequest,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      return await api().buildFrameEmbeddings(request)
    } catch (err) {
      logBridgeError('buildFrameEmbeddings', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async searchSimilarFrame(
    request: MediaSearchFrameSearchRequest,
  ): Promise<MediaSearchFrameSearchResponse> {
    try {
      return await api().searchSimilarFrame(request)
    } catch (err) {
      logBridgeError('searchSimilarFrame', err)
      return {
        ok: false,
        results: [],
        totalCandidates: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },

  async selectQueryImage(): Promise<{ path: string } | null> {
    try {
      return await api().selectQueryImage()
    } catch (err) {
      logBridgeError('selectQueryImage', err)
      return null
    }
  },

  async pasteClipboardImage(): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      return await api().pasteClipboardImage()
    } catch (err) {
      logBridgeError('pasteClipboardImage', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async searchFramesByImage(
    request: MediaSearchFrameImageSearchRequest,
  ): Promise<MediaSearchFrameImageSearchResponse> {
    try {
      return await api().searchFramesByImage(request)
    } catch (err) {
      logBridgeError('searchFramesByImage', err)
      return {
        ok: false,
        results: [],
        totalCandidates: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },

  async searchFramesByText(
    request: MediaSearchFrameTextSearchRequest,
  ): Promise<MediaSearchFrameTextSearchResponse> {
    try {
      return await api().searchFramesByText(request)
    } catch (err) {
      logBridgeError('searchFramesByText', err)
      return {
        ok: false,
        results: [],
        totalCandidates: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },

  async selectVideoPaths(
    mode: MediaSearchVideoPathSelectionMode = 'videos',
  ): Promise<MediaSearchVideoPathSelection | null> {
    try {
      return await api().selectVideoPaths(mode)
    } catch (err) {
      logBridgeError('selectVideoPaths', err)
      return null
    }
  },

  async listDrives(): Promise<string[]> {
    try {
      return await api().listDrives()
    } catch (err) {
      logBridgeError('listDrives', err)
      return []
    }
  },

  async validatePath(filePath: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    try {
      return await api().validatePath(filePath)
    } catch (err) {
      logBridgeError('validatePath', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async selectFfmpegDirectory(): Promise<MediaSearchToolConfigResult | null> {
    try {
      return await api().selectFfmpegDirectory()
    } catch (err) {
      logBridgeError('selectFfmpegDirectory', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async clearFfmpegDirectory(): Promise<MediaSearchToolConfigResult> {
    try {
      return await api().clearFfmpegDirectory()
    } catch (err) {
      logBridgeError('clearFfmpegDirectory', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async openFfmpegToolsDirectory(): Promise<MediaSearchToolConfigResult> {
    try {
      return await api().openFfmpegToolsDirectory()
    } catch (err) {
      logBridgeError('openFfmpegToolsDirectory', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async startScan(
    args: MediaSearchStartScanArgs,
  ): Promise<{ ok: boolean; taskId?: string; error?: string; warning?: string }> {
    try {
      return await api().startScan(args)
    } catch (err) {
      logBridgeError('startScan', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async buildFrames(
    args: MediaSearchBuildFramesArgs,
  ): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    try {
      return await api().buildFrames(args)
    } catch (err) {
      logBridgeError('buildFrames', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async prepareLibrary(
    args: MediaSearchPrepareLibraryArgs,
  ): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    try {
      return await api().prepareLibrary(args)
    } catch (err) {
      logBridgeError('prepareLibrary', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async stopTask(taskId?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      return await api().stopTask(taskId)
    } catch (err) {
      logBridgeError('stopTask', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async getTaskProgress(taskId?: string): Promise<MediaSearchTaskProgress | null> {
    try {
      return await api().getTaskProgress(taskId)
    } catch (err) {
      logBridgeError('getTaskProgress', err)
      return null
    }
  },

  async openMediaAtTime(input: OpenMediaAtTimeInput): Promise<{ ok: boolean; error?: string }> {
    try {
      return await api().openMediaAtTime(input)
    } catch (err) {
      logBridgeError('openMediaAtTime', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async revealInExplorer(input: RevealMediaPathInput): Promise<{ ok: boolean; error?: string }> {
    try {
      return await api().revealInExplorer(input)
    } catch (err) {
      logBridgeError('revealInExplorer', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  onTaskProgress(cb: (progress: MediaSearchTaskProgress) => void): (() => void) | undefined {
    try {
      return api().onTaskProgress(cb)
    } catch (err) {
      logBridgeError('onTaskProgress', err)
      return undefined
    }
  },

  onSearchProgress(cb: (progress: MediaSearchTaskProgress) => void): (() => void) | undefined {
    try {
      return api().onSearchProgress(cb)
    } catch (err) {
      logBridgeError('onSearchProgress', err)
      return undefined
    }
  },

  async detectSubtitles(videoPath: string): Promise<{
    ok: boolean
    streams?: MediaSearchSubtitleStream[]
    error?: string
  }> {
    try {
      return await api().detectSubtitles(videoPath)
    } catch (err) {
      logBridgeError('detectSubtitles', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async extractSubtitles(videoId: string): Promise<MediaSearchSubtitleExtractResult> {
    try {
      return await api().extractSubtitles(videoId)
    } catch (err) {
      logBridgeError('extractSubtitles', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async searchTranscripts(
    request: MediaSearchTranscriptSearchRequest,
  ): Promise<MediaSearchTranscriptSearchResponse> {
    try {
      return await api().searchTranscripts(request)
    } catch (err) {
      logBridgeError('searchTranscripts', err)
      return {
        ok: false,
        results: [],
        totalVideos: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },

  async searchMultimodal(
    request: MediaSearchMultimodalSearchRequest,
  ): Promise<MediaSearchMultimodalSearchResponse> {
    try {
      return await api().searchMultimodal(request)
    } catch (err) {
      logBridgeError('searchMultimodal', err)
      return {
        ok: false,
        results: [],
        totalCandidates: 0,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  },

  async getVideoSemanticStatus(
    videoId?: string,
    forceRefresh = false,
  ): Promise<VideoSemanticUiStatus | null> {
    try {
      return await api().getVideoSemanticStatus(videoId, forceRefresh)
    } catch (err) {
      logBridgeError('getVideoSemanticStatus', err)
      return null
    }
  },

  async getAudioSemanticStatus(forceRefresh = false): Promise<AudioSemanticUiStatus | null> {
    try {
      return await api().getAudioSemanticStatus(forceRefresh)
    } catch (err) {
      logBridgeError('getAudioSemanticStatus', err)
      return null
    }
  },

  async startAudioSemanticBuild(videoId?: string): Promise<AudioSemanticControlResult> {
    try {
      return await api().startAudioSemanticBuild(videoId)
    } catch (err) {
      logBridgeError('startAudioSemanticBuild', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async stopAudioSemanticBuild(jobId: string): Promise<AudioSemanticControlResult> {
    try {
      return await api().stopAudioSemanticBuild(jobId)
    } catch (err) {
      logBridgeError('stopAudioSemanticBuild', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async resumeAudioSemanticBuild(jobId: string): Promise<AudioSemanticControlResult> {
    try {
      return await api().resumeAudioSemanticBuild(jobId)
    } catch (err) {
      logBridgeError('resumeAudioSemanticBuild', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async setVideoSemanticProfile(
    videoId: string,
    profileId: VideoSemanticProfileId | 'auto',
  ): Promise<VideoSemanticControlResult> {
    try {
      return await api().setVideoSemanticProfile(videoId, profileId)
    } catch (err) {
      logBridgeError('setVideoSemanticProfile', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async startVideoSemanticBuild(videoId: string): Promise<VideoSemanticControlResult> {
    try {
      return await api().startVideoSemanticBuild(videoId)
    } catch (err) {
      logBridgeError('startVideoSemanticBuild', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async stopVideoSemanticJob(jobId: string): Promise<VideoSemanticControlResult> {
    try {
      return await api().stopVideoSemanticJob(jobId)
    } catch (err) {
      logBridgeError('stopVideoSemanticJob', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async resumeVideoSemanticJob(jobId: string): Promise<VideoSemanticControlResult> {
    try {
      return await api().resumeVideoSemanticJob(jobId)
    } catch (err) {
      logBridgeError('resumeVideoSemanticJob', err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}
