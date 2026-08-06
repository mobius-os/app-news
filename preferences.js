// Digest preferences shared by first-run setup, Settings, the report reader,
// and tests. Keep this module pure: storage and UI live elsewhere.

import { DEFAULT_TOPICS } from './constants.js'
import { normalizeSeededTopics } from './domain.js'

export const PREFERENCES_VERSION = 3

export const STARTER_TOPICS = 'Follow the most important global events, technology and AI, science, productivity, business and markets, climate and energy, and culture. Prioritize meaningful developments from the last 24 hours, explain why they matter, and include a few unexpected but significant stories from anywhere in the world.'

export const TOPICS_PLACEHOLDER = 'Describe the topics, people, places, industries, or questions you want the digest to follow.'

export function setupTopicsDraft({ liveOk, liveText, cachedText }) {
  const source = liveOk
    ? liveText
    : (typeof cachedText === 'string' ? cachedText : '')
  const normalized = normalizeSeededTopics(source || '')
  const topics = !normalized.trim() || normalized.trim() === DEFAULT_TOPICS.trim()
    ? STARTER_TOPICS
    : normalized
  return {
    topics,
    // Cached or bundled text is useful context, but it is not proof of the
    // current server copy. Setup must not persist it until the owner either
    // edits it or explicitly confirms the displayed draft.
    requiresConfirmation: !liveOk,
  }
}

export const SOURCE_TYPE_OPTIONS = [
  {
    id: 'mainstream',
    label: 'Mainstream media',
    description: 'Major newspapers, broadcasters, wires, and established specialist publications.',
  },
  {
    id: 'independent',
    label: 'Independent media',
    description: 'Smaller, reader-funded, local, and specialist outlets with original reporting.',
  },
]

export const DEFAULT_PREFERENCES = Object.freeze({
  version: PREFERENCES_VERSION,
  onboarding_completed: false,
  source_types: ['mainstream', 'independent'],
  include_sources: '',
  exclude_sources: '',
  tts: {
    enabled: false,
  },
})

function cleanText(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function normalizePreferences(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const rawTypes = Array.isArray(raw.source_types) ? raw.source_types : DEFAULT_PREFERENCES.source_types
  const sourceTypes = [...new Set(rawTypes.filter((id) => SOURCE_TYPE_OPTIONS.some((option) => option.id === id)))]
  const rawTts = raw.tts && typeof raw.tts === 'object' && !Array.isArray(raw.tts) ? raw.tts : {}
  return {
    version: PREFERENCES_VERSION,
    onboarding_completed: raw.onboarding_completed === true,
    source_types: sourceTypes.length > 0 ? sourceTypes : [...DEFAULT_PREFERENCES.source_types],
    include_sources: cleanText(raw.include_sources),
    exclude_sources: cleanText(raw.exclude_sources),
    tts: {
      enabled: rawTts.enabled === true,
    },
  }
}

export function updatePreference(preferences, patch) {
  return normalizePreferences({ ...preferences, ...patch })
}

export function updateTtsPreference(preferences, patch) {
  return normalizePreferences({
    ...preferences,
    tts: { ...preferences.tts, ...patch },
  })
}
