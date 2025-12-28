'use client'

import posthog from 'posthog-js'

export function register() {
  // Next.js expects `register()` in instrumentation files.
  // Guard for non-browser environments and avoid hard crashes in dev.
  if (typeof window === 'undefined') return

  try {
    posthog.init('phc_v1zGl740rSRNUNCouxKTzOdK31AIcRRWXNf4VMpfa4y', {
      api_host: 'https://us.i.posthog.com',
    })
  } catch (err) {
    console.error('[posthog] init failed', err)
  }
}
