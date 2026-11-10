import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicEnv } from "./env";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

import { createSupabaseBrowserClient } from "./supabase";

describe("createSupabaseBrowserClient", () => {
  beforeEach(() => {
    createClientMock.mockReset();
  });

  it("initializes the public client with PKCE and persisted browser sessions", () => {
    const env: PublicEnv = {
      supabaseUrl: "https://svqzxrkkakfiigrsndzn.supabase.co",
      publishableKey: "sb_publishable_production_public_key",
      appUrl: "http://localhost:5173",
      appEnvironment: "local",
    };

    createSupabaseBrowserClient(env);

    expect(createClientMock).toHaveBeenCalledWith(
      env.supabaseUrl,
      env.publishableKey,
      {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
          flowType: "pkce",
        },
      },
    );
  });
});
