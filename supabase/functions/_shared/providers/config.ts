// Provider configuration from Edge Function secrets. Only secret *names* are
// ever reported to clients, never values.

import { createGoogleProvider } from "./google.ts";
import { createMetaProvider } from "./meta.ts";
import type { AdProvider, FetchLike } from "./types.ts";

export type EnvReader = (name: string) => string | undefined;

export const DEFAULT_META_API_VERSION = "v26.0";
export const DEFAULT_GOOGLE_ADS_API_VERSION = "v24";

const REQUIRED = {
  meta: ["META_APP_ID", "META_APP_SECRET"],
  google: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"],
} as const;

const SHARED = ["APP_URL", "OAUTH_STATE_SECRET"] as const;

export type ProviderStatus = {
  configured: boolean;
  missing: string[];
  apiVersion: string;
};

function present(env: EnvReader, name: string) {
  const value = env(name);
  return typeof value === "string" && value.trim() !== "";
}

export function providerStatus(env: EnvReader): Record<"meta" | "google", ProviderStatus> {
  const result = {} as Record<"meta" | "google", ProviderStatus>;
  for (const provider of ["meta", "google"] as const) {
    const missing = [...REQUIRED[provider], ...SHARED].filter((name) => !present(env, name));
    const stateSecret = env("OAUTH_STATE_SECRET");
    if (stateSecret && stateSecret.length < 32 && !missing.includes("OAUTH_STATE_SECRET")) {
      missing.push("OAUTH_STATE_SECRET");
    }
    result[provider] = {
      configured: missing.length === 0,
      missing,
      apiVersion: provider === "meta"
        ? env("META_API_VERSION")?.trim() || DEFAULT_META_API_VERSION
        : env("GOOGLE_ADS_API_VERSION")?.trim() || DEFAULT_GOOGLE_ADS_API_VERSION,
    };
  }
  return result;
}

export function oauthRedirectUri(env: EnvReader): string {
  const appUrl = (env("APP_URL") ?? "").replace(/\/+$/, "");
  return `${appUrl}/oauth/callback`;
}

export function createProvider(provider: "meta" | "google", env: EnvReader, fetcher: FetchLike = fetch): AdProvider {
  const status = providerStatus(env)[provider];
  if (!status.configured) throw new Error(`Provider ${provider} is not configured.`);
  const redirectUri = oauthRedirectUri(env);
  if (provider === "meta") {
    return createMetaProvider({
      appId: env("META_APP_ID")!,
      appSecret: env("META_APP_SECRET")!,
      redirectUri,
      apiVersion: status.apiVersion,
    }, fetcher);
  }
  return createGoogleProvider({
    clientId: env("GOOGLE_OAUTH_CLIENT_ID")!,
    clientSecret: env("GOOGLE_OAUTH_CLIENT_SECRET")!,
    developerToken: env("GOOGLE_ADS_DEVELOPER_TOKEN")!,
    redirectUri,
    apiVersion: status.apiVersion,
  }, fetcher);
}
