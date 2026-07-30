// undici's fetch rejects with a bare "fetch failed", hiding the actionable syscall error (ECONNREFUSED, ...) in err.cause — walk the chain so status lines stay debuggable.
export function errMsg(err: unknown): string {
  return describe(err, 0)
}

const MAX_CAUSE_DEPTH = 4

function describe(err: unknown, depth: number): string {
  if (err instanceof AggregateError && err.errors.length > 0) {
    // Depth cap applies here too: errors arrays can nest or even be cyclic.
    if (depth >= MAX_CAUSE_DEPTH) {
      return err.message || 'AggregateError'
    }
    const inner = err.errors.map((e) => describe(e, depth + 1)).join('; ')
    // Node's Happy-Eyeballs AggregateError usually carries no message of its own.
    return err.message && err.message !== 'AggregateError' ? `${err.message}: ${inner}` : inner
  }
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause
    if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH) {
      return `${err.message}: ${describe(cause, depth + 1)}`
    }
    return err.message
  }
  return String(err)
}
