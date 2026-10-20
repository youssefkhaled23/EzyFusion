import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Keeps the Supabase session fresh for page requests: expiring access tokens are refreshed and the new cookies are written
 * to both the request (so Server Components see them) and the response. It does not authorize anything: every page and API
 * handler verifies the user and resolves the role from the database itself.
 */
export async function proxy(request: NextRequest) {
  if (request.cookies.getAll().length === 0) return NextResponse.next()
  let response = NextResponse.next({ request })
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list, headers) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v))
      },
    },
  })
  await supabase.auth.getUser()
  return response
}

export const config = {
  // pages only: API handlers authenticate themselves, and static assets need no session
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
