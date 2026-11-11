import { describe, expect, it } from 'vitest'
import {
  buildHealth,
  sanitizeErrorCode,
  verifyTimezone,
  offsetMinutes,
  HEALTH_HEADERS,
} from '../src/core.js'

const AT = new Date('2026-11-11T09:00:00.000Z')

const healthy = () =>
  buildHealth({
    deps: { db: { up: true } },
    tz: 'Europe/Istanbul',
    tzValid: true,
    at: AT,
    durationMs: 12,
    version: '1.0.0',
    commit: 'abc1234',
  })

describe('status code', () => {
  it('returns 200 when every dependency is up', () => {
    expect(healthy().status).toBe(200)
  })

  it('returns 503 — not 200, not 500 — when a dependency is down', () => {
    const { status, body } = buildHealth({
      deps: { db: { up: false } },
      tz: 'Europe/Istanbul',
      tzValid: true,
      at: AT,
      durationMs: 4000,
      version: '1.0.0',
    })
    expect(status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.deps.db).toBe('down')
  })

  it('returns 503 when the runtime cannot resolve the timezone', () => {
    const { status, body } = buildHealth({
      deps: { db: { up: true } },
      tz: 'Europe/Istanbul',
      tzValid: false,
      at: AT,
      durationMs: 5,
      version: '1.0.0',
    })
    expect(status).toBe(503)
    expect(body.error).toBe('timezone')
  })

  it('is down if ANY dependency is down, not just the first', () => {
    const { status } = buildHealth({
      deps: { db: { up: true }, cache: { up: false }, queue: { up: true } },
      tz: 'UTC',
      tzValid: true,
      at: AT,
      durationMs: 9,
      version: '1.0.0',
    })
    expect(status).toBe(503)
  })
})

describe('error code sanitisation', () => {
  it('passes SQLSTATE and PostgREST codes through', () => {
    expect(sanitizeErrorCode({ code: '42501' })).toBe('42501')
    expect(sanitizeErrorCode({ code: '08006' })).toBe('08006')
    expect(sanitizeErrorCode({ code: 'PGRST301' })).toBe('PGRST301')
  })

  it('drops everything that is not one of those two shapes', () => {
    expect(sanitizeErrorCode({ code: 'ECONNREFUSED' })).toBeNull()
    expect(sanitizeErrorCode({ code: 'relation "users" does not exist' })).toBeNull()
    expect(sanitizeErrorCode({ code: 42501 })).toBeNull()
    expect(sanitizeErrorCode({ message: '42501' })).toBeNull()
    expect(sanitizeErrorCode(null)).toBeNull()
    expect(sanitizeErrorCode(undefined)).toBeNull()
    expect(sanitizeErrorCode('42501')).toBeNull()
  })
})

/**
 * 🔴 THE BAIT TEST.
 *
 * Plant every shape of secret we have ever seen a driver put into an
 * error object, then assert that NONE of it reaches the serialised
 * response. This is the test that has to keep passing when someone adds
 * a "just for debugging" field in six months.
 */
describe('secret leakage', () => {
  const BAIT = {
    code: 'ECONNREFUSED',
    message:
      'could not connect to postgres://admin:hunter2@db.internal:5432/prod',
    details: 'SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.FAKE',
    hint: 'check DATABASE_URL and AWS_SECRET_ACCESS_KEY',
    stack: 'at Object.<anonymous> (/srv/app/.env:1:1)',
  }

  const serialised = JSON.stringify(
    buildHealth({
      deps: { db: { up: false, rawError: BAIT } },
      tz: 'Europe/Istanbul',
      tzValid: true,
      at: AT,
      durationMs: 4000,
      version: '1.0.0',
      commit: 'abc1234',
    }).body,
  )

  for (const needle of [
    'hunter2',
    'postgres://',
    'db.internal',
    'SERVICE_ROLE',
    'eyJhbGciOi',
    'DATABASE_URL',
    'AWS_SECRET',
    '/srv/app',
    'ECONNREFUSED',
  ]) {
    it(`never serialises ${needle}`, () => {
      expect(serialised).not.toContain(needle)
    })
  }

  it('vacuum anchor: the body is non-empty and really is an object', () => {
    // Without this, every assertion above would pass on an empty string.
    expect(serialised.length).toBeGreaterThan(40)
    expect(serialised.startsWith('{')).toBe(true)
  })
})

/**
 * 🔑 BYTE-LEVEL CONTRACT.
 *
 * Keyword monitors (UptimeRobot et al.) match a literal substring in the
 * response body. Asserting `body.deps.db === 'up'` does NOT protect that
 * monitor: swap the serialiser for a pretty-printing one and the field
 * is still `'up'` while the bytes become `"db": "up"` and every monitor
 * fires a false alarm at 3am. So assert on the BYTES.
 */
describe('byte-level contract for keyword monitors', () => {
  const raw = JSON.stringify(healthy().body)

  it('contains "ok":true verbatim', () => {
    expect(raw).toContain('"ok":true')
  })

  it('does NOT contain a spaced variant', () => {
    expect(raw).not.toMatch(/"ok"\s*:\s+true/)
  })

  it('vacuum anchor: body is non-empty', () => {
    expect(raw.startsWith('{')).toBe(true)
    expect(raw.length).toBeGreaterThan(40)
  })
})

describe('timezone verification', () => {
  it('confirms a zone the runtime really knows', () => {
    expect(offsetMinutes('UTC', AT)).toBe(0)
    expect(verifyTimezone('UTC', 0, AT)).toBe(true)
  })

  it('fails when the expected offset does not match', () => {
    expect(verifyTimezone('UTC', 180, AT)).toBe(false)
  })

  it('returns false instead of throwing on an unknown zone', () => {
    expect(verifyTimezone('Mars/Olympus_Mons', 0, AT)).toBe(false)
  })

  it('detects silent UTC fallback for a non-UTC zone', () => {
    // On an image without full ICU data this is what happens: the format
    // call succeeds, the offset silently becomes 0, and every displayed
    // time is wrong. Comparing numerically is what makes it visible.
    const offset = offsetMinutes('Europe/Istanbul', AT)
    expect(offset === 0 ? 'ICU DATA MISSING' : 'ok').toBe('ok')
  })
})

describe('response headers', () => {
  it('forbids caching — a cached "ok" outlives the server', () => {
    expect(HEALTH_HEADERS['cache-control']).toContain('no-store')
  })
})
