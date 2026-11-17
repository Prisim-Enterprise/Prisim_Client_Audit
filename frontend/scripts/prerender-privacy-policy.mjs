// Writes <outDir>/privacy-policy.html: the public privacy policy as static HTML
// (no JavaScript needed), using the stylesheet of the production build.
// Run after `vite build`. vercel.json rewrites /privacy-policy to this file.
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, process.env.PRISIM_VITE_OUT_DIR ?? "dist");
const ssrDir = resolve(root, "dist-prerender");

await build({
  root,
  mode: "production",
  logLevel: "warn",
  build: { ssr: "src/prerender/privacyPolicy.tsx", outDir: ssrDir, emptyOutDir: true, copyPublicDir: false },
});

try {
  const module = await import(pathToFileURL(resolve(ssrDir, "privacyPolicy.js")).href);
  const markup = module.renderPrivacyPolicyMarkup();
  for (const required of ["Privacy Policy", "info@prisim.co.in", "Mathikere, Bangalore - 560054"]) {
    if (!markup.includes(required)) throw new Error(`Prerendered privacy policy is missing: ${required}`);
  }

  const escape = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  let html = await readFile(resolve(outDir, "index.html"), "utf8");
  html = html
    // Static page: no application scripts.
    .replace(/\s*<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/\s*<link\b[^>]*rel="modulepreload"[^>]*>/g, "")
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escape(module.PRIVACY_POLICY_TITLE)}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${escape(module.PRIVACY_POLICY_DESCRIPTION)}$2`)
    .replace(/<div id="root"><\/div>/, `<div id="root">${markup}</div>`);
  if (!html.includes(markup) || /<script\b/.test(html)) throw new Error("Could not build privacy-policy.html");
  await writeFile(resolve(outDir, "privacy-policy.html"), html);
  console.log(`privacy-policy.html written (${Math.round(html.length / 1024)} kB)`);
} finally {
  await rm(ssrDir, { recursive: true, force: true });
}
