// One stylesheet, rendered once at the app root as <style>{CSS}</style>.
// Class prefix `nw-`. State-style helpers that used to return inline
// objects (tab, generateBtn, modelRow, cardHeader) are now modifier
// classes; only render-time dynamic values stay inline. The nested
// report iframe builds its OWN themed HTML via buildHtmlSrcDoc/
// readReportTheme — that srcdoc CSS is untouched by this stylesheet.
export const CSS = `
/* mobius-ui:Root v1 — keep in sync; library candidate. Diverge below the marker only. */
.nw-root {
  position: relative;        /* anchor for scrims / sheets / readers (they're absolute, not fixed) */
  display: flex; flex-direction: column;
  height: 100%; width: 100%; max-width: 100%;
  overflow: hidden;          /* the whole app pins to the viewport — no body-level horizontal scroll */
  background: var(--bg); color: var(--text); font-family: var(--font);
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
.nw-scroll {
  flex: 1; min-height: 0;    /* the flexbox-overflow fix — REQUIRED so children scroll */
  overflow-y: auto; overflow-x: hidden;
  word-break: break-word; overflow-wrap: anywhere;  /* belt-and-braces for descendants that didn't opt in */
  overscroll-behavior: contain;
}
/* /mobius-ui:Root */
/* App-specific: News uses a wider horizontal pad than the canonical 16px. */
.nw-scroll { padding: 14px 20px 32px; }

/* mobius-ui:Scrollskin v2 — keep in sync; hidden by default, content stays scrollable. */
.nw-scroll,
.nw-reader-body,
.mobius-model-sheet__body {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.nw-scroll::-webkit-scrollbar,
.nw-reader-body::-webkit-scrollbar,
.mobius-model-sheet__body::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
/* /mobius-ui:Scrollskin */

/* mobius-ui:Focus v1 -- shared keyboard focus ring (WCAG 2.4.7); never bare outline:none */
:where(button,a,input,textarea,select,summary,[role="button"],[tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* /mobius-ui:Focus */

/* App header — title + tab cluster (diverges from the canonical brand Header). */
.nw-header {
  /* Top-pinned header: clear the notch / status bar on a full-bleed phone. */
  padding: max(18px, env(safe-area-inset-top)) 20px 0;
  display: flex; align-items: center;
  justify-content: space-between; flex-shrink: 0; gap: 12px;
}
/* Brand row: glossy app icon + the one app-name text label in the catalog.
   The icon and "News" wordmark share a vertically-centered flex row. */
.nw-brand {
  display: flex; align-items: center; gap: 9px; min-width: 0; flex-shrink: 0;
}
.nw-brand-icon {
  width: 34px; height: 34px; border-radius: 8px;
  object-fit: cover; flex-shrink: 0; display: block; user-select: none;
}
.nw-brand-fallback {
  width: 34px; height: 34px; border-radius: 8px; flex-shrink: 0;
  align-items: center; justify-content: center;
  color: var(--accent); font-size: 28px; font-weight: 700; line-height: 1;
  background: var(--accent-dim); user-select: none;
}
.nw-title {
  margin: 0;
  font-size: 19px; font-weight: 700; line-height: 1;
  color: var(--text); letter-spacing: 0; user-select: none;
}
.nw-divider { height: 1px; background: var(--border); margin: 14px 20px 0; }

/* mobius-ui:Segmented v1 — keep in sync; library candidate. News uses the
   is-accent modifier (accent-fill active) and holds its own exact values;
   diverge below the marker only. */
.nw-tabs {
  display: flex; gap: 2px; padding: 3px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
}
.nw-tab {
  min-height: 44px; padding: 6px 14px; border: none; border-radius: 6px;
  background: transparent; color: var(--muted); font-family: var(--font);
  font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background 0.15s, color 0.15s, opacity 0.15s;
  touch-action: manipulation; user-select: none;
}
.nw-tab.is-active { background: var(--accent-hover, var(--accent)); color: var(--accent-fg); }
@media (hover: hover) {
  .nw-tab:not(.is-active):hover { color: var(--text); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-tab:active { opacity: 0.75; }
}
/* /mobius-ui:Segmented */

/* Reports — top control row */
.nw-top-row {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 14px; flex-wrap: wrap;
}
/* Generate-report button — accent fill, surface/muted while busy (disabled). */
.nw-generate-btn {
  padding: 7px 14px; border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--accent-hover, var(--accent)); color: var(--accent-fg);
  cursor: pointer; font-size: 13px; font-weight: 500; white-space: nowrap;
  min-height: 44px;
  touch-action: manipulation; user-select: none;
}
.nw-generate-btn:disabled {
  background: var(--surface); color: var(--muted); cursor: default; pointer-events: none;
}
@media (hover: hover) {
  .nw-generate-btn:not(:disabled):hover { filter: brightness(0.94); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-generate-btn:not(:disabled):active { opacity: 0.82; transform: scale(0.97); }
}
.nw-status-hint { font-size: 12px; color: var(--muted); }

/* Inline offline banner. Sits at the top of the Reports tab when
   navigator.onLine is false. Subtle accent-tinted strip — loud enough
   to be noticed, quiet enough not to dominate the report itself. We
   deliberately keep the rest of the UI rendered (cached reports remain
   visible) rather than swapping to a full-screen disconnect splash. */
.nw-offline-banner {
  margin: 0 0 12px; padding: 8px 12px; border-radius: 8px;
  background: var(--accent-dim, rgba(99,102,241,0.12));
  border: 1px solid var(--border); color: var(--text);
  font-size: 12.5px; line-height: 1.45;
}

/* Reading column for the report feed. We centre a comfortable width so
   long summaries don't stretch edge-to-edge on web; on mobile it just
   fills the viewport. */
.nw-report-container {
  max-width: 640px; margin: 0 auto;
  word-break: break-word; overflow-wrap: anywhere;
}
.nw-report-container.is-reader { padding: 20px; }

/* "Today at a glance" tl;dr strip — accent-tinted, the report's lede. */
.nw-glance {
  font-size: 14px; line-height: 1.6; color: var(--text);
  margin: 14px 0 16px; padding: 12px 14px;
  background: var(--accent-dim); border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
}
.nw-section-title {
  display: inline-block;
  font-size: 15px; font-weight: 700; color: var(--text);
  margin: 18px 0 10px; padding-bottom: 5px;
  border-bottom: 2px solid var(--accent);
}
.nw-article {
  margin-bottom: 10px; padding: 10px 12px;
  border: 1px solid var(--border-light, var(--border));
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface) 55%, transparent);
}
.nw-headline { font-size: 14px; font-weight: 600; line-height: 1.4; margin: 0 0 4px; }
.nw-article-summary { font-size: 13px; line-height: 1.55; color: var(--muted); margin: 0; }

/* Report reader — full-bleed overlay anchored to the app root. A flex column
   (the bar, then the reader split); position:absolute + inset:0 gives the body
   a definite height so the chat panel's %-height resolves. */
.nw-reader {
  position: absolute; inset: 0; z-index: 5;
  display: flex; flex-direction: column;
  background: var(--bg); color: var(--text);
}
/* The feed is the handoff cover while a report's sandboxed frame settles its
   final image delivery and measured height. The transparent reader still owns
   hit-testing so a second row cannot open another nav level underneath it. */
.nw-reader.is-settling { background: transparent; }
.nw-reader.is-settling > * { visibility: hidden; }
/* The reader split. A flex column: the scrolling read on top, then (when chat
   is open) a draggable divider + the chat panel. min-height:0 lets the read
   shrink so the chat panel's %-height has room. Mirrors app-latex's .body. */
.nw-reader-split {
  flex: 1; min-height: 0;
  display: flex; flex-direction: column;
  overflow: hidden;
}
.nw-reader-bar {
  display: flex; align-items: center; gap: 12px;
  padding: max(11px, env(safe-area-inset-top)) 14px 11px;
  border-bottom: 1px solid var(--border);
  background: var(--surface); flex-shrink: 0;
}
.nw-reader-back {
  min-height: 44px; padding: 7px 12px; border-radius: 9px;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--text); font-size: 13px; font-weight: 650;
  cursor: pointer; font-family: var(--font);
  touch-action: manipulation; user-select: none;
}
@media (prefers-reduced-motion: no-preference) {
  .nw-reader-back:active { opacity: 0.75; }
}
.nw-reader-title {
  flex: 1; min-width: 0; font-size: 14px; font-weight: 750;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  user-select: none;
}
.nw-reader-body {
  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
  overscroll-behavior: contain;
  /* Width stability still matters for the iframe height bridge; Scrollskin
     hides the scrollbar itself, but this prevents text re-wrap feedback. */
  scrollbar-gutter: stable;
}
.nw-reader-frame {
  width: 100%; border: 0; background: var(--bg); display: block;
  /* Height is set dynamically by the postMessage height-bridge.
     min-height keeps the reader from looking empty before the first
     message arrives (~70vh equivalent); max content height is capped
     server-side at 16000px so the outer column never grows unboundedly. */
  min-height: 70vh;
}

/* Report feed list. */
.nw-feed-list { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 8px; }
.nw-feed-item {
  width: 100%; min-height: 44px; text-align: left; padding: 13px 15px;
  border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text);
  cursor: pointer; font-family: var(--font);
  touch-action: manipulation;
}
@media (hover: hover) {
  .nw-feed-item:hover { border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-feed-item { transition: border-color 0.15s, transform 0.1s; }
  .nw-feed-item:active { opacity: 0.85; transform: translateY(1px); }
}
.nw-feed-date { font-size: 14px; font-weight: 750; color: var(--accent); margin-bottom: 5px; user-select: none; }
.nw-feed-summary { font-size: 13px; line-height: 1.45; color: var(--muted); }

/* The chat icon in the reader bar — sits to the right of the digest title. */
/* Subdued when CLOSED (reads as an affordance, not an active state); accent-
   tinted only when OPEN, matching app-latex / app-webstudio / app-reflection. */
.nw-chat-toggle {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 44px; min-height: 44px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--text); cursor: pointer; flex-shrink: 0;
  font-family: var(--font); touch-action: manipulation; user-select: none;
}
.nw-chat-toggle[aria-pressed="true"] {
  background: color-mix(in srgb, var(--accent) 18%, var(--surface));
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  color: var(--accent);
}
@media (prefers-reduced-motion: no-preference) {
  .nw-chat-toggle:active { opacity: 0.8; transform: scale(0.97); }
}

/* Spinner — News had none; ported for the chat sheet's "Opening…" state. */
@keyframes nw-spin { to { transform: rotate(360deg); } }
.nw-spinner {
  width: 26px; height: 26px; border-radius: 50%;
  border: 2.5px solid var(--accent-dim); border-top-color: var(--accent);
  animation: nw-spin 0.8s linear infinite;
}
.nw-spinner-sm { width: 16px; height: 16px; border-width: 2px; }
@media (prefers-reduced-motion: reduce) { .nw-spinner { animation: none; } }

/* Stable chat stage: the real iframe lays itself out behind an opaque opening
   cover, then the shared runtime fades it in only after its authorized first
   paint. The cover is removed by ChatPanel's onReady handler, so no blank
   authorization frame or composer pop-in can leak through. */
.nw-chat-stage {
  position: relative; flex: 1 1 auto; min-height: 0; width: 100%;
  overflow: hidden; background: var(--bg);
}
.nw-chat-embed {
  position: absolute; inset: 0;
  overflow: hidden; background: var(--bg);
}
.nw-chat-embed iframe { display: block; width: 100%; height: 100%; border: 0; }
.nw-chat-resolving {
  position: absolute; inset: 0; z-index: 1;
  padding: 20px 16px 28px; display: flex; align-items: center; justify-content: center; gap: 10px;
  background: var(--bg);
  color: var(--muted); font-size: 12.5px;
}
.nw-no-chat-note {
  margin: 14px 16px 22px; padding: 14px 16px; border-radius: 13px;
  background: var(--surface); border: 1px dashed var(--border);
  color: var(--muted); font-size: 12.5px; line-height: 1.55;
  display: flex; align-items: flex-start; gap: 10px;
}
.nw-no-chat-glyph { font-size: 15px; line-height: 1.2; }
/* One-line prompt at the top of the chat, nudging the owner to leave feedback
   on the day's digest (that's what this app-scoped chat is FOR). */
.nw-chat-hint {
  flex: 0 0 auto; padding: 9px 14px;
  font-size: 12px; line-height: 1.45; color: var(--muted);
  background: var(--surface); border-bottom: 1px solid var(--border);
}

/* mobius-ui:ChatSplit v1 — the bottom half of the 50/50 chat split. Mirrors
   app-latex / app-webstudio / app-reflection so the chat reads the same across
   apps; keep in sync. The embedded shell chat runs in an iframe
   (window.mobius.chat). The panel takes the --chat-ratio share of the
   reader-body height, floored at --chat-pane-min (composer pill + divider) so
   the embed's input pill is never clipped, and capped at the same floor from
   the other end so the read never fully eats the chat. The drag/keyboard ratio
   math honors these bounds; the CSS floor also covers the persisted/default
   ratio on a short viewport before any drag. It's a flex column; .nw-chat-embed
   fills it (flex:1 + min-height:0) and the iframe fills the embed, pinning the
   composer to the panel's bottom. */
.nw-chat-panel {
  flex: 0 0 auto;
  height: calc(var(--chat-ratio, 0.5) * 100%);
  min-height: min(var(--chat-pane-min, 74px), 100%);
  max-height: calc(100% - var(--chat-pane-min, 74px));
  display: flex; flex-direction: column;
  background: var(--surface);
  overflow: hidden; overscroll-behavior: contain;
  /* Bottom-pinned: lift the embedded composer above the iPhone home-indicator
     / Android gesture bar on a full-screen PWA. */
  padding-bottom: env(safe-area-inset-bottom);
}
/* The draggable divider between read and chat: a slim 10px visual bar; the
   ::before overlay extends the pointer hit area to ~26px without adding visual
   weight; z-index keeps that overlay above the adjacent panes. */
.nw-chat-divider {
  flex: 0 0 10px;
  height: 10px;
  box-sizing: border-box;
  position: relative;
  z-index: 5;
  display: flex; align-items: center; justify-content: center;
  cursor: ns-resize;
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  touch-action: none; user-select: none;
}
.nw-chat-divider::before {
  content: ''; position: absolute; left: 0; right: 0; top: -8px; bottom: -8px;
}
.nw-chat-divider:hover,
.nw-chat-divider:focus-visible {
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
}
.nw-chat-divider:focus-visible { outline-offset: -2px; }
.nw-chat-divider-bar {
  width: 44px; height: 4px; border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 65%, transparent);
  pointer-events: none;
}
/* /mobius-ui:ChatSplit */

/* Centered status states. */
.nw-empty {
  max-width: 360px; margin: 44px auto; padding: 0 20px;
  text-align: center; color: var(--muted);
  font-size: 13px; line-height: 1.6;
}
.nw-empty__mark {
  width: 34px; height: 34px; margin: 0 auto 12px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent); font-size: 15px; font-weight: 800;
}
.nw-empty__title {
  margin: 0 0 6px; color: var(--text);
  font-size: 16px; line-height: 1.25; font-weight: 750;
}
.nw-empty__subtitle {
  margin: 0 0 14px; color: var(--muted);
  font-size: 13px; line-height: 1.5;
}
.nw-loading { text-align: center; padding: 50px 20px; color: var(--muted); font-size: 13px; }

/* Settings */
.nw-settings-wrap {
  width: min(100%, 980px); margin: 0 auto;
  display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(280px, .85fr);
  gap: 18px;
}
.nw-settings-section {
  min-width: 0; margin: 0; padding: 18px; align-self: start;
  border: 1px solid var(--border); border-radius: 16px;
  background: var(--surface);
}
.nw-settings-section--editorial { grid-column: 1 / -1; }
.nw-label { font-size: 13px; font-weight: 600; margin: 0 0 4px; display: block; }
.nw-note { font-size: 12px; color: var(--muted); margin: 0 0 10px; line-height: 1.5; }
.nw-topics-textarea {
  width: 100%; min-height: 140px;
  font-family: var(--font);   /* plain prose textarea — this is freeform English now */
  font-size: 16px;            /* 16px stops iOS Safari zoom-on-focus — don't go lower on a focusable field */
  line-height: 1.55; padding: 12px;
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px;
  resize: vertical; box-sizing: border-box;
  white-space: pre-wrap; word-break: break-word;
  overflow-wrap: anywhere; max-width: 100%;
}
.nw-btn-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.nw-btn-row.has-top { margin-top: 8px; }
.nw-btn {
  min-height: 44px; padding: 7px 16px; border: none; border-radius: 10px;
  background: var(--accent-hover, var(--accent)); color: var(--accent-fg);
  font-size: 13px; font-weight: 600; cursor: pointer;
  touch-action: manipulation; user-select: none;
}
.nw-btn:disabled {
  background: var(--surface); color: var(--muted); cursor: default; pointer-events: none;
}
@media (hover: hover) {
  .nw-btn:not(:disabled):hover { filter: brightness(0.94); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-btn:not(:disabled):active { opacity: 0.82; transform: scale(0.97); }
}
.nw-link-btn {
  min-height: 44px; padding: 0 8px; border-radius: 8px;
  background: none; border: none;
  color: var(--accent); font-size: 12px; cursor: pointer; text-decoration: underline;
  touch-action: manipulation; user-select: none;
}
@media (prefers-reduced-motion: no-preference) {
  .nw-link-btn:active { opacity: 0.75; }
}
.nw-toast { font-size: 12px; color: var(--green, #4caf50); }
.nw-error-toast { font-size: 12px; color: var(--danger, #ef4444); }
/* App-level banner for a write that was queued offline ("Saved offline —
   will sync") but the server later REFUSED on drain. The inline toast is
   long gone by then, so the correction has to be a persistent, dismissible
   banner — otherwise the partner walks away believing a refused change saved. */
.nw-deadletter {
  display: flex; align-items: center; gap: 8px;
  margin: 8px 12px 0; padding: 8px 12px; border-radius: 10px;
  font-size: 12px; line-height: 1.4;
  color: var(--danger, #ef4444);
  background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--danger, #ef4444) 36%, transparent);
}
.nw-deadletter__msg { flex: 1; }
.nw-deadletter__close {
  min-height: 44px; min-width: 44px; padding: 0;
  border: none; border-radius: 10px; background: transparent; cursor: pointer;
  color: var(--danger, #ef4444); font-size: 16px; line-height: 1;
}
/* Secondary button for "Run now"/"Save schedule" — surface fill so it
   reads as a quieter action than the accent-filled primary buttons.
   Busy reuses the disabled state (muted text, default cursor). */
.nw-btn-secondary {
  min-height: 44px; padding: 7px 14px; border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface); color: var(--text);
  font-size: 13px; font-weight: 600; cursor: pointer;
  touch-action: manipulation; user-select: none;
}
.nw-btn-secondary:disabled { color: var(--muted); cursor: default; pointer-events: none; }
@media (hover: hover) {
  .nw-btn-secondary:not(:disabled):hover { border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-btn-secondary:not(:disabled):active { opacity: 0.8; transform: scale(0.97); }
}

/* Agent / Model section — compact picker. The backend already filters
   hidden model prefs, matching the chat picker list. */
.nw-model-select {
  width: 100%; min-height: 42px; padding: 9px 12px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--surface); color: var(--text);
  font-size: 16px; font-family: var(--font); font-weight: 600;
}
.nw-time-input { width: 150px; }
.nw-model-meta { margin-top: 8px; font-size: 12px; color: var(--muted); line-height: 1.5; }
/* Raw model id is metadata — render it in the mono token, not Inter. */
.nw-model-meta-id { font-family: var(--mono); }
.nw-fallback-warning {
  margin: 9px 0 0; color: var(--danger); font-size: 12px; line-height: 1.5;
}
.nw-effort {
  margin-top: 8px;
  display: flex; align-items: center; gap: 10px;
  min-height: 24px;
}
.nw-effort-track {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  min-height: 24px; padding: 0 2px;
}
.nw-effort-track::before {
  content: '';
  position: absolute; left: 7px; right: 7px; top: 50%;
  height: 2px; transform: translateY(-50%);
  background: var(--border);
}
.nw-effort-stop {
  position: relative; z-index: 1;
  width: 14px; height: 14px; padding: 0;
  border-radius: 999px; border: 1px solid var(--border);
  background: var(--surface); cursor: pointer;
  touch-action: manipulation; user-select: none;
}
.nw-effort-stop.is-filled {
  background: var(--accent);
  border-color: var(--accent);
}
.nw-effort-stop.is-active {
  transform: scale(1.3);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
.nw-effort-stop:disabled {
  cursor: default; opacity: 0.55; pointer-events: none;
}
@media (hover: hover) {
  .nw-effort-stop:not(:disabled):not(.is-active):hover { border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-effort-stop { transition: background 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.15s; }
  .nw-effort-stop:not(:disabled):active { opacity: 0.82; }
}
.nw-effort-label {
  font-size: 12px; line-height: 1;
  color: var(--muted); white-space: nowrap;
}
.nw-effort.is-disabled .nw-effort-label { opacity: 0.55; }
.mobius-agent-priority-list { display:flex; flex-direction:column; gap:6px; position:relative; }
.mobius-agent-priority-row {
  position:relative; display:grid; grid-template-columns:44px minmax(0,1fr);
  align-items:center; min-height:54px; padding:0; border:0; border-radius:9px;
  background:transparent; user-select:none; -webkit-user-select:none;
  -webkit-touch-callout:none; will-change:transform;
  transition:transform .18s cubic-bezier(.22,1,.36,1), background .15s ease,
    border-color .15s ease, box-shadow .15s ease, opacity .15s ease;
}
.mobius-agent-priority-list.is-committing .mobius-agent-priority-row { transition:none; }
.mobius-agent-priority-row.is-dragging { opacity:.96; }
.mobius-agent-priority-row.is-dragging .mobius-model-trigger,
.mobius-agent-priority-row.is-drop-target .mobius-model-trigger {
  border-color:color-mix(in srgb,var(--accent) 62%,var(--border));
  background:color-mix(in srgb,var(--accent) 7%,var(--surface));
  box-shadow:0 4px 8px rgb(0 0 0 / 18%);
}
.mobius-agent-priority-handle {
  align-self:stretch; min-width:44px; min-height:44px; display:grid; place-items:center;
  border:0; border-radius:7px; padding:0; color:var(--muted); background:transparent;
  font:inherit; cursor:grab; touch-action:none; -webkit-tap-highlight-color:transparent;
}
.mobius-agent-priority-handle:active,
.mobius-agent-priority-row.is-dragging .mobius-agent-priority-handle {
  cursor:grabbing; color:var(--accent);
  background:color-mix(in srgb,var(--accent) 10%,transparent);
}
.mobius-agent-priority-handle:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.mobius-agent-priority-handle svg { display:block; }
.mobius-agent-priority-body { min-width:0; }
@media (hover:hover) and (pointer:fine) {
  .mobius-agent-priority-handle:hover { color:var(--text); background:var(--surface2); }
}
@media (prefers-reduced-motion:reduce) { .mobius-agent-priority-row { transition:none; } }
/* Production Settings model trigger + responsive picker vocabulary. */
.mobius-model-trigger {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  background: color-mix(in srgb, var(--bg) 60%, var(--surface));
  border: 1px solid var(--border); border-radius: 9px; padding: 8px 10px;
  font: inherit; color: var(--text); cursor: pointer; touch-action: manipulation;
}
.mobius-model-trigger__icon,
.mobius-model-sheet__row-icon {
  display: grid; place-items: center; flex-shrink: 0;
  background: var(--surface2, color-mix(in srgb, var(--surface) 82%, var(--bg)));
  border: 1px solid var(--border-light, var(--border)); color: var(--text);
}
.mobius-model-trigger__icon { width: 26px; height: 26px; border-radius: 7px; }
.mobius-model-trigger__icon svg { width: 15px; height: 15px; }
.mobius-model-trigger__main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.mobius-model-trigger__name,
.mobius-model-trigger__id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mobius-model-trigger__name { font-size: 13.5px; font-weight: 500; line-height: 1.3; }
.mobius-model-trigger__id { font-size: 11px; color: var(--muted); font-family: var(--mono); line-height: 1.3; }
.mobius-model-trigger__effort {
  flex-shrink: 0; font-size: 11px; font-weight: 500; line-height: 1;
  padding: 3px 7px; border-radius: 999px; color: var(--muted); white-space: nowrap;
  background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
}
.mobius-model-trigger__effort-visual {
  position: relative; flex-shrink: 0; display: inline-flex; align-items: center;
  justify-content: space-between; gap: 5px; min-width: 68px; padding: 7px 3px;
}
.mobius-model-trigger__effort-visual::before {
  content: ''; position: absolute; left: 6px; right: 6px; top: 50%; height: 1px;
  background: var(--border); transform: translateY(-50%);
}
.mobius-model-trigger__effort-dot {
  position: relative; z-index: 1; width: 6px; height: 6px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--surface);
}
.mobius-model-trigger__effort-dot.is-filled { border-color: var(--accent); background: var(--accent); }
.mobius-model-trigger__effort-dot.is-active { transform: scale(1.35); box-shadow: 0 0 0 2px var(--accent-dim); }
.mobius-model-sheet__backdrop {
  position: absolute; inset: 0; z-index: 1000; display: flex;
  align-items: flex-end; justify-content: center; box-sizing: border-box;
  background: rgba(0,0,0,.5); overscroll-behavior: contain;
  padding: max(8px, env(safe-area-inset-top)) max(8px, env(safe-area-inset-right))
    max(8px, env(safe-area-inset-bottom)) max(8px, env(safe-area-inset-left));
}
.mobius-model-sheet {
  width: 100%; max-width: 440px; max-height: calc(100dvh - 16px);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 16px 16px 0 0; box-shadow: 0 -4px 8px rgba(0,0,0,.24);
  animation: mobius-model-sheet-in .18s ease;
}
@keyframes mobius-model-sheet-in { from { transform: translateY(14px); opacity: .5; } }
.mobius-model-sheet__head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 8px; }
.mobius-model-sheet__title { font-size: 13px; font-weight: 500; color: var(--muted); }
.mobius-model-sheet__close {
  min-width: 44px; min-height: 44px; margin: -8px -8px -8px 0; padding: 4px 6px;
  border: none; background: none; color: var(--accent); font: inherit;
  font-size: 14px; font-weight: 500; cursor: pointer;
}
.mobius-model-sheet__body { min-height: 0; overflow-y: auto; overscroll-behavior-y: contain; padding: 0 8px 16px; }
.mobius-model-sheet__group-head {
  display: flex; align-items: center; gap: 8px; padding: 12px 10px 6px;
  color: var(--muted); font-size: 11px; font-weight: 600;
}
.mobius-model-sheet__group-icon { width: 18px; height: 18px; display: grid; place-items: center; color: var(--text); }
.mobius-model-sheet__group-icon svg { width: 15px; height: 15px; }
.mobius-model-sheet__group-hint { font-weight: 400; }
.mobius-model-sheet__row {
  display: flex; align-items: center; gap: 12px; width: 100%; padding: 9px 10px;
  border: none; border-radius: 9px; background: none; color: var(--text);
  font: inherit; text-align: left; cursor: pointer;
}
.mobius-model-sheet__row.is-selected { background: color-mix(in srgb, var(--accent) 10%, var(--surface)); }
.mobius-model-sheet__row:disabled { opacity: .45; cursor: not-allowed; }
.mobius-model-sheet__row-icon { width: 30px; height: 30px; border-radius: 8px; }
.mobius-model-sheet__row-icon svg { width: 16px; height: 16px; }
.mobius-model-sheet__row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.mobius-model-sheet__row-title,
.mobius-model-sheet__row-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mobius-model-sheet__row-title { font-size: 14px; font-weight: 500; }
.mobius-model-sheet__row-id { font-size: 12px; color: var(--muted); font-family: var(--mono); }
.mobius-model-sheet__check {
  width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  position: relative; background: var(--accent); border: 1.5px solid var(--accent);
}
.mobius-model-sheet__check::after {
  content: ''; position: absolute; left: 5px; top: 2px; width: 5px; height: 9px;
  border: 1.5px solid var(--accent-fg); border-top: 0; border-left: 0; transform: rotate(45deg);
}
.mobius-model-sheet__effort { margin: 2px 10px 8px 52px; }
.mobius-model-sheet__empty { padding: 16px 10px; color: var(--muted); font-size: 13px; }
@media (hover: hover) and (pointer: fine) {
  .mobius-model-trigger:hover { border-color: var(--accent); }
  .mobius-model-sheet__row:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 8%, var(--surface)); }
}
@media (min-width: 620px) {
  .mobius-model-sheet__backdrop { align-items: center; padding: 24px; }
  .mobius-model-sheet { border-radius: 16px; }
}
@media (max-width: 760px) {
  .nw-settings-wrap { grid-template-columns: minmax(0, 1fr); }
  .nw-settings-section--editorial { grid-column: auto; }
}

/* In-report question cards. The agent embeds these declaratively in the
   report HTML (a JSON carrier inside an inert <script>); the shell renders
   them natively here so the partner taps an answer that's saved for the
   NEXT run — never a live agent the way a background AskUserQuestion would
   park a server-orphaned future. Shape mirrors the shell's QuestionCard. */
.nw-rq {
  margin: 18px 16px 22px;
  padding: 16px 16px 18px;
  border-radius: 14px;
  border: 1px solid var(--accent);
  background: var(--accent-dim);
}
.nw-rq__title { font-size: 15px; font-weight: 750; color: var(--text); margin: 0 0 4px; }
.nw-rq__note { font-size: 12px; color: var(--muted); margin: 0 0 14px; line-height: 1.5; }
.nw-rq__q + .nw-rq__q {
  margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);
}
.nw-rq__header {
  font-size: 11px; font-weight: 600;
  letter-spacing: 0; color: var(--accent); margin-bottom: 4px;
}
.nw-rq__text { font-size: 14px; margin-bottom: 6px; color: var(--text); }
.nw-rq__hint { font-size: 11px; color: var(--muted); margin-bottom: 8px; }
.nw-rq__opts { display: flex; flex-wrap: wrap; gap: 6px; }
.nw-rq__opt {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 13px; min-height: 44px;
  border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text);
  font-size: 13px; cursor: pointer; box-sizing: border-box;
  font-family: var(--font); touch-action: manipulation; user-select: none;
}
@media (hover: hover) {
  .nw-rq__opt:not(.nw-rq__opt--on):hover { border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-rq__opt:active { opacity: 0.8; transform: scale(0.98); }
}
.nw-rq__opt--on { background: var(--accent-hover, var(--accent)); color: var(--accent-fg); border-color: var(--accent-hover, var(--accent)); }
.nw-rq__opt--dim { opacity: 0.4; border-color: transparent; }
.nw-rq__opt:disabled { cursor: default; }
.nw-rq__submit {
  display: block; width: 100%; margin-top: 14px; min-height: 44px;
  padding: 11px; border-radius: 10px; border: none;
  background: var(--accent-hover, var(--accent)); color: var(--accent-fg);
  font-size: 14px; font-weight: 700; cursor: pointer;
  font-family: var(--font); touch-action: manipulation;
}
.nw-rq__submit:disabled { opacity: 0.4; cursor: default; }
.nw-rq__error {
  margin-top: 10px; font-size: 12.5px; line-height: 1.5;
  color: var(--danger, #ef4444);
}
.nw-rq--answered .nw-rq__done {
  margin-top: 14px; font-size: 12.5px; color: var(--muted); line-height: 1.5;
}

/* mobius-ui:ReducedMotion v1 -- honor the OS reduce-motion setting */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
/* /mobius-ui:ReducedMotion */
`
