// App-wide constants — no React, no I/O. Template-literal blocks (the report
// CSP + height-reporter script, the editorial-brief defaults) and the small
// scalar tables (provider order, fallback model groups, schedule/cache/chat
// versions) that several modules share. Pure data: importable from the pure
// domain helpers, the storage layer, and the React UI alike.

// CSP injected into every report's <head>. Locks down the null-origin
// srcdoc context: no external fetches, no same-origin storage access,
// only inline scripts (needed for the height-reporter below).
export const NEWS_REPORT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src https: data:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

// Injected into every report's <head>. Reports scrollHeight to the parent
// via postMessage so the parent can size the iframe to content height without
// needing allow-same-origin (which would give the iframe the shell origin and
// its owner JWT). The sandbox is allow-scripts WITHOUT allow-same-origin, so
// the iframe has a null origin and cannot reach the parent's DOM or storage.
// Measurement: documentElement.getBoundingClientRect().height is the html
// element's border-box height, which tracks content (body has margin:0 in
// the srcdoc CSS). Unlike scrollHeight it is NOT floored at the iframe's
// own viewport height, so a transient over-measurement taken mid-reflow
// (e.g. classic scrollbars appearing shrink the layout width and re-wrap
// text taller for a frame) shrinks back on the next emit instead of
// ratcheting the iframe height up forever.
export const NEWS_REPORT_HEIGHT_SCRIPT = `<script>
(function(){
  function emit(){
    var h=Math.ceil(document.documentElement.getBoundingClientRect().height);
    if(h>0)parent.postMessage({type:'news:report-height',height:h},'*');
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',emit);
  } else { emit(); }
  if(typeof ResizeObserver!=='undefined'){
    var ro=new ResizeObserver(emit);
    ro.observe(document.documentElement);
  } else {
    window.addEventListener('resize',emit);
  }
})();
</script>`

// Provider display order + UI labels. The model list inside each
// group is fetched at runtime from `GET /api/auth/providers/models`
// (the backend asks Anthropic's /v1/models + the Codex SDK and
// falls back to KNOWN_MODELS on transient failure). One source of
// truth lives in mobius's `app.providers` — mini-apps no longer
// carry their own copy. The only thing hard-coded here is the
// group order + the human label per provider; the `id`s and
// per-model display names come from the backend.
export const PROVIDER_ORDER = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'OpenAI Codex' },
]

// Tiny fallback the picker falls back to when the fetch fails —
// older mobius without the endpoint, offline, etc. Just one model
// per provider so the user can still pick *something* and save;
// fetch.sh passes --model through verbatim, so the CLI is the
// ultimate authority on what actually resolves at job time.
export const FALLBACK_GROUPS = [
  {
    key: 'claude',
    label: 'Claude Code',
    models: [{ id: 'claude-opus-4-7', name: 'Opus 4.7' }],
  },
  {
    key: 'codex',
    label: 'OpenAI Codex',
    models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
  },
]

export const DEFAULT_PROVIDER = FALLBACK_GROUPS[0].key
export const DEFAULT_MODEL = FALLBACK_GROUPS[0].models[0].id

export const DEFAULT_SCHEDULE = { hour: 10, minute: 0 }

// The very first default the installer ever seeded (hard-wrapped). Kept
// verbatim only so a never-edited install carrying this exact text gets
// upgraded to the current DEFAULT_TOPICS by normalizeSeededTopics. The
// canonical default the app seeds and "Reset to default" writes is
// DEFAULT_TOPICS below, kept in sync with the bundled `topics.txt`.
// Multi-paragraph by design: this is an editorial brief, not a search
// query — the user is expected to rewrite it in their own voice.
export const LEGACY_DEFAULT_TOPICS = `This is your editorial brief — edit it to make the digest yours. The
text below is what the curator reads each morning to decide what to
write and how. Be opinionated; the more specific you are, the better
the report.

Coverage: I want a broad picture of the day across world news,
business and markets, technology, science, sports, and culture. Lean
into the stories that actually moved the needle in the last 24 hours
rather than evergreen think-pieces.

Sources & framing: stick to reputable primary publishers (Reuters,
AP, BBC, FT, Bloomberg, Nature, Ars Technica, The Verge, ESPN, NYT
Arts, and similar). Keep framing neutral and surface multiple
viewpoints when a story is divisive — no editorialising, no
speculation.

Voice: write it as one flowing morning briefing, like a journalist
would — conversational but substantive. Weave the citations into the
prose. If a story is unfamiliar or has been building over several
days, drop in a short "what this is about" sentence so I'm not lost.

What to downweight: celebrity gossip, lifestyle filler, and
press-release-shaped tech announcements with no real news behind
them. Skip them unless they're genuinely newsworthy.

Tell me what changed today, what it means, and what to watch next.
`

export const DEFAULT_TOPICS = `Coverage: give me a broad read on the day — world news, business and markets, tech, science, sports, culture. Chase what actually moved in the last 24 hours, not evergreen think-pieces.

Sources: lean on reputable primary publishers (Reuters, AP, BBC, FT, Bloomberg, Nature, Ars Technica, The Verge, ESPN, NYT Arts, and the like). Keep it neutral, and when a story is divisive show both sides — no editorialising or speculation.

Voice: one flowing morning briefing, the way a journalist would write it — conversational but substantive, with the sources woven into the prose. If a story is unfamiliar or has been building for days, drop in a quick line on what it's about so I'm not lost.

Downweight: celebrity gossip, lifestyle filler, and press-release tech announcements with nothing real behind them. Skip unless they're genuinely newsworthy.

Tell me what changed today, what it means, and what to watch next.
`

// The default that shipped before the brief was shortened (1.10.19 and
// earlier): same un-wrapped paragraphs but with the "This is your
// editorial brief …" preamble that now lives as fixed helper text above
// the textarea. Kept verbatim so a never-edited install upgrades to the
// new default instead of carrying the stale preamble inside the brief.
export const PRE_SHORTENED_DEFAULT_TOPICS = `This is your editorial brief — edit it to make the digest yours. The text below is what the curator reads each morning to decide what to write and how. Be opinionated; the more specific you are, the better the report.

Coverage: I want a broad picture of the day across world news, business and markets, technology, science, sports, and culture. Lean into the stories that actually moved the needle in the last 24 hours rather than evergreen think-pieces.

Sources & framing: stick to reputable primary publishers (Reuters, AP, BBC, FT, Bloomberg, Nature, Ars Technica, The Verge, ESPN, NYT Arts, and similar). Keep framing neutral and surface multiple viewpoints when a story is divisive — no editorialising, no speculation.

Voice: write it as one flowing morning briefing, like a journalist would — conversational but substantive. Weave the citations into the prose. If a story is unfamiliar or has been building over several days, drop in a short "what this is about" sentence so I'm not lost.

What to downweight: celebrity gossip, lifestyle filler, and press-release-shaped tech announcements with no real news behind them. Skip them unless they're genuinely newsworthy.

Tell me what changed today, what it means, and what to watch next.
`

// Every default the app has ever seeded. A stored brief matching any of
// them means the user never edited it, so we upgrade it to the current
// DEFAULT_TOPICS rather than leaving stale seed text in their editor.
export const PRIOR_DEFAULT_TOPICS = [LEGACY_DEFAULT_TOPICS, PRE_SHORTENED_DEFAULT_TOPICS]

// ----------------------------------------------------------------------
// Offline report cache versioning + bound.
// ----------------------------------------------------------------------
export const RECENT_REPORT_LIMIT = 7
// v3: reports are normalized OBJECTS again, but may carry an html body.
// Bump from v2 so old JSON-only cached entries don't mask fresh HTML files.
export const CACHE_VERSION = 3

// ----------------------------------------------------------------------
// Chat-split sizing — mirrors app-latex / app-webstudio / app-reflection so
// the chat reads the same across apps. chatOpen: the chat panel is visible.
// chatRatio: 0..1 fraction of the reader-body height the chat panel occupies.
// Both persist per-app.
// ----------------------------------------------------------------------
export const CHAT_OPEN_VERSION = 1
export const CHAT_RATIO_VERSION = 1
// Floor the chat pane at the embedded composer pill (~64px) + the divider
// (10px) so the input is never clipped; the same floor caps the OTHER end so
// the read never fully eats the chat.
export const CHAT_PILL_MIN_PX = 64
export const CHAT_DIVIDER_PX = 10
export const CHAT_PANE_MIN_PX = CHAT_PILL_MIN_PX + CHAT_DIVIDER_PX
