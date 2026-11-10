import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

function readNodeEnvironment(name: string) {
  const nodeProcess: unknown = Reflect.get(globalThis, "process");
  const nodeEnv = typeof nodeProcess === "object" && nodeProcess !== null
    ? Reflect.get(nodeProcess, "env")
    : undefined;
  const value = typeof nodeEnv === "object" && nodeEnv !== null
    ? Reflect.get(nodeEnv, name)
    : undefined;
  return typeof value === "string" ? value : undefined;
}

const envDir = readNodeEnvironment("PRISIM_VITE_ENV_DIR") ?? ".";
const outDir = readNodeEnvironment("PRISIM_VITE_OUT_DIR") ?? "dist";

export default defineConfig({
  envDir,
  plugins: [react()],
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: "localhost",
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("/@supabase/")) return "supabase";
          if (/\/(react|react-dom|scheduler)\//.test(id)) return "react-vendor";
          if (id.includes("/@tanstack/")) return "query-vendor";
          if (id.includes("/react-hook-form/") || id.includes("/@hookform/")) return "forms";
          if (id.includes("/zod/")) return "validation";
          if (id.includes("/lucide-react/")) return "icons";
          if (id.includes("/@radix-ui/")) return "ui-primitives";
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
});
