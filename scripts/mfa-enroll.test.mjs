// =====================================================
// Tests for scripts/mfa-enroll.mjs (LOCAL STACK ONLY)
//
// Run: npm run test:mfa   (also part of npm run db:test; needs npm run db:start)
//
// Safety:
//   * The target URL comes only from `supabase status` (API_URL) and must be
//     127.0.0.1 / localhost, or the suite stops before any test runs.
//   * The utility itself refuses every non-local URL. In addition, every
//     request goes through guardedFetch, which throws for any non-local host.
//   * No service-role key is used. Test users are created directly in the
//     LOCAL database container with psql, and deleted afterwards.
// =====================================================
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  EXIT, SafeError, parseArgs, validateUrl, validateKey, validateEmail, redact, printable, isLocalHost, run,
  main, restoreTerminal,
} from './mfa-enroll.mjs';

const SCRIPT = fileURLToPath(new URL('./mfa-enroll.mjs', import.meta.url));
const SOURCE = readFileSync(SCRIPT, 'utf8');
const PREFIX = 'mfa-enroll-test-';

// ---------- local stack discovery (never the linked hosted project) ----------

const status = JSON.parse(execSync('npx supabase status -o json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
const API = status.API_URL;
const PUBLISHABLE = status.PUBLISHABLE_KEY;
if (!isLocalHost(new URL(API).hostname)) {
  console.error(`Refusing to run: API_URL ${API} is not the local stack.`);
  process.exit(2);
}
const projectId = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8').match(/^project_id\s*=\s*"([^"]+)"/m)?.[1];
const DB_CONTAINER = `supabase_db_${projectId}`;

let requests = [];
const capturedTokens = new Set();

// Refuses anything except the local stack, and records tokens returned by the
// server so the tests can prove they were never printed. `tamper` lets a
// test alter one response.
let tamper = null;
async function guardedFetch(url, init) {
  const u = new URL(url);
  if (!isLocalHost(u.hostname)) throw new Error(`TEST GUARD: blocked request to non-local host ${u.hostname}`);
  requests.push(`${init?.method ?? 'GET'} ${u.hostname} ${u.pathname}`);
  const res = await fetch(u, init);
  if (tamper) {
    const altered = await tamper(u, init, res);
    if (altered) return altered;
  }
  const text = await res.text();
  try {
    const j = JSON.parse(text);
    for (const k of ['access_token', 'refresh_token']) if (typeof j?.[k] === 'string') capturedTokens.add(j[k]);
  } catch { /* not JSON */ }
  const nullBody = [101, 204, 205, 304].includes(res.status);
  return new Response(nullBody ? null : text, { status: res.status, headers: res.headers });
}

function psql(sql) {
  return execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-tAq'], {
    input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function createUser(tag) {
  const email = `${PREFIX}${tag}-${Date.now()}@example.com`;
  const password = `Local-${randomBytes(12).toString('base64url')}-Aa1!`;
  const id = psql(`
    WITH u AS (
      INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                              raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                              confirmation_token, recovery_token, email_change_token_new, email_change)
      VALUES ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
              '${email}', extensions.crypt('${password}', extensions.gen_salt('bf')), now(),
              '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '')
      RETURNING id, email)
    INSERT INTO auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    SELECT id::text, id, jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true), 'email', now(), now(), now()
    FROM u RETURNING user_id;`);
  return { email, password, id };
}

const factors = (userId) => {
  const rows = psql(`SELECT status, count(*) FROM auth.mfa_factors WHERE user_id = '${userId}' GROUP BY status;`);
  return Object.fromEntries(rows.split('\n').filter(Boolean).map((r) => { const [s, n] = r.split('|'); return [s, Number(n)]; }));
};
const sessions = (userId) => Number(psql(`SELECT count(*) FROM auth.sessions WHERE user_id = '${userId}';`));

// ---------- TOTP (test side only; the utility never computes codes) ----------

function totpAt(base32Secret, step) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of base32Secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  return ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}
const currentStep = () => Math.floor(Date.now() / 30_000);
const lastStep = new Map();

// A valid code whose time step was not used before for this secret (the
// server accepts one step of clock skew either side).
async function freshCode(secret) {
  for (;;) {
    const now = currentStep();
    const used = lastStep.get(secret) ?? -Infinity;
    const step = [now - 1, now, now + 1].find((s) => s > used);
    if (step !== undefined) { lastStep.set(secret, step); return totpAt(secret, step); }
    await new Promise((r) => setTimeout(r, 30_000 - (Date.now() % 30_000) + 200));
  }
}
function wrongCode(secret) {
  const now = currentStep();
  const valid = new Set([now - 1, now, now + 1, now + 2].map((s) => totpAt(secret, s)));
  return ['123456', '654321', '111111'].find((c) => !valid.has(c));
}

// ---------- scripted terminal ----------

function scriptedIO({ url = API, key = PUBLISHABLE, user, codes = [], onCode }) {
  const io = {
    printed: [], shown: [], asked: [], hiddenAsked: 0, secret: null,
    async ask(q) {
      io.asked.push(q);
      if (q.startsWith('Local API URL')) return url;
      if (q.startsWith('Publishable')) return key;
      if (q.startsWith('Your e-mail')) return user.email;
      if (q.startsWith('Which authenticator')) return '1';
      if (q.startsWith('6-digit code')) {
        onCode?.();
        const next = codes.shift();
        if (next === undefined) throw new Error('test script ran out of codes');
        if (next === 'ABORT') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        if (next === 'VALID') return freshCode(user.secret ?? io.secret);
        if (next === 'WRONG') return wrongCode(user.secret ?? io.secret);
        return next;
      }
      throw new Error(`unexpected prompt: ${q}`);
    },
    async askHidden(q) { io.hiddenAsked += 1; io.asked.push(q); return user.password; },
    info(line) { io.printed.push(line); },
    showSecretOnce(lines) {
      io.shown.push(lines);
      io.secret = lines.join('\n').match(/Secret\s*:\s*([A-Z2-7]+)/)?.[1] ?? null;
    },
  };
  return io;
}

async function runLocal(mode, io, opts = {}) {
  requests = [];
  try {
    return await run(mode, io, { fetchImpl: guardedFetch, ...opts });
  } finally {
    tamper = null;
  }
}

function assertNothingSensitivePrinted(io, user, totpSecret) {
  const out = io.printed.join('\n');
  assert.ok(!out.includes(user.password), 'password printed');
  if (totpSecret) assert.ok(!out.includes(totpSecret), 'TOTP secret printed outside the one-time display');
  for (const t of capturedTokens) {
    assert.ok(!out.includes(t), 'access/refresh token printed');
    assert.ok(!io.shown.flat().join('\n').includes(t), 'token in the secret display');
  }
}

const fakeJwt = (claims) => [
  Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
  Buffer.from(JSON.stringify(claims)).toString('base64url'),
  'signature',
].join('.');

const cleanupUsers = () => psql(`DELETE FROM auth.users WHERE email LIKE '${PREFIX}%';`);
before(cleanupUsers);
after(cleanupUsers);

// =====================================================
// Unit tests: no network
// =====================================================

test('URL validation: local stack only, requests always to 127.0.0.1', () => {
  assert.equal(validateUrl('http://127.0.0.1:54321').origin, 'http://127.0.0.1:54321');
  assert.equal(validateUrl(' http://localhost:54321/ ').origin, 'http://127.0.0.1:54321', 'localhost is not resolved via DNS');
  assert.equal(validateUrl('http://LOCALHOST:54321').origin, 'http://127.0.0.1:54321');
  const refused = [
    'https://abcd.supabase.co',            // hosted project
    'http://abcd.supabase.co',
    'https://api.example.com',
    'http://localhost.evil.example',       // look-alike hosts
    'http://127.0.0.1.evil.example',
    'http://evil.example#@127.0.0.1',
    'http://127.0.0.1@evil.example',       // userinfo trick: host is evil.example
    'http://[::1]:54321',                  // only the two named hosts
    'http://0.0.0.0:54321',
    'http://user:pw@127.0.0.1:54321',      // credentials in the URL
    'http://127.0.0.1:54321/auth/v1',      // path
    'http://127.0.0.1:54321/?x=1',         // query
    'ftp://127.0.0.1', 'file:///etc/passwd',
    'not a url', '',
  ];
  for (const u of refused) assert.throws(() => validateUrl(u), SafeError, u);
  assert.throws(() => validateUrl('https://abcd.supabase.co'), /only the local stack/);
  assert.equal(validateUrl.length, 1, 'validateUrl takes no options (no bypass)');
});

test('key validation accepts only publishable / anon keys', () => {
  assert.ok(validateKey('sb_publishable_' + 'A1b2C3d4E5f6'));
  assert.ok(validateKey(fakeJwt({ role: 'anon', iss: 'supabase' })));
  const rejected = [
    'sb_secret_' + 'A1b2C3d4E5f6g7h8',
    'prefix sb_secret_' + 'A1b2C3d4',
    fakeJwt({ role: 'service_role', iss: 'supabase' }),
    fakeJwt({ role: 'authenticated', sub: 'x' }),
    'eyJ.not.ajwt', 'random-string', '',
  ];
  for (const k of rejected) {
    assert.throws(() => validateKey(k), (e) => e instanceof SafeError && !e.message.includes(k || '\0'), 'key rejected without echo');
  }
  assert.throws(() => validateKey('sb_secret_' + 'A1b2C3d4E5f6g7h8'), /secret key/);
  assert.throws(() => validateKey(fakeJwt({ role: 'service_role' })), /service_role/);
});

test('arguments: mode plus required --local; values never echoed', () => {
  assert.deepEqual(parseArgs(['enroll', '--local']), { mode: 'enroll' });
  assert.deepEqual(parseArgs(['--local', 'verify']), { mode: 'verify' });
  assert.deepEqual(parseArgs(['--help']), { help: true });
  assert.throws(() => parseArgs(['enroll']), /--local is required/);
  const bad = [[], ['enroll', '--local', 'hunter2-Secret!'], ['--password=hunter2-Secret!', 'enroll', '--local'],
    ['enroll', 'verify', '--local'], ['enroll', '--local', '--local'], ['enroll', '--local', '--hosted'], ['enroll', '--remote']];
  for (const argv of bad) {
    assert.throws(() => parseArgs(argv), (e) => e.exitCode === EXIT.USAGE && !e.message.includes('hunter2'), argv.join(' '));
  }
});

test('e-mail validation, redaction and printable labels', () => {
  assert.equal(validateEmail('  Staff@Example.COM '), 'staff@example.com');
  assert.throws(() => validateEmail('no-at-sign'), SafeError);
  assert.equal(redact('token=abcdef123 and abcdef123', ['abcdef123']), 'token=[redacted] and [redacted]');
  assert.equal(printable('ok\u001b[2Jname\n'), 'ok?[2Jname?', 'terminal control characters removed');
});

test('source: local-only, no env credentials, no file writes, no service key', () => {
  assert.ok(!/process\.env/.test(SOURCE), 'reads process.env');
  assert.ok(!/from 'node:fs'|require\(['"]fs|writeFile|appendFile|createWriteStream/.test(SOURCE), 'touches the file system');
  assert.ok(!/node:child_process/.test(SOURCE), 'spawns processes');
  assert.ok(!/SERVICE_ROLE_KEY|SECRET_KEY/.test(SOURCE), 'references a service key variable');
  assert.ok(/redirect: 'error'/.test(SOURCE), 'follows redirects');
  assert.ok(!/supabase\.co|Type the host name|localOnly/i.test(SOURCE), 'hosted target or bypass present');
});

test('CLI: rejects arguments, missing --local, piped I/O and missing mode', () => {
  const cli = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input: '' });
  const withSecretArg = cli(['enroll', '--local', '--password', 'hunter2-Secret!']);
  assert.equal(withSecretArg.status, EXIT.USAGE);
  assert.ok(!(withSecretArg.stdout + withSecretArg.stderr).includes('hunter2'), 'argument value echoed');
  const noLocal = cli(['enroll']);
  assert.equal(noLocal.status, EXIT.USAGE);
  assert.match(noLocal.stderr, /--local is required/);
  const piped = cli(['enroll', '--local']);
  assert.equal(piped.status, EXIT.USAGE);
  assert.match(piped.stderr, /interactive terminal/);
  assert.equal(cli([]).status, EXIT.USAGE);
  assert.equal(cli(['--help']).status, EXIT.OK);
});

test('secret scan covers the utility', () => {
  const scanner = fileURLToPath(new URL('./check-secrets.mjs', import.meta.url));
  const scan = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'mfa-scan-'));
    try {
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
      }
      return spawnSync(process.execPath, [scanner], { cwd: dir, encoding: 'utf8' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const utility = join('scripts', 'mfa-enroll.mjs');
  assert.equal(scan({ [utility]: SOURCE }).status, 0, 'the real utility passes');
  assert.match(scan({}).stderr, /expected file was not scanned/);
  assert.match(scan({ [utility]: 'const p = process.env.PASSWORD;' }).stderr, /reads environment variables/);
  assert.match(scan({ [utility]: "import { writeFileSync } from 'node:fs';" }).stderr, /write files/);
  assert.match(scan({ [utility]: 'const k = SERVICE_ROLE_KEY;' }).stderr, /service key variable/);
  assert.match(scan({ [utility]: "const h = 'abcd.supabase.co';" }).stderr, /non-local target/);
  assert.match(scan({ [utility]: "const t = 'https://api.example.com';" }).stderr, /non-local target/);
  const leaked = 'otpauth://totp/PRISIM:a@example.com?' + 'secret=' + 'JBSWY3DPEHPK3PXP'.repeat(2);
  assert.match(scan({ [utility]: SOURCE, 'notes.txt': leaked }).stderr, /TOTP secret/);
});

// =====================================================
// Guards: nothing is sent
// =====================================================

test('guards: refused keys and every non-local URL send nothing', async () => {
  const user = { email: 'x@example.com', password: 'never-sent-Aa1!' };
  const cases = [
    { key: 'sb_secret_' + 'A1b2C3d4E5f6g7h8' },
    { key: fakeJwt({ role: 'service_role' }) },
    { url: 'https://production-guard.example.invalid' },
    { url: 'https://abcd.supabase.co' },
    { url: 'http://127.0.0.1@production-guard.example.invalid' },
  ];
  for (const c of cases) {
    let calls = 0;
    const io = scriptedIO({ ...c, user });
    // A fetch that counts every call, local or not.
    const counting = async () => { calls += 1; throw new Error('no request expected'); };
    assert.equal(await run('enroll', io, { fetchImpl: counting }), EXIT.USAGE);
    assert.equal(calls, 0, 'a request was made');
    assert.equal(io.hiddenAsked, 0, 'password was asked for before the target was validated');
    assert.ok(!io.asked.some((q) => /host name/i.test(q)), 'a confirmation prompt exists');
  }
});

// =====================================================
// Integration: local stack only
// =====================================================

test('local stack: enroll, verify, cleanup and error handling', async (t) => {
  const a = createUser('a');

  await t.test('wrong password: generic error, nothing leaked', async () => {
    const io = scriptedIO({ user: { ...a, password: `${a.password}-wrong` } });
    assert.equal(await runLocal('enroll', io), EXIT.FAILED);
    assert.match(io.printed.join('\n'), /Sign-in failed \[400 invalid_credentials\]/);
    assert.ok(!io.printed.join('\n').includes(a.password));
    assert.equal(sessions(a.id), 0);
  });

  await t.test('unreachable server: generic network error', async () => {
    const io = scriptedIO({ url: 'http://127.0.0.1:9', user: a });
    assert.equal(await runLocal('enroll', io), EXIT.FAILED);
    assert.match(io.printed.join('\n'), /Could not reach the server/);
  });

  await t.test('verify before enrolling: refused, signed out', async () => {
    const io = scriptedIO({ user: a });
    assert.equal(await runLocal('verify', io), EXIT.FAILED);
    assert.match(io.printed.join('\n'), /Run "enroll" first/);
    assert.equal(sessions(a.id), 0);
  });

  await t.test('interrupted enrollment: unverified factor removed', async () => {
    const io = scriptedIO({ user: a, codes: ['ABORT'] });
    assert.equal(await runLocal('enroll', io), EXIT.INTERRUPTED);
    assert.match(io.printed.join('\n'), /Removed the unverified factor/);
    assert.deepEqual(factors(a.id), {});
    assert.equal(sessions(a.id), 0);
  });

  await t.test('leftover unverified factor is removed, then enrollment succeeds', async () => {
    // Simulate a crashed earlier run: an unverified factor left behind.
    const login = await guardedFetch(`${API}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: PUBLISHABLE, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: a.email, password: a.password }),
    }).then((r) => r.json());
    const h = { apikey: PUBLISHABLE, Authorization: `Bearer ${login.access_token}`, 'Content-Type': 'application/json' };
    await guardedFetch(`${API}/auth/v1/factors`, { method: 'POST', headers: h, body: JSON.stringify({ factor_type: 'totp', friendly_name: 'leftover' }) });
    await guardedFetch(`${API}/auth/v1/logout?scope=local`, { method: 'POST', headers: h });
    assert.deepEqual(factors(a.id), { unverified: 1 });

    const io = scriptedIO({ user: a, codes: ['abc', 'VALID'] });
    assert.equal(await runLocal('enroll', io), EXIT.OK);
    const out = io.printed.join('\n');
    assert.match(out, /Removed an unfinished earlier enrollment/);
    assert.match(out, /That is not a 6-digit code/);
    assert.match(out, /Session is aal2/);
    assert.match(out, /is_platform_admin=false, platform_admin_mfa_required=false/);
    assert.match(out, /Signed out/);
    assert.equal(io.shown.length, 1, 'secret shown exactly once');
    assert.match(io.shown[0].join('\n'), /otpauth:\/\/totp\/.*issuer=PRISIM/);
    assert.equal(requests.filter((r) => r.endsWith('/verify')).length, 1, 'malformed code was sent to the server');
    assert.deepEqual(factors(a.id), { verified: 1 });
    assert.equal(sessions(a.id), 0);
    a.secret = io.secret;
    assertNothingSensitivePrinted(io, a, a.secret);
  });

  await t.test('enroll again: refused, no new factor', async () => {
    const io = scriptedIO({ user: a });
    assert.equal(await runLocal('enroll', io), EXIT.FAILED);
    assert.match(io.printed.join('\n'), /already enrolled/);
    assert.deepEqual(factors(a.id), { verified: 1 });
    assert.equal(sessions(a.id), 0);
  });

  await t.test('verify, not a platform admin: aal2 reached, check FAIL', async () => {
    const io = scriptedIO({ user: a, codes: ['VALID'] });
    assert.equal(await runLocal('verify', io), EXIT.NOT_ADMIN);
    assert.match(io.printed.join('\n'), /Platform-admin MFA check: FAIL/);
    assert.equal(sessions(a.id), 0);
    assertNothingSensitivePrinted(io, a, a.secret);
  });

  await t.test('verify, platform admin: aal1 gated, aal2 admin, check PASS', async () => {
    psql(`INSERT INTO public.platform_admins (user_id, note) VALUES ('${a.id}', 'mfa-enroll.test.mjs');`);
    const io = scriptedIO({ user: a, codes: ['VALID'] });
    assert.equal(await runLocal('verify', io), EXIT.OK);
    const out = io.printed.join('\n');
    assert.match(out, /aal1 get_my_context: is_platform_admin=false, platform_admin_mfa_required=true/);
    assert.match(out, /aal2 get_my_context: is_platform_admin=true, platform_admin_mfa_required=false/);
    assert.match(out, /Platform-admin MFA check: PASS/);
    assert.equal(io.shown.length, 0, 'verify mode displayed a secret');
    assert.equal(sessions(a.id), 0);
    assertNothingSensitivePrinted(io, a, a.secret);
  });

  await t.test('verify with wrong codes: 3 attempts, verified factor kept', async () => {
    const io = scriptedIO({ user: a, codes: ['WRONG', 'WRONG', 'WRONG'] });
    assert.equal(await runLocal('verify', io), EXIT.FAILED);
    assert.match(io.printed.join('\n'), /Verification failed after 3 attempts/);
    assert.equal(requests.filter((r) => r.endsWith('/verify')).length, 3);
    assert.deepEqual(factors(a.id), { verified: 1 });
    assert.equal(sessions(a.id), 0);
  });

  await t.test('enroll with wrong codes: 3 attempts, unverified factor removed', async () => {
    const b = createUser('b');
    const io = scriptedIO({ user: b, codes: ['WRONG', 'WRONG', 'WRONG'] });
    assert.equal(await runLocal('enroll', io), EXIT.FAILED);
    const out = io.printed.join('\n');
    assert.match(out, /Verification failed after 3 attempts/);
    assert.match(out, /Removed the unverified factor/);
    assert.deepEqual(factors(b.id), {});
    assert.equal(sessions(b.id), 0);
    assertNothingSensitivePrinted(io, b, io.secret);
  });

  await t.test('Ctrl+C during a request: flow stops before the next request, factor removed', async () => {
    const c = createUser('c');
    const abort = new AbortController();
    // Ctrl+C arrives while the code prompt is open; the challenge must not be sent.
    const io = scriptedIO({ user: c, codes: ['VALID'], onCode: () => abort.abort() });
    assert.equal(await runLocal('enroll', io, { signal: abort.signal }), EXIT.INTERRUPTED);
    assert.equal(requests.filter((r) => r.endsWith('/challenge')).length, 0, 'challenge sent after Ctrl+C');
    assert.match(io.printed.join('\n'), /Interrupted[\s\S]*Removed the unverified factor[\s\S]*Signed out/);
    assert.deepEqual(factors(c.id), {});
    assert.equal(sessions(c.id), 0);
  });

  await t.test('verified factor is kept even if the post-verify check fails', async () => {
    const d = createUser('d');
    // Make the server's successful verify response look like an aal1 session.
    tamper = async (u, init, res) => {
      if (!u.pathname.endsWith('/verify') || res.status !== 200) return null;
      const body = JSON.parse(await res.clone().text());
      body.access_token = fakeJwt({ aal: 'aal1', sub: d.id });
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const io = scriptedIO({ user: d, codes: ['VALID'] });
    assert.equal(await runLocal('enroll', io), EXIT.FAILED);
    const out = io.printed.join('\n');
    assert.match(out, /not aal2 for this account/);
    assert.ok(!/Removed the unverified factor/.test(out), 'cleanup tried to remove a verified factor');
    assert.deepEqual(factors(d.id), { verified: 1 }, 'verified factor was deleted');
    assert.equal(sessions(d.id), 0);
  });

  await t.test('localhost URL: every request goes to 127.0.0.1', async () => {
    const io = scriptedIO({ url: API.replace('127.0.0.1', 'localhost'), user: a });
    assert.equal(await runLocal('enroll', io), EXIT.FAILED); // already enrolled
    assert.ok(requests.length > 0);
    assert.ok(requests.every((r) => r.split(' ')[1] === '127.0.0.1'), requests.join(', '));
  });
});

// =====================================================
// Terminal layer: the real main() with a fake TTY (Node.js 22 regression)
// =====================================================

// A TTY-like input/output pair. Records every setRawMode call so the tests
// can prove the terminal is always put back to normal.
function fakeTerminal({ failRawOnce = false } = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawLog = [];
  let failNext = failRawOnce;
  input.setRawMode = (on) => {
    if (on && failNext) { failNext = false; throw new Error('setRawMode failed (simulated)'); }
    input.isRaw = on;
    input.rawLog.push(on);
    return input;
  };
  let text = '';
  let cursor = 0;
  const waiters = new Set();
  const output = new Writable({
    write(chunk, _enc, cb) { text += chunk.toString(); for (const w of waiters) w(); cb(); },
  });
  output.isTTY = true;
  return {
    input, output,
    get text() { return text; },
    // Resolves with the match once `re` appears after the previous match.
    waitFor(re, ms = 15_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const m = re.exec(text.slice(cursor));
          if (!m) return false;
          cursor += m.index + m[0].length;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(m);
          return true;
        };
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`timed out waiting for ${re}; output:\n${text}`)); }, ms);
        if (!check()) waiters.add(check);
      });
    },
    type(keys) { input.write(keys); },
  };
}

function assertTerminalRestored(term, baseline) {
  assert.equal(term.input.isRaw, false, 'terminal left in raw mode');
  assert.equal(term.input.rawLog.at(-1), false, 'last raw-mode change was not a restore');
  assert.equal(term.input.rawLog.filter(Boolean).length, term.input.rawLog.filter((x) => !x).length, 'raw mode on/off not balanced');
  assert.equal(term.input.listenerCount('data'), 0, 'input listener left attached');
  assert.ok(term.input.isPaused(), 'input left flowing');
  assert.equal(process.listenerCount('SIGINT'), baseline.sigint, 'SIGINT handler left registered');
  assert.equal(process.listenerCount('exit'), baseline.exit, 'exit handler left registered');
}

const startMain = (term, mode, fetchImpl = guardedFetch) => {
  requests = [];
  return main([mode, '--local'], { stdin: term.input, stdout: term.output, stderr: term.output, fetchImpl });
};

async function answerUpToPassword(term, user, url = API) {
  await term.waitFor(/Local API URL[^\n]*: /); term.type(`${url}\r`);
  await term.waitFor(/Publishable \(anon\) key: /); term.type(`${PUBLISHABLE}\r`);
  await term.waitFor(/Your e-mail: /); term.type(`${user.email}\r`);
  await term.waitFor(/Your password \(hidden\): /);
}

test('terminal layer: real main() on this Node.js runtime', async (t) => {
  const baseline = { sigint: process.listenerCount('SIGINT'), exit: process.listenerCount('exit') };
  assert.ok(process.versions.node.startsWith('22.'), `expected Node.js 22, got ${process.versions.node}`);

  await t.test('source uses no private readline APIs', () => {
    assert.ok(!/_writeToOutput|node:readline|\brl\._/.test(SOURCE), 'private or readline internals used');
  });

  await t.test('restoreTerminal resets raw mode and never throws', () => {
    const term = fakeTerminal();
    term.input.setRawMode(true);
    restoreTerminal(term.input);
    assert.equal(term.input.isRaw, false);
    restoreTerminal({ isTTY: true, isRaw: true, setRawMode() { throw new Error('gone'); } });
    restoreTerminal(undefined);
  });

  await t.test('enroll: initialization, hidden password, visible code, success restores terminal', async () => {
    const e = createUser('term-ok');
    const term = fakeTerminal();
    const done = startMain(term, 'enroll');
    await answerUpToPassword(term, e);
    // A typo corrected with Backspace; nothing may be echoed.
    term.type(`${e.password}Z\u007f\r`);
    const [, secret] = await term.waitFor(/Secret\s*:\s*([A-Z2-7]+)/);
    await term.waitFor(/attempt 1\/3\): /);
    const code = await freshCode(secret);
    term.type(`${code}\r`);
    assert.equal(await done, EXIT.OK);

    const out = term.text;
    assert.match(out, /Your password \(hidden\): \nSigned in \(aal1\)/, 'password prompt echoed something');
    assert.ok(!out.includes(e.password), 'password echoed');
    assert.ok(!out.includes('*'), 'asterisks echoed');
    assert.ok(out.includes(`attempt 1/3): ${code}\n`), 'code input not echoed');
    assert.match(out, /Session is aal2[\s\S]*Signed out/);
    assert.equal(out.split(secret).length - 1, 2, 'secret shown more than once (URI + Secret line)');
    assertTerminalRestored(term, baseline);
    assert.deepEqual(factors(e.id), { verified: 1 });
    assert.equal(sessions(e.id), 0);
  });

  await t.test('Ctrl+C during password input: exit 130, nothing sent', async () => {
    const term = fakeTerminal();
    const done = startMain(term, 'enroll');
    await answerUpToPassword(term, { email: `${PREFIX}nobody@example.com` });
    term.type('abc\u0003');
    assert.equal(await done, EXIT.INTERRUPTED);
    assert.equal(requests.length, 0, 'a request was made');
    assert.ok(!term.text.includes('abc'), 'partial password echoed');
    assert.match(term.text, /Interrupted\./);
    assertTerminalRestored(term, baseline);
  });

  await t.test('Ctrl+C during TOTP input: exit 130, factor removed, signed out', async () => {
    const g = createUser('term-int');
    const term = fakeTerminal();
    const done = startMain(term, 'enroll');
    await answerUpToPassword(term, g);
    term.type(`${g.password}\r`);
    await term.waitFor(/attempt 1\/3\): /);
    term.type('12\u0003');
    assert.equal(await done, EXIT.INTERRUPTED);
    assert.match(term.text, /Interrupted\.[\s\S]*Removed the unverified factor\.[\s\S]*Signed out\./);
    assert.equal(requests.filter((r) => r.endsWith('/challenge')).length, 0);
    assertTerminalRestored(term, baseline);
    assert.deepEqual(factors(g.id), {});
    assert.equal(sessions(g.id), 0);
  });

  await t.test('Ctrl+C while a request is running (SIGINT): stops, cleans up', async () => {
    const h = createUser('term-sig');
    const term = fakeTerminal();
    // Ctrl+C arrives (as SIGINT, raw mode off) while the factor is being created.
    const fetchWithSigint = (url, init) => {
      const u = new URL(url);
      if (init?.method === 'POST' && u.pathname === '/auth/v1/factors') process.emit('SIGINT');
      return guardedFetch(url, init);
    };
    const done = startMain(term, 'enroll', fetchWithSigint);
    await answerUpToPassword(term, h);
    term.type(`${h.password}\r`);
    assert.equal(await done, EXIT.INTERRUPTED);
    assert.match(term.text, /Interrupted\.[\s\S]*Removed the unverified factor\.[\s\S]*Signed out\./);
    assertTerminalRestored(term, baseline);
    assert.deepEqual(factors(h.id), {});
    assert.equal(sessions(h.id), 0);
  });

  await t.test('errors restore the terminal: wrong password, unreachable server, raw-mode failure', async () => {
    const w = createUser('term-err');

    const wrong = fakeTerminal();
    const d1 = startMain(wrong, 'enroll');
    await answerUpToPassword(wrong, w);
    wrong.type('not-the-password\r');
    assert.equal(await d1, EXIT.FAILED);
    assert.match(wrong.text, /Sign-in failed/);
    assertTerminalRestored(wrong, baseline);

    const down = fakeTerminal();
    const d2 = startMain(down, 'enroll');
    await answerUpToPassword(down, w, 'http://127.0.0.1:9');
    down.type(`${w.password}\r`);
    assert.equal(await d2, EXIT.FAILED);
    assert.match(down.text, /Could not reach the server/);
    assertTerminalRestored(down, baseline);

    const broken = fakeTerminal({ failRawOnce: true });
    const d3 = startMain(broken, 'enroll');
    assert.equal(await d3, EXIT.FAILED);
    assert.match(broken.text, /unexpected failure/);
    assert.equal(broken.input.isRaw, false);
    assert.equal(broken.input.listenerCount('data'), 0);
    assert.equal(sessions(w.id), 0);
  });

  await t.test('non-TTY input or output is refused before any prompt', async () => {
    const term = fakeTerminal();
    term.input.isTTY = false;
    assert.equal(await startMain(term, 'enroll'), EXIT.USAGE);
    assert.match(term.text, /interactive terminal/);
    assert.equal(term.input.rawLog.length, 0, 'raw mode touched');
  });
});
