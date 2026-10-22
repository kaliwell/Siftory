import React from 'react'

const paths: Record<string, string> = {
  search: 'm21 21-5.2-5.2M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z',
  library: 'M4 4h6v7H4zM14 4h6v7h-6zM4 15h6v5H4zM14 15h6v5h-6z',
  folder: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z',
  video: 'M4 4h16v16H4zM10 8l6 4-6 4Z',
  duplicate: 'M8 8h12v12H8zM4 16V4h12',
  database:
    'M20 6c0 2-3.6 3-8 3S4 8 4 6s3.6-3 8-3 8 1 8 3ZM4 6v12c0 2 3.6 3 8 3s8-1 8-3V6M4 12c0 2 3.6 3 8 3s8-1 8-3',
  settings:
    'm9 3-1 3-3 1-2 4 2 3v3l4 3 3-1 3 1 4-3v-3l2-3-2-4-3-1-1-3Zm3 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  tasks: 'M4 6h3M11 6h9M4 12h3M11 12h9M4 18h3M11 18h9',
  image: 'M3 4h18v16H3zM3 16l6-6 5 5 3-3 4 4M16 8h.01',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  filter: 'M3 6h18M6 12h12M10 18h4',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
}

export default function WorkspaceIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.folder} />
    </svg>
  )
}
