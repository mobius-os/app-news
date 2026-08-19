import { useCallback, useEffect, useRef, useState } from 'react'
import { readVoiceAppInstallation, readVoiceCatalog } from '../speech-capability.js'

const CHECKING_CATALOG = Object.freeze({
  state: 'checking',
  activeModel: null,
  voiceAppInstalled: null,
})

/**
 * Keep every News surface on the same Voice readiness contract. Returning from
 * Voice or the App Store refreshes the catalog automatically, while the
 * request sequence prevents a slower earlier check from replacing a newer one.
 */
export function useVoiceCatalog(token = '') {
  const [catalog, setCatalog] = useState(CHECKING_CATALOG)
  const requestSequence = useRef(0)

  const refresh = useCallback(async ({ showChecking = true } = {}) => {
    const sequence = ++requestSequence.current
    if (showChecking) {
      setCatalog((current) => current.activeModel
        ? current
        : { ...CHECKING_CATALOG })
    }
    const installationCheck = token
      ? readVoiceAppInstallation(token)
      : Promise.resolve(null)
    const [catalogResult, installationResult] = await Promise.allSettled([
      readVoiceCatalog(),
      installationCheck,
    ])
    const voiceAppInstalled = installationResult.status === 'fulfilled'
      ? installationResult.value
      : null
    if (sequence !== requestSequence.current) return null
    if (catalogResult.status === 'fulfilled') {
      const next = {
        ...catalogResult.value,
        state: 'ready',
        voiceAppInstalled,
      }
      setCatalog(next)
      return next
    }
    setCatalog({
      state: 'unavailable',
      activeModel: null,
      voiceAppInstalled,
      message: catalogResult.reason?.message || '',
    })
    return null
  }, [token])

  useEffect(() => {
    refresh()
    const refreshQuietly = () => {
      if (document.visibilityState === 'hidden') return
      refresh({ showChecking: false })
    }
    window.addEventListener('focus', refreshQuietly)
    window.addEventListener('pageshow', refreshQuietly)
    document.addEventListener('visibilitychange', refreshQuietly)
    return () => {
      requestSequence.current += 1
      window.removeEventListener('focus', refreshQuietly)
      window.removeEventListener('pageshow', refreshQuietly)
      document.removeEventListener('visibilitychange', refreshQuietly)
    }
  }, [refresh])

  return { catalog, refresh }
}
