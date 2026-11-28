'use client'

import Script from 'next/script'

/**
 * Umami (open source, cookieless) page-view analytics. Renders nothing unless NEXT_PUBLIC_UMAMI_SRC and
 * NEXT_PUBLIC_UMAMI_WEBSITE_ID are set. Respects Do Not Track, ships no cookies, and sends no identifiers:
 * the app never calls umami.identify() and never passes health or account data as event properties.
 * The host must also be allowed in the CSP (frontend/public/_headers: script-src and connect-src).
 */
export function Analytics() {
  const src = process.env.NEXT_PUBLIC_UMAMI_SRC
  const id = process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID
  if (!src || !id) return null
  return <Script src={src} data-website-id={id} data-do-not-track="true" data-exclude-search="true" data-exclude-hash="true" strategy="afterInteractive" />
}
