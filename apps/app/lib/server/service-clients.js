const SERVICE_HOST = process.env.MIROSHARK_SERVICE_HOST || 'http://127.0.0.1'

export function executionUrl(pathname) {
  return `${SERVICE_HOST}:5004${pathname}`
}

export function cogitoUrl(pathname) {
  return `${SERVICE_HOST}:5003${pathname}`
}

export async function readJson(url, options = {}) {
  const response = await fetch(url, {
    cache: 'no-store',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = data?.message || data?.error || `HTTP ${response.status}`
    throw new Error(message)
  }
  return data
}
