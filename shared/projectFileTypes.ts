export type ProjectSourceExt =
  | 'psd'
  | 'psb'
  | 'kra'
  | 'svg'
  | 'pdf'
  | 'ai'
  | 'eps'
  | 'tif'
  | 'tiff'
  | 'cr2'
  | 'cr3'
  | 'nef'
  | 'arw'
  | 'dng'
  | 'raf'
  | 'orf'
  | 'rw2'
  | 'pef'
  | 'srw'
  | 'clip'
  | 'cdr'
  | 'indd'

export interface ProjectFileClassification {
  sourceKind: 'project'
  sourceExt: ProjectSourceExt
  displayType: string
  keywords: string[]
}

const PROJECT_FILE_TYPES: Record<ProjectSourceExt, Omit<ProjectFileClassification, 'sourceExt'>> = {
  psd: {
    sourceKind: 'project',
    displayType: 'Photoshop PSD',
    keywords: ['project-file', 'photoshop', 'psd', 'layered', 'editable'],
  },
  psb: {
    sourceKind: 'project',
    displayType: 'Photoshop PSB',
    keywords: ['project-file', 'photoshop', 'psb', 'large-document', 'layered', 'editable'],
  },
  kra: {
    sourceKind: 'project',
    displayType: 'Krita project',
    keywords: ['project-file', 'krita', 'kra', 'layered', 'editable'],
  },
  svg: {
    sourceKind: 'project',
    displayType: 'SVG vector',
    keywords: ['project-file', 'svg', 'vector', 'editable'],
  },
  pdf: {
    sourceKind: 'project',
    displayType: 'PDF document',
    keywords: ['project-file', 'pdf', 'multipage'],
  },
  ai: {
    sourceKind: 'project',
    displayType: 'Illustrator project',
    keywords: ['project-file', 'illustrator', 'ai', 'vector', 'editable'],
  },
  eps: {
    sourceKind: 'project',
    displayType: 'EPS vector',
    keywords: ['project-file', 'eps', 'vector', 'editable'],
  },
  tif: {
    sourceKind: 'project',
    displayType: 'TIFF artwork',
    keywords: ['project-file', 'tiff', 'raster', 'editable'],
  },
  tiff: {
    sourceKind: 'project',
    displayType: 'TIFF artwork',
    keywords: ['project-file', 'tiff', 'raster', 'editable'],
  },
  cr2: {
    sourceKind: 'project',
    displayType: 'Canon RAW',
    keywords: ['project-file', 'raw', 'camera-raw', 'canon'],
  },
  cr3: {
    sourceKind: 'project',
    displayType: 'Canon RAW',
    keywords: ['project-file', 'raw', 'camera-raw', 'canon'],
  },
  nef: {
    sourceKind: 'project',
    displayType: 'Nikon RAW',
    keywords: ['project-file', 'raw', 'camera-raw', 'nikon'],
  },
  arw: {
    sourceKind: 'project',
    displayType: 'Sony RAW',
    keywords: ['project-file', 'raw', 'camera-raw', 'sony'],
  },
  dng: {
    sourceKind: 'project',
    displayType: 'Digital Negative',
    keywords: ['project-file', 'raw', 'camera-raw', 'dng'],
  },
  raf: {
    sourceKind: 'project',
    displayType: 'Fujifilm RAW',
    keywords: ['project-file', 'raw', 'camera-raw', 'fujifilm'],
  },
  orf: {
    sourceKind: 'project',
    displayType: 'OM System RAW',
    keywords: ['project-file', 'raw', 'camera-raw', 'om-system'],
  },
  rw2: {
    sourceKind: 'project',
    displayType: 'Panasonic RAW',
    keywords: ['project-file', 'raw', 'camera-raw', 'panasonic'],
  },
  pef: {
    sourceKind: 'project',
    displayType: 'Pentax RAW',
    keywords: ['project-file', 'raw', 'camera-raw', 'pentax'],
  },
  srw: {
    sourceKind: 'project',
    displayType: 'Samsung RAW',
    keywords: ['project-file', 'raw', 'camera-raw', 'samsung'],
  },
  clip: {
    sourceKind: 'project',
    displayType: 'CLIP Studio project',
    keywords: ['project-file', 'clip-studio', 'clip', 'layered', 'editable'],
  },
  cdr: {
    sourceKind: 'project',
    displayType: 'CorelDRAW project',
    keywords: ['project-file', 'coreldraw', 'cdr', 'vector', 'editable'],
  },
  indd: {
    sourceKind: 'project',
    displayType: 'InDesign document',
    keywords: ['project-file', 'indesign', 'indd', 'multipage', 'editable'],
  },
}

export function classifyProjectFile(filePath: string): ProjectFileClassification | null {
  const basename = filePath.replaceAll('\\', '/').split('/').pop() ?? ''
  const sourceExt = basename.includes('.')
    ? (basename.split('.').pop()?.toLowerCase() as ProjectSourceExt)
    : ('' as ProjectSourceExt)
  const classification = PROJECT_FILE_TYPES[sourceExt]
  return classification
    ? {
        ...classification,
        sourceExt,
        keywords: [...classification.keywords],
      }
    : null
}

export function isProjectFile(filePath: string): boolean {
  return classifyProjectFile(filePath) !== null
}
