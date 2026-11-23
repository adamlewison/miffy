/**
 * Tiny passcode lock. The cookie holds HMAC(secret, passcode), so changing
 * either BUNNY_PASSCODE or AUTH_SECRET logs every device out.
 * Uses Web Crypto so it works in both the proxy and route handlers.
 */

export const AUTH_COOKIE = "bunny_auth";
export const AUTH_MAX_AGE = 60 * 60 * 24 * 365; // a year — she shouldn't have to re-enter it

export function authEnabled() {
  return !!process.env.BUNNY_PASSCODE;
}

async function hmac(message: string): Promise<string> {
  const secret = process.env.AUTH_SECRET || `bunny:${process.env.BUNNY_PASSCODE}`;
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function expectedToken() {
  return hmac(`passcode:${process.env.BUNNY_PASSCODE ?? ""}`);
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isValidToken(token: string | undefined) {
  if (!authEnabled()) return true;
  if (!token) return false;
  return safeEqual(token, await expectedToken());
}

export function passcodeMatches(input: string) {
  const real = process.env.BUNNY_PASSCODE ?? "";
  return safeEqual(input.trim().toLowerCase(), real.trim().toLowerCase());
}
