import { NextResponse, type NextRequest } from "next/server";

/**
 * Edge-level gate. It only checks that a session cookie is present — the real
 * authorisation happens in each route with `requireUser` / `requireServerAccess`,
 * because the edge runtime cannot reach the database. This exists to redirect
 * signed-out visitors, not to protect data.
 */
const PUBLIC_PATHS = ["/login", "/register", "/api/auth", "/api/billing/webhook"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) return NextResponse.next();

  if (!req.cookies.get("deers_session")) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "same-origin");
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
