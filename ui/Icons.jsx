import React from 'react'

// Shared inline SVG icons. ChatBubbleIcon is the reader-bar chat toggle glyph
// (ReportReader). Kept in one place so app-chrome glyphs don't scatter across
// consumers.
export function ChatBubbleIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}
