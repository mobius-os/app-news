// Digest preferences shared by first-run setup, Settings, the report reader,
// and tests. Keep this module pure: storage and UI live elsewhere.

export const PREFERENCES_VERSION = 1

export const STARTER_TOPICS = 'Follow the most important global events, technology and AI, science, productivity, business and markets, climate and energy, and culture. Prioritize meaningful developments from the last 24 hours, explain why they matter, and include a few unexpected but significant stories from anywhere in the world.'

export const TOPICS_PLACEHOLDER = 'Describe the topics, people, places, industries, or questions you want the digest to follow.'

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

// Pocket TTS 2.1's official built-in language configurations and matching
// catalog voices. The five non-English models are currently 24-layer previews;
// the compact English model is the best default for a daily digest server.
export const TTS_LANGUAGES = [
  { id: 'english', label: 'English', voice: 'alba', modelSize: 'about 220 MB', compact: true },
  { id: 'french_24l', label: 'French', voice: 'estelle', modelSize: 'about 670 MB', compact: false },
  { id: 'german_24l', label: 'German', voice: 'juergen', modelSize: 'about 670 MB', compact: false },
  { id: 'spanish_24l', label: 'Spanish', voice: 'lola', modelSize: 'about 670 MB', compact: false },
  { id: 'portuguese_24l', label: 'Portuguese', voice: 'rafael', modelSize: 'about 670 MB', compact: false },
  { id: 'italian_24l', label: 'Italian', voice: 'giovanni', modelSize: 'about 670 MB', compact: false },
]

export const DEFAULT_PREFERENCES = Object.freeze({
  version: PREFERENCES_VERSION,
  onboarding_completed: false,
  source_types: ['mainstream', 'independent'],
  include_sources: '',
  exclude_sources: '',
  tts: {
    enabled: false,
    language: 'english',
    voice: 'alba',
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
  // News deliberately keeps one no-choice listening default for now. The UI
  // explains the official language coverage without making setup ask for a
  // report language; a future language picker can reopen this field cleanly.
  const language = DEFAULT_PREFERENCES.tts.language
  const languageInfo = TTS_LANGUAGES.find((item) => item.id === language) || TTS_LANGUAGES[0]
  return {
    version: PREFERENCES_VERSION,
    onboarding_completed: raw.onboarding_completed === true,
    source_types: sourceTypes.length > 0 ? sourceTypes : [...DEFAULT_PREFERENCES.source_types],
    include_sources: cleanText(raw.include_sources),
    exclude_sources: cleanText(raw.exclude_sources),
    tts: {
      enabled: rawTts.enabled === true,
      language,
      // Built-in voices are intentionally paired to their language. This
      // avoids offering voice cloning for a news product and keeps setup safe.
      voice: languageInfo.voice,
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

export function languageInfo(language) {
  return TTS_LANGUAGES.find((item) => item.id === language) || TTS_LANGUAGES[0]
}

export function reportLanguageLabel(preferences) {
  return languageInfo(normalizePreferences(preferences).tts.language).label
}
