import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, isValidToken } from "@/lib/auth";

/** Gate everything behind the passcode except the login page and PWA assets. */
export async function proxy(req: NextRequest) {
  if (await isValidToken(req.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();

  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Locked" }, { status: 401 });
  }
  const login = new URL("/login", req.url);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    "/((?!login|api/login|_next/|icons/|manifest.webmanifest|sw.js|favicon.ico|robots.txt).*)",
  ],
};
