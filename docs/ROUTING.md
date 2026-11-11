# Routing: do not let middleware answer for your health endpoint

This is failure mode #2 from the README, and it is the one that is
hardest to see, because the endpoint *returns a 2xx/3xx* while being
completely broken.

## What happened

`/healthz` carries no locale segment. An i18n middleware treated it as
an un-localised page and rewrote it:

```
/healthz  →  307  →  /tr/healthz  →  404
```

A monitor that only inspects the final status code of a *followed*
redirect sees `404`. A monitor that does **not** follow redirects sees
`307` — not an error — and reports the service as healthy. Forever.

The same class applies to any middleware that can answer before your
route does: auth gates, locale routers, rewrite rules, trailing-slash
normalisers, WAFs.

## The fix, in Next.js

Exempt the path in the middleware matcher, next to the other
infrastructure paths:

```ts
export const config = {
  matcher: ['/((?!api|healthz|_next|_vercel|.*\..*).*)'],
}
```

## The regression test that keeps it fixed

The fix is one word in a regex, which means it can be deleted by
accident in any refactor. Pin it:

```ts
it('middleware never claims the health path', () => {
  const matcher = config.matcher[0]
  const re = new RegExp(matcher.replace(/^\/|\/$/g, ''))
  expect(re.test('healthz')).toBe(false)
})

it('the live path does not redirect', async () => {
  const res = await fetch(`${BASE}/healthz`, { redirect: 'manual' })
  expect(res.status).toBe(200)          // not 3xx
})
```

## Measure it in production, not in dev

A dev server frequently does not run the same middleware/edge layer as
production. Measure against a production build, and record the
**redirect count**:

```bash
curl -s -o /dev/null -w '%{http_code} %{num_redirects}\n' -L https://example.com/healthz
# want: 200 0
```

If you also add alias paths (`/kvkk → /privacy` and the like), check for
self-redirect loops: no alias target may itself be an alias source. That
mistake took one of our sites down four times before it was pinned by a
test.
