import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_TOPICS } from '../constants.js'
import { STARTER_TOPICS, setupTopicsDraft } from '../preferences.js'

test('setup trusts a successful live topics read', () => {
  assert.deepEqual(setupTopicsDraft({
    liveOk: true,
    liveText: 'Follow local planning and transport.',
    cachedText: 'stale cache',
  }), {
    topics: 'Follow local planning and transport.',
    requiresConfirmation: false,
  })
})

test('setup displays cached topics but requires intent after a failed read', () => {
  assert.deepEqual(setupTopicsDraft({
    liveOk: false,
    cachedText: 'Follow my saved specialist sources.',
  }), {
    topics: 'Follow my saved specialist sources.',
    requiresConfirmation: true,
  })
})

test('setup never treats a bundled fallback as a loaded server copy', () => {
  assert.deepEqual(setupTopicsDraft({
    liveOk: false,
    cachedText: DEFAULT_TOPICS,
  }), {
    topics: STARTER_TOPICS,
    requiresConfirmation: true,
  })
})
