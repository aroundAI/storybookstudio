// FILM-2015: React access to the Studio UI store, and the studio.* strings.
import { useCallback } from 'react'
import { useStore } from 'zustand'
import { studioUiStore } from '../../studio/ui/studioStore'
import { useI18n } from '../../i18n/I18nContext'

export const useStudioUi = (selector) => useStore(studioUiStore, selector)

export const studioApi = () => globalThis.window?.electronAPI?.studio ?? null

// t('welcome.title') reads studio.welcome.title from public/lang/lang_*.json.
export function useStudioText() {
  const { t } = useI18n()
  return useCallback((key, variables) => t(`studio.${key}`, variables), [t])
}
