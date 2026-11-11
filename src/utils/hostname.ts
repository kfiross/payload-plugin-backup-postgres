const CONNECTION_ENV_KEYS = ['DATABASE_URI', 'DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URI']

export function getConnectionString(): string | undefined {
  for (const key of CONNECTION_ENV_KEYS) {
    const v = process.env[key]?.trim()
    if (v) {
      return v
    }
  }
  return undefined
}

/** `host/dbname` of the Postgres connection (credentials are never included). */
export function getCurrentDbName(): string {
  try {
    const { hostname, pathname } = new URL(getConnectionString()!)
    return hostname + pathname
  } catch {
    return 'none'
  }
}

export function getCurrentHostname(): string {
  try {
    return process.env.NEXT_PUBLIC_SERVER_URL ?
        new URL(process.env.NEXT_PUBLIC_SERVER_URL).hostname
      : (process.env.VERCEL_URL ?? 'none')
  } catch {
    return process.env.VERCEL_URL! || 'none'
  }
}
