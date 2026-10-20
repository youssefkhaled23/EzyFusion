/** Browser-side helper for the app's own JSON API. Cookies authenticate (same origin); errors carry the server's message. */
export interface ApiResult<T> {
  ok: boolean
  status: number
  data: T | null
  error: string | null
}

export async function postJson<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
    const data: unknown = await res.json().catch(() => null)
    const error = !res.ok && data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string' ? (data as { error: string }).error : null
    return { ok: res.ok, status: res.status, data: res.ok ? (data as T) : null, error: res.ok ? null : (error ?? `Request failed (${res.status})`) }
  } catch {
    return { ok: false, status: 0, data: null, error: 'Network error. Check your connection and try again.' }
  }
}

/** Friendly text for the API's status codes. */
export function describeFailure(status: number, serverMessage: string | null): string {
  switch (status) {
    case 401:
      return 'Your session has expired. Please sign in again.'
    case 403:
      return 'You are not allowed to do this.'
    case 404:
      return 'This item was not found.'
    case 409:
      return serverMessage ?? 'This item changed in the meantime. Refresh and try again.'
    case 422:
      return serverMessage ?? 'The amount is more than the lease can accept.'
    case 0:
      return serverMessage ?? 'Network error.'
    default:
      return serverMessage ?? 'Something went wrong. Please try again.'
  }
}
