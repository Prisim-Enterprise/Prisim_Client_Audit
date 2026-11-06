// =====================================================
// Secret boundary check
//
// Fails if a Supabase service_role / secret key could reach the browser or
// git:
//   * any `sb_secret_...` key or service_role JWT anywhere in the working tree
//     (tracked or not, including frontend/.env* and a built frontend/dist)
//   * any frontend VITE_* variable whose name suggests a secret
//
// Run: npm run check:secrets   (also part of npm run db:test)
// =====================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const skipDirs = new Set(['node_modules', '.git', '.temp', 'backups']);
const textExt = /\.(m?[jt]sx?|json|toml|ya?ml|sql|md|html|css|env|txt|example|local|production|development)$|(^|[\\/])\.env[^\\/]*$/i;

const findings = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) { walk(path); continue; }
    if (st.size > 5 * 1024 * 1024 || !textExt.test(path)) continue;
    scan(path, readFileSync(path, 'utf8'));
  }
}

function jwtRole(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).role;
  } catch {
    return undefined;
  }
}

function scan(path, text) {
  const rel = relative(root, path);
  for (const m of text.matchAll(/sb_secret_[A-Za-z0-9_-]{8,}/g)) {
    findings.push(`${rel}: Supabase secret key (${m[0].slice(0, 14)}...)`);
  }
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
    if (jwtRole(m[0]) === 'service_role') findings.push(`${rel}: service_role JWT`);
  }
  if (rel.split(sep)[0] === 'frontend') {
    for (const m of text.matchAll(/\bVITE_[A-Z0-9_]*(SERVICE|SECRET|PRIVATE|PASSWORD|DB_URL)[A-Z0-9_]*/g)) {
      findings.push(`${rel}: frontend variable ${m[0]} looks like a secret (VITE_* is bundled into the browser)`);
    }
  }
}

walk(root);

if (findings.length) {
  console.error('Secret boundary check FAILED:');
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('Secret boundary check passed: no service keys in the working tree or frontend.');
