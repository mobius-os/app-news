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
.nw-picker-sheet {
  scrollbar-width: none;
  -ms-overflow-style: none;
}
.nw-scroll::-webkit-scrollbar,
.nw-reader-body::-webkit-scrollbar,
.nw-picker-sheet::-webkit-scrollbar {
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
.nw-tab.is-active { background: var(--accent); color: var(--accent-fg); }
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
  background: var(--accent); color: var(--accent-fg);
  cursor: pointer; font-size: 13px; font-weight: 500; white-space: nowrap;
  min-height: 44px;
  touch-action: manipulation; user-select: none;
}
.nw-generate-btn:disabled {
  background: var(--surface); color: var(--muted); cursor: default; pointer-events: none;
}
@media (hover: hover) {
  .nw-generate-btn:not(:disabled):hover { filter: brightness(1.06); }
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

/* The host that window.mobius.chat mounts the nested ChatView iframe into.
   min-height:0 is the flexbox-overflow fix so the iframe scrolls internally. */
.nw-chat-embed {
  flex: 1 1 auto; min-height: 0; width: 100%;
  overflow: hidden; background: var(--bg);
}
.nw-chat-embed iframe { display: block; width: 100%; height: 100%; border: 0; }
.nw-chat-resolving {
  padding: 20px 16px 28px; display: flex; align-items: center; gap: 10px;
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
.nw-settings-wrap { max-width: 720px; }
.nw-settings-section { margin-bottom: 24px; }
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
  background: var(--accent); color: var(--accent-fg);
  font-size: 13px; font-weight: 600; cursor: pointer;
  touch-action: manipulation; user-select: none;
}
.nw-btn:disabled {
  background: var(--surface); color: var(--muted); cursor: default; pointer-events: none;
}
@media (hover: hover) {
  .nw-btn:not(:disabled):hover { filter: brightness(1.06); }
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
.nw-fallback-row {
  margin-top: 12px;
  display: grid;
  gap: 8px;
}
.nw-checkbox-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-size: 13px;
  font-weight: 650;
  line-height: 1.35;
}
.nw-checkbox-row input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
}
.nw-model-button {
  width: 100%; min-height: 46px; padding: 9px 12px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--surface); color: var(--text);
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; cursor: pointer; font-family: var(--font); text-align: left;
  touch-action: manipulation; user-select: none;
}
@media (hover: hover) {
  .nw-model-button:hover { border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-model-button:active { opacity: 0.85; }
}
.nw-model-button-main { min-width: 0; }
.nw-model-button-label { display: block; font-size: 13.5px; font-weight: 750; }
.nw-model-button-sub { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; font-family: var(--mono); }
.nw-model-button-caret { color: var(--muted); }

/* Picker sheet + scrim — anchored to the app root (absolute, not fixed). */
.nw-picker-backdrop {
  position: absolute; inset: 0; z-index: 20;
  background: var(--scrim, rgba(0,0,0,0.35)); display: flex;
  align-items: flex-end; justify-content: center;
  /* Bottom-pinned sheet: keep it clear of the home indicator on a phone. */
  padding: 16px;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
}
.nw-picker-sheet {
  width: min(560px, 100%); max-height: 72vh; overflow-y: auto;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 16px 16px 0 0;
  box-shadow: 0 -4px 8px rgba(0,0,0,0.28); padding: 14px;
  overscroll-behavior: contain;
}
.nw-picker-head { display: flex; align-items: center; margin-bottom: 12px; gap: 10px; }
.nw-picker-head-title { flex: 1; font-size: 14px; font-weight: 800; user-select: none; }
.nw-model-group { display: flex; flex-direction: column; gap: 6px; }
.nw-model-group-header {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600;
  letter-spacing: 0;
  color: var(--muted); margin: 2px 4px 4px;
  user-select: none;
}
.nw-model-group-hint {
  font-size: 12px; font-weight: 500;
  text-transform: none; letter-spacing: 0;
  color: var(--muted); opacity: 0.85;
}
.nw-model-row {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  padding: 10px 12px; border-radius: 10px; cursor: pointer;
  background: var(--surface); border: 1px solid var(--border);
  font-family: var(--font); font-size: 13px; font-weight: 500; color: var(--text);
  user-select: none; touch-action: manipulation;
}
.nw-model-row.is-on { background: var(--accent-dim); border-color: var(--accent); }
.nw-model-row:disabled { cursor: not-allowed; opacity: 0.55; pointer-events: none; }
.nw-model-row.is-on:disabled { opacity: 1; }
@media (hover: hover) {
  .nw-model-row:not(:disabled):not(.is-on):hover { border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-model-row:not(:disabled):active { opacity: 0.85; }
}
.nw-model-row-main { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.nw-model-row-title { font-weight: 600; }
.nw-model-row-sub { font-size: 12px; color: var(--muted); font-weight: 400; font-family: var(--mono); }

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
.nw-rq__opt--on { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.nw-rq__opt--dim { opacity: 0.4; border-color: transparent; }
.nw-rq__opt:disabled { cursor: default; }
.nw-rq__submit {
  display: block; width: 100%; margin-top: 14px; min-height: 44px;
  padding: 11px; border-radius: 10px; border: none;
  background: var(--accent); color: var(--accent-fg);
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
