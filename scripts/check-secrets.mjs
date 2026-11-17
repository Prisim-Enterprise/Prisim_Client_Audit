// =====================================================
// Secret boundary check
//
// Fails if a Supabase service_role / secret key could reach the browser or
// git:
//   * any `sb_secret_...` key or service_role JWT anywhere in the working tree
//     (tracked or not, including frontend/.env* and a built frontend/dist)
//   * any frontend VITE_* variable whose name suggests a secret
//   * any TOTP secret (otpauth:// URI with a secret) anywhere in the tree
//   * the MFA bootstrap utility (scripts/mfa-enroll.mjs) reading environment
//     variables, writing files, spawning processes, naming a service key or
//     containing any non-local URL / hosted Supabase domain
//
// Run: npm run check:secrets   (also part of npm run db:test)
// =====================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = process.cwd();
const skipDirs = new Set(['node_modules', '.git', '.temp', 'backups']);
const textExt = /\.(m?[jt]sx?|json|toml|ya?ml|sql|md|html|css|env|txt|example|local|production|development)$|(^|[\\/])\.env[^\\/]*$/i;

const findings = [];
const scanned = new Set();

// Files that must exist and be scanned, with extra rules for each.
const required = {
  [join('scripts', 'mfa-enroll.mjs')]: [
    [/process\.env/,'reads environment variables (credentials must only be prompted for)'],
    [/node:fs|node:child_process|writeFile|appendFile|createWriteStream/, 'can write files or spawn processes'],
    [/SERVICE_ROLE_KEY|SECRET_KEY|service_role_key/i, 'names a service key variable'],
    // Local-only by design: no hosted domain or other non-local URL may appear.
    [/supabase\.(co|com|in)\b|https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])[a-z0-9-]+\.[a-z0-9.-]+/i, 'contains a non-local target (the utility must stay local-only)'],
  ],
};

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
  scanned.add(rel);
  for (const m of text.matchAll(/sb_secret_[A-Za-z0-9_-]{8,}/g)) {
    findings.push(`${rel}: Supabase secret key (${m[0].slice(0, 14)}...)`);
  }
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
    if (jwtRole(m[0]) === 'service_role') findings.push(`${rel}: service_role JWT`);
  }
  for (const m of text.matchAll(/otpauth:\/\/[^\s'"`]*[?&]secret=[A-Z2-7]{16,}/gi)) {
    findings.push(`${rel}: TOTP secret (${m[0].slice(0, 16)}...)`);
  }
  for (const [pattern, problem] of required[rel] ?? []) {
    if (pattern.test(text)) findings.push(`${rel}: ${problem}`);
  }
  if (rel.split(sep)[0] === 'frontend') {
    for (const m of text.matchAll(/\bVITE_[A-Z0-9_]*(SERVICE|SECRET|PRIVATE|PASSWORD|DB_URL)[A-Z0-9_]*/g)) {
      findings.push(`${rel}: frontend variable ${m[0]} looks like a secret (VITE_* is bundled into the browser)`);
    }
  }
}

walk(root);

for (const rel of Object.keys(required)) {
  if (!scanned.has(rel)) findings.push(`${rel}: expected file was not scanned (missing or renamed)`);
}

if (findings.length) {
  console.error('Secret boundary check FAILED:');
  for (const f of findings) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('Secret boundary check passed: no service keys in the working tree or frontend.');
