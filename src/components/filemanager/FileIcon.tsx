// ── Extension → icon mapping ──────────────────────────────

const ICON_MAP: Record<string, string> = {
  // Images
  '.jpg': '🖼️',
  '.jpeg': '🖼️',
  '.png': '🖼️',
  '.webp': '🖼️',
  '.gif': '🎞️',
  '.bmp': '🖼️',
  '.svg': '🖼️',
  '.avif': '🖼️',
  '.ico': '🖼️',
  '.tiff': '🖼️',
  '.tif': '🖼️',
  '.psd': '🖼️',

  // Video
  '.mp4': '🎬',
  '.mov': '🎬',
  '.avi': '🎬',
  '.mkv': '🎬',
  '.wmv': '🎬',
  '.flv': '🎬',
  '.webm': '🎬',

  // Audio
  '.mp3': '🎵',
  '.wav': '🎵',
  '.flac': '🎵',
  '.aac': '🎵',
  '.ogg': '🎵',
  '.wma': '🎵',
  '.m4a': '🎵',

  // Archives
  '.zip': '📦',
  '.rar': '📦',
  '.7z': '📦',
  '.tar': '📦',
  '.gz': '📦',
  '.bz2': '📦',
  '.xz': '📦',

  // Documents
  '.pdf': '📕',
  '.doc': '📄',
  '.docx': '📄',
  '.xls': '📊',
  '.xlsx': '📊',
  '.ppt': '📽️',
  '.pptx': '📽️',
  '.txt': '📝',
  '.md': '📝',
  '.rtf': '📄',
  '.csv': '📊',

  // Code
  '.html': '💻',
  '.css': '💻',
  '.js': '💻',
  '.ts': '💻',
  '.jsx': '💻',
  '.tsx': '💻',
  '.json': '💻',
  '.xml': '💻',
  '.py': '💻',
  '.java': '💻',
  '.c': '💻',
  '.cpp': '💻',
  '.h': '💻',
  '.rs': '💻',
  '.go': '💻',
  '.rb': '💻',
  '.php': '💻',
  '.sql': '💻',
  '.sh': '💻',
  '.bat': '💻',
  '.ps1': '💻',
  '.yaml': '💻',
  '.yml': '💻',
  '.toml': '💻',

  // Executables
  '.exe': '⚙️',
  '.msi': '⚙️',
  '.app': '⚙️',
  '.dll': '⚙️',

  // Fonts
  '.ttf': '🔤',
  '.otf': '🔤',
  '.woff': '🔤',
  '.woff2': '🔤',

  // Shortcuts
  '.lnk': '🔗',
  '.url': '🔗',
}

export function getFileIcon(ext: string, isDirectory: boolean): string {
  if (isDirectory) return '📁'
  return ICON_MAP[ext.toLowerCase()] || '📄'
}

/** Human-readable category label for a file extension */
export function getFileCategory(ext: string, isDirectory: boolean): string {
  if (isDirectory) return '文件夹'

  const e = ext.toLowerCase()
  if (
    [
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
      '.gif',
      '.bmp',
      '.svg',
      '.avif',
      '.ico',
      '.tiff',
      '.tif',
    ].includes(e)
  )
    return '图片'
  if (e === '.psd') return 'Adobe Photoshop Image'
  if (['.mp4', '.mov', '.avi', '.mkv', '.wmv', '.flv', '.webm'].includes(e)) return '视频'
  if (['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a'].includes(e)) return '音频'
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'].includes(e)) return '压缩包'
  if (['.pdf'].includes(e)) return 'PDF 文档'
  if (['.doc', '.docx'].includes(e)) return 'Word 文档'
  if (['.xls', '.xlsx', '.csv'].includes(e)) return 'Excel 表格'
  if (['.ppt', '.pptx'].includes(e)) return 'PowerPoint 演示'
  if (['.txt', '.md', '.rtf'].includes(e)) return '文本文档'
  if (
    [
      '.html',
      '.css',
      '.js',
      '.ts',
      '.jsx',
      '.tsx',
      '.json',
      '.xml',
      '.py',
      '.java',
      '.c',
      '.cpp',
      '.h',
      '.rs',
      '.go',
      '.rb',
      '.php',
      '.sql',
      '.sh',
      '.bat',
      '.ps1',
      '.yaml',
      '.yml',
      '.toml',
    ].includes(e)
  )
    return '代码文件'
  if (['.exe', '.msi', '.dll'].includes(e)) return '应用程序'
  if (['.lnk', '.url'].includes(e)) return '快捷方式'
  if (['.ttf', '.otf', '.woff', '.woff2'].includes(e)) return '字体文件'

  return ext ? `${ext.toUpperCase().slice(1)} 文件` : '未知文件'
}
