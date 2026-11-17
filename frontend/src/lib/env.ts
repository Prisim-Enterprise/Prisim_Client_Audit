import { z } from "zod";

const publicEnvSchema = z.object({
  VITE_SUPABASE_URL: z.string().url(),
  VITE_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  VITE_APP_URL: z.string().url(),
  VITE_APP_ENV: z.enum(["local", "production"]),
});

export type PublicEnv = {
  supabaseUrl: string;
  publishableKey: string;
  appUrl: string;
  appEnvironment: "local" | "production";
};

export type EnvResult =
  | { success: true; data: PublicEnv }
  | { success: false; errors: string[] };

function isPublicSupabaseKey(value: string): boolean {
  if (value.startsWith("sb_secret_")) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return true;

  const parts = value.split(".");
  if (parts.length !== 3) return false;

  try {
    const payload = JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { role?: unknown };
    return payload.role === "anon";
  } catch {
    return false;
  }
}

const productionProjectHost = "svqzxrkkakfiigrsndzn.supabase.co";

export function parsePublicEnv(raw: Record<string, unknown>, mode?: string): EnvResult {
  const parsed = publicEnvSchema.safeParse(raw);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => {
      const key = issue.path[0];
      return typeof key === "string" ? key : "frontend configuration";
    });
    return {
      success: false,
      errors: [...new Set(missing)],
    };
  }

  const { VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_APP_URL, VITE_APP_ENV } =
    parsed.data;

  const expectedEnvironment = mode === "development"
    ? "local"
    : mode === "local" || mode === "production"
    ? mode
    : undefined;
  if (mode && mode !== "test" && !expectedEnvironment) {
    return {
      success: false,
      errors: ["Unsupported frontend environment mode."],
    };
  }
  if (expectedEnvironment && VITE_APP_ENV !== expectedEnvironment) {
    return {
      success: false,
      errors: [`VITE_APP_ENV must be "${expectedEnvironment}" for this Vite mode.`],
    };
  }

  if (!isPublicSupabaseKey(VITE_SUPABASE_PUBLISHABLE_KEY)) {
    return {
      success: false,
      errors: ["VITE_SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable or anon key."],
    };
  }

  try {
    const supabaseUrl = new URL(VITE_SUPABASE_URL);
    const appUrl = new URL(VITE_APP_URL);
    const projectHost = supabaseUrl.hostname.toLowerCase();
    const isLocal = ["localhost", "127.0.0.1"].includes(supabaseUrl.hostname);
    if (projectHost !== productionProjectHost) {
      return {
        success: false,
        errors: ["Only the configured production Supabase project is permitted."],
      };
    }
    if (supabaseUrl.protocol !== "https:" && !(isLocal && supabaseUrl.protocol === "http:")) {
      return {
        success: false,
        errors: ["VITE_SUPABASE_URL must use HTTPS except for local development."],
      };
    }
    const appIsLocal = ["localhost", "127.0.0.1"].includes(appUrl.hostname);
    if (VITE_APP_ENV === "local" && !appIsLocal) {
      return {
        success: false,
        errors: ["Local frontend mode must use a localhost application URL."],
      };
    }
    if (VITE_APP_ENV === "production" && appIsLocal) {
      return {
        success: false,
        errors: ["Production frontend mode must use its hosted application URL."],
      };
    }
    if (appUrl.protocol !== "https:" && !(appIsLocal && appUrl.protocol === "http:")) {
      return {
        success: false,
        errors: ["VITE_APP_URL must use HTTPS except for local development."],
      };
    }
  } catch {
    return { success: false, errors: ["Supabase and app URLs must be valid URLs."] };
  }

  return {
    success: true,
    data: {
      supabaseUrl: VITE_SUPABASE_URL,
      publishableKey: VITE_SUPABASE_PUBLISHABLE_KEY,
      appUrl: VITE_APP_URL.replace(/\/+$/, ""),
      appEnvironment: VITE_APP_ENV,
    },
  };
}
