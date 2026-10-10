import { useCallback, useEffect } from 'react'
import { useStore } from '../stores/useStore'
import { translate, type TranslationValues } from './core'

export function useTranslation() {
  const language = useStore((state) => state.language)

  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  const t = useCallback(
    (key: string, values?: TranslationValues) => translate(language, key, values),
    [language],
  )

  return { language, t }
}
