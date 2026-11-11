# honest-health

**A health endpoint that does not lie.**

Most health endpoints are written in ten minutes and then trusted for
years. This one was rewritten after each of seven production incidents
in which the endpoint said *"everything is fine"* while it was not. Each
failure below was measured on a live system, not imagined.

```
npm i honest-health
```

Zero runtime dependencies. Framework-agnostic. Node ≥ 18.

---

## The seven ways a health endpoint lies

### 1. It returns `200` unconditionally

An endpoint written to be *cheap* ends up answering without touching
anything:

```ts
export function HEAD() { return new Response(null, { status: 200 }) }
```

Monitoring services send `HEAD` by default. So the database can be
completely gone and the monitor keeps reporting green — forever.

> **Measured:** one of our products ran for four months on a monitor
> pointed at exactly this endpoint. It caught infrastructure outages
> (the platform's own `402` and `503` came from the edge, before the
> app) but was structurally blind to the single most likely failure:
> *app up, database down*.

**This library:** `buildHealth` returns `503` whenever any dependency is
down. There is no configuration to turn that off.

### 2. A redirect looks like a pulse

`/healthz` carries no locale, so an i18n middleware helpfully rewrote it
to `/tr/healthz`, where nothing existed:

```
/healthz  →  307  →  /tr/healthz  →  404
```

A monitor that only inspects the status code sees `307`, which is not an
error, and reports the site as up. **Even if the site is entirely dead.**

**This library:** cannot fix your router, but
[`docs/ROUTING.md`](docs/ROUTING.md) shows the matcher exemption and the
regression test that keeps the path exempt. Always measure the
**redirect count**, not just the final status:

```bash
curl -s -o /dev/null -w '%{http_code} %{num_redirects}\n' -L https://example.com/healthz
# want: 200 0
```

### 3. It leaks secrets

Driver errors are rich. `message`, `details` and `hint` routinely carry
the connection string, the schema, and — when someone passes the whole
error object through — environment variable names and values.

A health endpoint is usually the most reachable unauthenticated route
you have.

**This library:** `sanitizeErrorCode` is a **closed allowlist**. Only
Postgres `SQLSTATE` (five alphanumerics) and PostgREST (`PGRST` + three
digits) survive. Everything else becomes `null`. The test suite plants
bait — a fake connection string, a fake JWT, an `AWS_SECRET_ACCESS_KEY`
mention, a stack trace with a path — and asserts none of it is ever
serialised.

### 4. The runtime silently forgets your timezone

Slim Node and Alpine images ship without full ICU data. Then:

```ts
new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Istanbul' })
```

either throws **or silently falls back to UTC**. In the silent case the
application keeps serving, every displayed time is off by the offset, and
no ordinary test notices — because the code *did* run and the format
*did* succeed.

**This library:** `verifyTimezone` compares the offset **numerically**.
It does not parse `timeZoneName: 'longOffset'`, whose output is `GMT+3`
on some ICU builds and `GMT+03:00` on others.

### 5. Something caches the "ok"

A CDN, a reverse proxy or a browser caches a healthy response. The
monitor then reads a fresh *everything is fine* from a server that died
twenty minutes ago.

**This library:** exports `HEALTH_HEADERS` with
`cache-control: no-store, max-age=0`, and a test asserts it.

### 6. A hung dependency hangs the probe

Without a timeout, a stuck database makes the health endpoint stick too.
The monitor records *timeout* instead of *down*, and the reason — which
dependency, which error class — is lost.

**This library:** `probe()` enforces a budget (default 4 s) and reports
`error: 'timeout'` distinctly from `error: 'query'`.

### 7. Asserting on the object, not the bytes

Keyword monitors match a **literal substring** of the response body. A
test like this looks rigorous and protects nothing:

```ts
expect(body.deps.db).toBe('up')   // still passes…
```

…while someone swaps `JSON.stringify(x)` for `JSON.stringify(x, null, 2)`
and the bytes become `"db": "up"`. Field unchanged, monitor broken, false
alarms at 3am.

**This library:** ships byte-level assertions, including a negative one
for the spaced variant, plus a *vacuum anchor* — because every
`not.toContain` assertion passes trivially against an empty string.

```ts
expect(raw).toContain('"ok":true')
expect(raw).not.toMatch(/"ok"\s*:\s+true/)
expect(raw.startsWith('{')).toBe(true)   // vacuum anchor
```

---

## Usage

### The pure core

```ts
import { buildHealth, verifyTimezone } from 'honest-health'

const at = new Date()
const { body, status } = buildHealth({
  deps: { db: { up: true } },
  tz: 'Europe/Istanbul',
  tzValid: verifyTimezone('Europe/Istanbul', 180, at),
  at,
  durationMs: 12,
  version: '1.4.0',
  commit: process.env.BUILD_SHA ?? null,
})
```

`buildHealth` is pure: no network, no clock, no environment, no
framework. That is the part worth unit-testing, and the part that
normally ends up welded to a web framework.

### With a probe

```ts
import { buildHealth, probe, verifyTimezone, HEALTH_HEADERS } from 'honest-health'

const started = Date.now()
const at = new Date()

const db = await probe(
  (signal) => sql.query('select 1').signal(signal),
  { classify: (e) => (isMissingEnv(e) ? 'env_missing' : undefined) },
)

const { body, status } = buildHealth({
  deps: { db },
  tz: 'Europe/Istanbul',
  tzValid: verifyTimezone('Europe/Istanbul', 180, at),
  at,
  durationMs: Date.now() - started,
  version: pkg.version,
})

return new Response(JSON.stringify(body), { status, headers: HEALTH_HEADERS })
```

Framework examples: [Next.js](examples/nextjs-route.ts) ·
[Express](examples/express.ts) · [Fastify](examples/fastify.ts)

### Response shape

```json
{
  "ok": true,
  "deps":  { "db": "up" },
  "codes": { "db": null },
  "tz": "Europe/Istanbul",
  "tz_valid": true,
  "utc": "2026-11-11T09:00:00.000Z",
  "version": "1.4.0",
  "commit": "abc1234",
  "duration_ms": 12,
  "error": null
}
```

A human should be able to read *what broke* in ten seconds: which
dependency is down, which error class, how long the probe took, and
which build is answering.

---

## Writing the probe

Make it **cheap** — this runs every minute, forever. Cheap is not the
same as fake: it should still traverse the path you care about (network,
pooler, driver, permissions) without doing real work. Selecting one
column from a small public reference table is the usual shape.

Use your **lowest-privilege** credential. A health endpoint has no
business holding an admin key, and probing as the anonymous role means
you measure the path your visitors actually use.

---

## Configuring your monitor

Status code alone is enough, because this library returns `503` on
failure. If your monitor supports keyword matching, use it as a **second**
guarantee, not the primary one:

```
URL      https://example.com/healthz
Type     Keyword
Keyword  "ok":true
Rule     alert when keyword does NOT exist
```

Then pin that string with the byte-level test above, so a serialiser
change cannot silently turn it into a false alarm.

---

## Origin

Extracted from the production code of
**Asmisoft Yazılım ve Bilişim Teknolojileri** (three SaaS products:
appointment booking, QR menus, point of sale), where every failure mode
above was paid for once.

MIT licensed. Issues and pull requests welcome — especially additional
failure modes, with evidence.
