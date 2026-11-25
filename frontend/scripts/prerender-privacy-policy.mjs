// Writes the public legal pages as static HTML (no JavaScript needed), using
// the stylesheet of the production build:
//   <outDir>/privacy-policy.html    and    <outDir>/terms-of-service.html
// Run after `vite build`. vercel.json rewrites /privacy-policy and
// /terms-of-service to these files.
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, process.env.PRISIM_VITE_OUT_DIR ?? "dist");
const ssrDir = resolve(root, "dist-prerender");

const PAGES = [
  {
    entry: "privacyPolicy",
    file: "privacy-policy.html",
    render: "renderPrivacyPolicyMarkup",
    title: "PRIVACY_POLICY_TITLE",
    description: "PRIVACY_POLICY_DESCRIPTION",
    required: ["Privacy Policy", "info@prisim.co.in", "MSR Road, Mathikere,", "Bangalore - 560054."],
  },
  {
    entry: "termsOfService",
    file: "terms-of-service.html",
    render: "renderTermsOfServiceMarkup",
    title: "TERMS_OF_SERVICE_TITLE",
    description: "TERMS_OF_SERVICE_DESCRIPTION",
    required: ["Terms of Service", "info@prisim.co.in", "MSR Road, Mathikere,", "Bangalore - 560054."],
  },
];

await build({
  root,
  mode: "production",
  logLevel: "warn",
  build: {
    ssr: true,
    outDir: ssrDir,
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: {
      input: Object.fromEntries(PAGES.map((page) => [page.entry, `src/prerender/${page.entry}.tsx`])),
      output: { entryFileNames: "[name].js" },
    },
  },
});

try {
  const escape = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const shell = await readFile(resolve(outDir, "index.html"), "utf8");
  for (const page of PAGES) {
    const module = await import(pathToFileURL(resolve(ssrDir, `${page.entry}.js`)).href);
    const markup = module[page.render]();
    for (const required of page.required) {
      if (!markup.includes(required)) throw new Error(`Prerendered ${page.file} is missing: ${required}`);
    }
    const html = shell
      // Static page: no application scripts.
      .replace(/\s*<script\b[^>]*>[\s\S]*?<\/script>/g, "")
      .replace(/\s*<link\b[^>]*rel="modulepreload"[^>]*>/g, "")
      .replace(/<title>[\s\S]*?<\/title>/, `<title>${escape(module[page.title])}</title>`)
      .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${escape(module[page.description])}$2`)
      .replace(/<div id="root"><\/div>/, () => `<div id="root">${markup}</div>`);
    if (!html.includes(markup) || /<script\b/.test(html)) throw new Error(`Could not build ${page.file}`);
    await writeFile(resolve(outDir, page.file), html);
    console.log(`${page.file} written (${Math.round(html.length / 1024)} kB)`);
  }
} finally {
  await rm(ssrDir, { recursive: true, force: true });
}
