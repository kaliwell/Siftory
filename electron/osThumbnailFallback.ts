import { nativeImage, type NativeImage } from 'electron'

/**
 * Decode a preview through the platform thumbnail provider.
 *
 * Chromium's in-process decoder (`nativeImage.createFromBuffer`/`createFromPath`)
 * accepts only PNG/JPEG buffers, and the bundled libvips build behind sharp has no
 * BMP loader. Windows (WIC) and macOS still render real pixels for those formats,
 * so BMP/ICO previews retry here before reporting "Cannot decode". Linux throws and
 * callers keep the previous error path.
 *
 * Returns null instead of throwing when the provider is unavailable, rejects the
 * file, or produces an empty image; decoding must never fail the thumbnail batch.
 */
export async function createOsThumbnail(
  filePath: string,
  dim: number,
): Promise<NativeImage | null> {
  try {
    const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
      width: dim,
      height: dim,
    })
    return thumbnail.isEmpty() ? null : thumbnail
  } catch {
    return null
  }
}
