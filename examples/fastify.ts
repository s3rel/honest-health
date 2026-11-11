import Fastify from 'fastify'
import { buildHealth, probe, verifyTimezone, HEALTH_HEADERS } from 'honest-health'

const app = Fastify()
const TZ = 'UTC'

app.get('/healthz', async (_req, reply) => {
  const started = Date.now()
  const at = new Date()
  const db = await probe((signal) => pool.query({ text: 'select 1', signal }))

  const { body, status } = buildHealth({
    deps: { db },
    tz: TZ,
    tzValid: verifyTimezone(TZ, 0, at),
    at,
    durationMs: Date.now() - started,
    version: '0.0.0',
  })

  return reply.code(status).headers(HEALTH_HEADERS).send(body)
})
