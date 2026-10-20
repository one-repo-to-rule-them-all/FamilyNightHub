import { type NextRequest, NextResponse } from "next/server";

/**
 * Cookie-presence redirects only (04-frontend.md). This is UX, not security: the API checks every
 * request, and the cookies are httpOnly, so presence is all the proxy can (or should) know.
 */
const DEVICE_COOKIE = "fnh_device";
const SESSION_COOKIE = "fnh_session";
// ADR-0016: the platform operator's own session. Inside a household it opens the portal too.
const PLATFORM_COOKIE = "fnh_platform";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const has = (name: string) => request.cookies.has(name);

  if (pathname === "/who" && !has(DEVICE_COOKIE)) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  const portal = pathname.startsWith("/host") || pathname.startsWith("/admin");
  if (portal && !has(SESSION_COOKIE) && !has(PLATFORM_COOKIE)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (pathname === "/platform" && !has(PLATFORM_COOKIE)) {
    return NextResponse.redirect(new URL("/platform/login", request.url));
  }
  if (pathname === "/login" && has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/host", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/who", "/host/:path*", "/admin/:path*", "/login", "/platform"],
};
