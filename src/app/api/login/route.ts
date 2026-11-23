import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, AUTH_MAX_AGE, expectedToken, passcodeMatches } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { passcode } = (await req.json().catch(() => ({}))) as { passcode?: string };
  // Small delay to make guessing tedious.
  await new Promise((r) => setTimeout(r, 400));
  if (!passcode || !passcodeMatches(passcode)) {
    return NextResponse.json({ error: "That's not the magic word." }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await expectedToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: AUTH_MAX_AGE,
  });
  return res;
}
