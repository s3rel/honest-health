import {
  DEFAULT_PROBE_TIMEOUT_MS,
  type DependencyResult,
  type HealthErrorClass,
} from './core.js'

export type ProbeOptions = {
  /** Abort the probe after this many milliseconds. */
  timeoutMs?: number
  /**
   * Classify a thrown error. Use this when a missing environment
   * variable throws, so it is reported as `env_missing` rather than a
   * generic query failure — the class is useful, the message is not.
   */
  classify?: (error: unknown) => HealthErrorClass | undefined
}

/**
 * Run one dependency check under a timeout and return a safe result.
 *
 * The probe you pass should be CHEAP — this endpoint gets called every
 * minute, forever. Cheap does not mean fake: it should still traverse
 * the whole path you care about (network, pooler, driver, permissions),
 * just without doing real work. A `SELECT` of one column from a small
 * reference table with `HEAD`-style semantics is the usual shape.
 *
 * Prefer your LOWEST-privilege credential. A health endpoint has no
 * business holding an admin key, and probing as the anonymous role also
 * means you measure the path your visitors actually use.
 *
 * The `AbortSignal` is handed to your probe so a client that supports
 * cancellation can honour it; the timeout is enforced regardless.
 */
export async function probe(
  fn: (signal: AbortSignal) => Promise<unknown>,
  options: ProbeOptions = {},
): Promise<DependencyResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const result = await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new DOMException('probe timed out', 'TimeoutError')),
          { once: true },
        )
      }),
    ])

    // Clients that return `{ error }` instead of throwing (PostgREST,
    // Supabase) are the common case, so handle both shapes.
    const maybeError = (result as { error?: unknown } | null)?.error
    if (maybeError) {
      return {
        up: false,
        rawError: maybeError,
        error: controller.signal.aborted ? 'timeout' : 'query',
      }
    }
    return { up: true }
  } catch (error) {
    if (controller.signal.aborted) {
      return { up: false, rawError: error, error: 'timeout' }
    }
    return {
      up: false,
      rawError: error,
      error: options.classify?.(error) ?? 'connection',
    }
  } finally {
    clearTimeout(timer)
  }
}
