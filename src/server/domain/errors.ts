/** An error that maps directly to an HTTP status (401/403/404/409/422/400). Safe to show its message to clients. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const notFound = (what = 'not found') => new HttpError(404, what)
