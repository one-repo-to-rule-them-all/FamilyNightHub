import { type NextRequest, NextResponse } from "next/server";

/**
 * Cookie-presence redirects only (04-frontend.md). This is UX, not security: the API checks every
 * request, and the cookies are httpOnly, so presence is all the proxy can (or should) know.
 */
const DEVICE_COOKIE = "fnh_device";
const SESSION_COOKIE = "fnh_session";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const has = (name: string) => request.cookies.has(name);

  if (pathname === "/who" && !has(DEVICE_COOKIE)) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  if (pathname.startsWith("/host") && !has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (pathname === "/login" && has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/host", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/who", "/host/:path*", "/login"] };
