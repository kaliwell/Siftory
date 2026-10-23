import React from 'react'
import { useTranslation } from '../i18n/useTranslation'
import { openWorkspaceRoute } from '../services/openWorkspace'

export default function WorkspacePreparationLink({
  kind,
  ready,
}: {
  kind: 'image' | 'video'
  ready: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="workspace-preparation-link" data-ready={ready}>
      <span>
        {t(ready ? 'Library available for search' : 'Prepare your sources to enable search')}
      </span>
      <button
        onClick={() =>
          openWorkspaceRoute(
            kind === 'image' ? 'image-sources' : 'video-sources',
            kind === 'image' ? 'workspace-prepare-library-focus' : undefined,
          )
        }
      >
        {t(ready ? 'Manage sources' : 'Prepare library')}
        <span aria-hidden="true"> →</span>
      </button>
    </div>
  )
}
