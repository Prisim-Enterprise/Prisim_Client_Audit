// Signed, short-lived OAuth `state` values. The state travels through the
// browser and the provider, so it carries only identifiers (never tokens) and
// is protected by an HMAC-SHA256 signature with a server-only secret.
// The PKCE code verifier is derived from the secret and the state nonce, so
// nothing has to be stored between the start and completion requests.

export type OAuthStatePayload = {
  v: 1;
  /** privileged action id (oauth.connect, bound to the connection) */
  a: string;
  /** connection id */
  c: string;
  /** tenant id */
  t: string;
  /** provider */
  p: "meta" | "google";
  /** initiating user id */
  u: string;
  /** random nonce */
  n: string;
  /** expiry, epoch seconds */
  e: number;
};

const encoder = new TextEncoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index] ^ b[index];
  return diff === 0;
}

export function randomNonce(bytes = 16): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function signState(payload: OAuthStatePayload, secret: string): Promise<string> {
  if (secret.length < 32) throw new Error("OAUTH_STATE_SECRET must be at least 32 characters.");
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmac(secret, body));
  return `${body}.${signature}`;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function verifyState(
  state: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<OAuthStatePayload | null> {
  if (typeof state !== "string" || state.length > 2048) return null;
  const [body, signature, extra] = state.split(".");
  if (!body || !signature || extra !== undefined) return null;
  let expected: Uint8Array;
  let provided: Uint8Array;
  try {
    expected = await hmac(secret, body);
    provided = base64UrlDecode(signature);
  } catch {
    return null;
  }
  if (!timingSafeEqual(expected, provided)) return null;
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch {
    return null;
  }
  if (
    payload?.v !== 1
    || !uuid.test(payload.a) || !uuid.test(payload.c) || !uuid.test(payload.t) || !uuid.test(payload.u)
    || (payload.p !== "meta" && payload.p !== "google")
    || typeof payload.n !== "string" || payload.n.length < 16
    || typeof payload.e !== "number" || payload.e < nowSeconds
  ) {
    return null;
  }
  return payload;
}

/** PKCE (RFC 7636) verifier derived from the state nonce; 43 chars, S256. */
export async function pkceVerifier(secret: string, nonce: string): Promise<string> {
  return base64UrlEncode(await hmac(secret, `pkce:${nonce}`));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function constantTimeEqualText(a: string, b: string): boolean {
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}
