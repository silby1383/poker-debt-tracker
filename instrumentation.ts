export function register() {
  const shouldIgnore = (err: unknown): boolean => {
    const anyErr = err as { code?: unknown; message?: unknown } | null
    const code = anyErr?.code
    const message = anyErr?.message

    // Common when the client disconnects / cancels a request (esp. in dev/HMR)
    if (code === 'ECONNRESET') return true
    if (typeof message === 'string' && message.toLowerCase().includes('aborted'))
      return true

    return false
  }

  process.on('unhandledRejection', (reason) => {
    if (shouldIgnore(reason)) return
    // Let real errors surface normally
    // eslint-disable-next-line no-console
    console.error('[unhandledRejection]', reason)
  })

  process.on('uncaughtException', (err) => {
    if (shouldIgnore(err)) return
    // eslint-disable-next-line no-console
    console.error('[uncaughtException]', err)
  })
}
