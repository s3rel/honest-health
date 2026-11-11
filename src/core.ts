/**
 * honest-health — a health endpoint that does not lie.
 *
 * This file is PURE: no network, no clock, no environment, no framework.
 * Everything it needs is passed in. That is deliberate — the decision
 * logic is the part you want to unit-test and reuse, and it is the part
 * that usually ends up tangled with a web framework.
 */

/**
 * Error classes that may appear in a health response.
 *
 * This is a CLOSED SET, not free text. Free text is how connection
 * strings, schema names and environment variable names end up in a
 * publicly reachable endpoint.
 */
export type HealthErrorClass =
  | 'env_missing'
  | 'connection'
  | 'timeout'
  | 'query'
  | 'timezone'

export type HealthBody = {
  /** One glance, one decision: is every dependency up? */
  ok: boolean
  /** Dependency state, keyed by the name you gave it. */
  deps: Record<string, 'up' | 'down'>
  /**
   * Sanitised error code per failing dependency.
   * SQLSTATE (5 alphanumerics) or PostgREST (`PGRST` + 3 digits) only;
   * anything else becomes `null`. Never the raw driver message.
   */
  codes: Record<string, string | null>
  /** The timezone the application formats every displayed time with. */
  tz: string
  /** Can the runtime ACTUALLY resolve that timezone (is ICU data present)? */
  tz_valid: boolean
  utc: string
  version: string
  commit: string | null
  duration_ms: number
  error: HealthErrorClass | null
}

/** A dependency probe result, as handed to {@link buildHealth}. */
export type DependencyResult = {
  up: boolean
  /** The raw driver/client error. Only its CODE can reach the response. */
  rawError?: unknown
  /** Override the inferred error class for this dependency. */
  error?: HealthErrorClass
}

export type HealthInput = {
  deps: Record<string, DependencyResult>
  tz: string
  tzValid: boolean
  at: Date
  durationMs: number
  version: string
  commit?: string | null
}

/**
 * Default probe budget. If a dependency check takes longer than this,
 * treat it as down.
 *
 * A health endpoint without a timeout is worse than no health endpoint:
 * a hung database hangs the probe too, the monitor sees "timeout"
 * instead of "down", and the reason is lost.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 4000

/**
 * Reduce a driver error to a SAFE code, or `null`.
 *
 * Postgres `SQLSTATE` is five alphanumerics (`42501`, `08006`).
 * PostgREST codes are `PGRST` plus three digits. Anything that does not
 * match one of those two shapes is dropped — including, deliberately,
 * every human-readable `message`, `details` and `hint` field, because
 * those routinely carry the host, the database name and the schema.
 */
export function sanitizeErrorCode(raw: unknown): string | null {
  const code = (raw as { code?: unknown } | null | undefined)?.code
  if (typeof code !== 'string') return null
  if (/^PGRST[0-9]{3}$/.test(code)) return code
  if (/^[0-9A-Z]{5}$/.test(code)) return code
  return null
}

/**
 * Offset of a timezone from UTC, in minutes, at a given instant.
 *
 * `timeZoneName: 'longOffset'` is deliberately NOT used: its output is
 * `"GMT+3"` on some ICU builds and `"GMT+03:00"` on others, so parsing it
 * is brittle. This compares numbers instead of parsing text.
 */
export function offsetMinutes(tz: string, at: Date): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(at)) p[part.type] = part.value
  const localMs = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    // Some ICU builds render midnight as hour "24".
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  )
  const atMs = Math.floor(at.getTime() / 1000) * 1000
  return Math.round((localMs - atMs) / 60000)
}

/**
 * Does the runtime REALLY know this timezone?
 *
 * This is a real production failure class, not decoration. Slim
 * Node/Alpine/Docker images ship without full ICU data. In that state
 * `Intl.DateTimeFormat(..., { timeZone: 'Europe/Istanbul' })` either
 * throws or SILENTLY falls back to UTC — and in the silent case the app
 * keeps serving, every displayed time is wrong by the offset, and no
 * ordinary test notices. Verifying the offset numerically makes the
 * silent fallback visible.
 *
 * Pass the offset you expect at that instant. For a zone with DST you
 * will want to compute the expectation rather than hardcode it.
 */
export function verifyTimezone(
  tz: string,
  expectedOffsetMinutes: number,
  at: Date,
): boolean {
  try {
    return offsetMinutes(tz, at) === expectedOffsetMinutes
  } catch {
    return false
  }
}

/**
 * The pure decision: build the body and pick the HTTP status.
 *
 * 🔑 STATUS CODE: if not ok, **503 Service Unavailable**.
 *
 * WHY NOT 200: the only thing most monitors look at is the status code —
 * that is UptimeRobot's default rule, and it is what Docker and Caddy
 * health probes use. Returning `{"ok": false}` with a 200 is the same
 * trap as a redirect that looks alive: the failure becomes invisible to
 * the machine that is supposed to see it.
 *
 * WHY NOT 500: a 500 says "this endpoint has a bug" and gets triaged as
 * an application error. Here the application is running and a DEPENDENCY
 * is down. That is the definition of 503, and it also tells the caller
 * the condition is temporary and retryable.
 */
export function buildHealth(input: HealthInput): {
  body: HealthBody
  status: number
} {
  const deps: Record<string, 'up' | 'down'> = {}
  const codes: Record<string, string | null> = {}
  let firstError: HealthErrorClass | null = null

  for (const [name, result] of Object.entries(input.deps)) {
    deps[name] = result.up ? 'up' : 'down'
    codes[name] = result.up ? null : sanitizeErrorCode(result.rawError)
    if (!result.up && firstError === null) {
      firstError = result.error ?? 'query'
    }
  }

  const depsUp = Object.values(deps).every((s) => s === 'up')
  const ok = depsUp && input.tzValid

  const body: HealthBody = {
    ok,
    deps,
    codes,
    tz: input.tz,
    tz_valid: input.tzValid,
    utc: input.at.toISOString(),
    version: input.version,
    commit: input.commit ?? null,
    duration_ms: input.durationMs,
    error: ok ? null : (firstError ?? (input.tzValid ? 'query' : 'timezone')),
  }

  return { body, status: ok ? 200 : 503 }
}

/**
 * Headers every health response must carry.
 *
 * `no-store` is not optional. If anything in the path — a CDN, a reverse
 * proxy, a browser — caches an "ok" response, the monitor reads a fresh
 * "everything is fine" from a server that is already dead. That is the
 * same silent trap in a different costume.
 */
export const HEALTH_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'cache-control': 'no-store, max-age=0',
  'content-type': 'application/json; charset=utf-8',
})
