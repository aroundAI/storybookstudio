// Help > Open-source licenses: the GPL-3.0 notice and license text, read from
// the main process (electron/studio/licenses.js). The About panel itself
// shows only the app name and version.
import { useEffect, useState } from 'react'
import StudioDialog from './StudioDialog'
import { studioApi, useStudioText } from './studioUi'

export default function OpenSourceLicenses({ onClose }) {
  const t = useStudioText()
  const [state, setState] = useState({ status: 'loading', notice: '', license: '' })

  // The text is fetched once when the view opens.
  useEffect(() => {
    let cancelled = false
    Promise.resolve(studioApi()?.getLicenses?.())
      .then((result) => {
        if (cancelled) return
        if (!result?.notice) setState({ status: 'unavailable', notice: '', license: '' })
        else setState({ status: 'ready', notice: result.notice, license: result.license || '' })
      })
      .catch(() => !cancelled && setState({ status: 'unavailable', notice: '', license: '' }))
    return () => { cancelled = true }
  }, [])

  return (
    <StudioDialog title={t('licenses.title')} onClose={onClose} size="lg" testId="studio-licenses" closeLabel={t('common.close')}>
      {state.status === 'loading' && <p className="text-sm text-sf-text-secondary">{t('licenses.loading')}</p>}
      {state.status === 'unavailable' && <p className="text-sm text-sf-text-secondary" data-test="studio-licenses-unavailable">{t('licenses.unavailable')}</p>}
      {state.status === 'ready' && (
        <div className="space-y-4">
          <pre className="whitespace-pre-wrap font-sans text-sm" data-test="studio-licenses-notice">{state.notice}</pre>
          {state.license && (
            <pre className="whitespace-pre-wrap rounded border border-sf-dark-700 bg-sf-dark-950 p-3 font-mono text-xs text-sf-text-secondary" data-test="studio-licenses-text">{state.license}</pre>
          )}
        </div>
      )}
    </StudioDialog>
  )
}
