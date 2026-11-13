// HTTP helpers shared by the Edge Functions: strict CORS for the configured
// application origin, JSON responses without caching, and safe error bodies.

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly extra: Record<string, unknown> = {}) {
    super(code);
  }
}

export function appOrigin(appUrl: string | undefined): string | null {
  if (!appUrl) return null;
  try {
    const url = new URL(appUrl);
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function json(status: number, body: unknown, origin?: string | null): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Max-Age", "600");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function bearerToken(request: Request): string | null {
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export async function readBody(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, "request_too_large");
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "invalid_request");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new HttpError(400, "invalid_request");
  return payload as Record<string, unknown>;
}

export type Handler = (request: Request) => Promise<Response>;

/**
 * Wraps a POST JSON handler with CORS, method and origin checks. Requests
 * without an Origin header (server-to-server, cron) are allowed through to
 * the handler, which must authenticate them.
 */
export function withHttp(
  appUrl: string | undefined,
  handle: (request: Request, origin: string) => Promise<Response>,
  log: (message: string) => void = () => undefined,
): Handler {
  return async (request) => {
    const origin = appOrigin(appUrl);
    if (!origin) return json(500, { error: "server_configuration_error" });
    const requestOrigin = request.headers.get("Origin");
    if (request.method === "OPTIONS") {
      return requestOrigin === origin ? json(200, {}, origin) : json(403, { error: "origin_not_allowed" });
    }
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, origin);
    if (requestOrigin && requestOrigin !== origin) return json(403, { error: "origin_not_allowed" });
    try {
      return await handle(request, origin);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { error: error.code, ...error.extra }, origin);
      log(`unhandled error: ${error instanceof Error ? error.name : "unknown"}`);
      return json(500, { error: "internal_error" }, origin);
    }
  };
}
