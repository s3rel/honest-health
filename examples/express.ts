import express from 'express'
import { buildHealth, probe, verifyTimezone, HEALTH_HEADERS } from 'honest-health'

const app = express()
const TZ = 'UTC'

app.get('/healthz', async (_req, res) => {
  const started = Date.now()
  const at = new Date()
  const db = await probe((signal) => pool.query({ text: 'select 1', signal }))

  const { body, status } = buildHealth({
    deps: { db },
    tz: TZ,
    tzValid: verifyTimezone(TZ, 0, at),
    at,
    durationMs: Date.now() - started,
    version: process.env.npm_package_version ?? '0.0.0',
  })

  res.set(HEALTH_HEADERS).status(status).send(JSON.stringify(body))
})
