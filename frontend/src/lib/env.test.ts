import { describe, expect, it } from "vitest";
import { parsePublicEnv } from "./env";

const validEnv = {
  VITE_SUPABASE_URL: "https://svqzxrkkakfiigrsndzn.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example_key",
  VITE_APP_URL: "http://localhost:5173",
  VITE_APP_ENV: "local",
};

describe("parsePublicEnv", () => {
  it("accepts documented local public configuration", () => {
    expect(parsePublicEnv({
      ...validEnv,
      VITE_APP_URL: "http://localhost:5173",
    }, "development").success).toBe(true);
  });

  it("allows local development to use the production project", () => {
    expect(parsePublicEnv(validEnv, "development").success).toBe(true);
  });

  it("accepts the production environment in production mode", () => {
    expect(parsePublicEnv({
      ...validEnv,
      VITE_APP_ENV: "production",
      VITE_APP_URL: "https://portal.example.com",
    }, "production").success).toBe(true);
  });

  it("rejects hosted app URLs for local mode", () => {
    const result = parsePublicEnv({
      ...validEnv,
      VITE_APP_URL: "https://portal.example.com",
    }, "development");
    expect(result.success).toBe(false);
  });

  it("rejects non-production projects in every frontend mode", () => {
    const result = parsePublicEnv({
      ...validEnv,
      VITE_SUPABASE_URL: "https://other-project.supabase.co",
    }, "development");
    expect(result.success).toBe(false);
  });

  it("requires VITE_APP_ENV to match the Vite mode", () => {
    const result = parsePublicEnv(validEnv, "production");
    expect(result.success).toBe(false);
  });

  it("treats Vite's default development mode as local", () => {
    const result = parsePublicEnv({
      ...validEnv,
      VITE_APP_ENV: "production",
    }, "development");
    expect(result.success).toBe(false);
  });

  it("rejects missing values without echoing any supplied secret", () => {
    const result = parsePublicEnv({
      VITE_SUPABASE_URL: validEnv.VITE_SUPABASE_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sb_secret_");
  });

  it("rejects service-role JWTs", () => {
    const serviceRoleJwt = `e30.${btoa(JSON.stringify({ role: "service_role" }))}.signature`;
    const result = parsePublicEnv({
      ...validEnv,
      VITE_SUPABASE_PUBLISHABLE_KEY: serviceRoleJwt,
    });
    expect(result.success).toBe(false);
  });

  it("requires HTTPS for non-local Supabase projects", () => {
    const result = parsePublicEnv({
      ...validEnv,
      VITE_SUPABASE_URL: "http://project.supabase.co",
    });
    expect(result.success).toBe(false);
  });
});
