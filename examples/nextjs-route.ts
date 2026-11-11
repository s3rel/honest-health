// app/healthz/route.ts  — Next.js App Router
import { buildHealth, probe, verifyTimezone, HEALTH_HEADERS } from 'honest-health'
import { createClient } from '@/lib/db'
import pkg from '../package.json' with { type: 'json' }

export const dynamic = 'force-dynamic' // never prerender a health endpoint

const TZ = 'Europe/Istanbul'
const TZ_OFFSET_MINUTES = 180 // Türkiye has had no DST since 2016

export async function GET() {
  const started = Date.now()
  const at = new Date()

  const db = await probe(
    async (signal) => createClient().from('plans').select('code', { head: true }).limit(1).abortSignal(signal),
    { classify: (e) => (e instanceof Error && /env/i.test(e.message) ? 'env_missing' : undefined) },
  )

  const { body, status } = buildHealth({
    deps: { db },
    tz: TZ,
    tzValid: verifyTimezone(TZ, TZ_OFFSET_MINUTES, at),
    at,
    durationMs: Date.now() - started,
    version: pkg.version,
    commit: process.env.BUILD_SHA ?? null,
  })

  return Response.json(body, { status, headers: HEALTH_HEADERS })
}

// ⚠️ Do NOT add a HEAD handler that answers without probing.
// That is failure mode #1 in the README.
