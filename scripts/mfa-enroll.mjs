// =====================================================
// Temporary MFA (TOTP) bootstrap utility for PRISIM staff (LOCAL STACK ONLY)
//
// Design: docs/deployment-checklist.md, Appendix A. Remove this script once
// the frontend has its own MFA enrollment and step-up screen.
//
//   node scripts/mfa-enroll.mjs enroll --local   enroll a TOTP factor
//   node scripts/mfa-enroll.mjs verify --local   prove aal2 + admin state
//
// Hard limits (no flag, prompt or environment variable changes them):
//   * only http(s)://127.0.0.1 or http(s)://localhost is accepted, and every
//     request goes to 127.0.0.1; any other host is refused before anything is
//     sent
//   * --local must be given explicitly
//   * credentials are prompted for, never read from arguments or environment
//     variables; the password prompt is hidden
//   * only a publishable / anon key is accepted
//   * nothing is written to disk; redirects are refused
// Node.js 22 built-ins only.
// =====================================================
import { pathToFileURL } from 'node:url';

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, NOT_ADMIN: 3, INTERRUPTED: 130 });

const MAX_CODE_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const ISSUER = 'PRISIM Client Audit';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const REQUEST_HOST = '127.0.0.1'; // "localhost" is never resolved through DNS / hosts file
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = `Usage: node scripts/mfa-enroll.mjs <enroll|verify> --local

  enroll   Sign in, enroll a TOTP authenticator, and confirm an aal2 session.
  verify   Sign in, step up with an existing TOTP factor, and report the
           platform-admin state.
  --local  Required. The utility works only against the local Supabase stack
           (http://127.0.0.1:54321 by default) and refuses every other host.

All inputs are prompted for. Credentials are never accepted as arguments or
environment variables.`;

// An error whose message is safe to show: it never contains a credential,
// token, TOTP secret or raw server response.
export class SafeError extends Error {
  constructor(message, exitCode = EXIT.FAILED) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------- argument and input validation ----------

export function parseArgs(argv) {
  let mode = null;
  let local = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--local' && !local) { local = true; continue; }
    if ((arg === 'enroll' || arg === 'verify') && mode === null) { mode = arg; continue; }
    // Never echo the value: it might be a password typed in the wrong place.
    throw new SafeError(
      `Unexpected argument #${i + 1} (value not shown). Credentials are never accepted as arguments.\n\n${USAGE}`,
      EXIT.USAGE,
    );
  }
  if (!mode) throw new SafeError(USAGE, EXIT.USAGE);
  if (!local) throw new SafeError(`--local is required: this utility works only against the local stack.\n\n${USAGE}`, EXIT.USAGE);
  return { mode };
}

export function isLocalHost(hostname) {
  return LOCAL_HOSTS.has(String(hostname).toLowerCase());
}

// Accepts only a bare local origin and returns the origin every request is
// sent to (always 127.0.0.1, same port and scheme).
export function validateUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    throw new SafeError('The API URL is not a valid URL.', EXIT.USAGE);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeError('The API URL must start with http://.', EXIT.USAGE);
  }
  if (!isLocalHost(url.hostname)) {
    throw new SafeError('Refused: only the local stack (127.0.0.1 or localhost) is allowed. Nothing was sent.', EXIT.USAGE);
  }
  if (url.username || url.password) {
    throw new SafeError('The API URL must not contain a user name or password.', EXIT.USAGE);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new SafeError('Enter only the API URL (for example http://127.0.0.1:54321), without a path.', EXIT.USAGE);
  }
  const origin = `${url.protocol}//${REQUEST_HOST}${url.port ? `:${url.port}` : ''}`;
  return { origin };
}

export function jwtPayload(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

// Accepts only a publishable key or an anon JWT. Never echoes the key.
export function validateKey(input) {
  const key = String(input ?? '').trim();
  if (!key) throw new SafeError('The publishable key is empty.', EXIT.USAGE);
  if (/sb_secret_/i.test(key)) {
    throw new SafeError('Refused: that is a secret key. Use the publishable (or anon) key. Nothing was sent.', EXIT.USAGE);
  }
  if (/^sb_publishable_[A-Za-z0-9_-]{8,}$/.test(key)) return key;
  const claims = jwtPayload(key);
  if (claims?.role === 'service_role') {
    throw new SafeError('Refused: that is a service_role key. Use the publishable (or anon) key. Nothing was sent.', EXIT.USAGE);
  }
  if (claims?.role === 'anon') return key;
  throw new SafeError('Not a publishable key (expected sb_publishable_... or the legacy anon key). Nothing was sent.', EXIT.USAGE);
}

export function validateEmail(input) {
  const email = String(input ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new SafeError('That does not look like an e-mail address.', EXIT.USAGE);
  }
  return email;
}

// Defence in depth: removes known sensitive values from any text before it is
// shown. Normal output never contains them in the first place.
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 6) out = out.split(s).join('[redacted]');
  }
  return out;
}

// Server-supplied labels are shown as plain printable text only (no terminal
// control sequences).
export function printable(text, max = 60) {
  return String(text ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, max);
}

// ---------- Auth / PostgREST client ----------

function errorCode(res) {
  const code = res.json?.error_code ?? res.json?.code;
  return typeof code === 'string' && /^[a-z0-9_]{1,64}$/i.test(code) ? ` [${res.status} ${code}]` : ` [${res.status}]`;
}

function makeApi(origin, apikey, fetchImpl, signal) {
  return async function request(path, { method = 'GET', token, body, cleanup = false } = {}) {
    // Ctrl+C stops the flow before the next request; cleanup still runs.
    if (!cleanup && signal?.aborted) {
      const e = new Error('interrupted');
      e.name = 'AbortError';
      throw e;
    }
    const url = new URL(path, origin);
    if (url.hostname !== REQUEST_HOST || url.origin !== origin) {
      throw new SafeError('Internal check failed: request target is not the local stack. Nothing was sent.');
    }
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: {
          apikey,
          Authorization: `Bearer ${token ?? apikey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', // never follow a redirect with credentials attached
        signal: AbortSignal.timeout(cleanup ? CLEANUP_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof SafeError) throw err;
      throw new SafeError(err?.name === 'TimeoutError'
        ? 'The server did not respond in time.'
        : 'Could not reach the server (is `npm run db:start` running?), or a redirect was refused.');
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json };
  };
}

// ---------- the flow ----------

export async function run(mode, io, { fetchImpl = globalThis.fetch, signal, now = () => new Date() } = {}) {
  const secrets = new Set();
  const say = (line = '') => io.info(redact(line, secrets));
  const state = { token: null, userId: null, pendingFactorId: null };
  let request = null;
  let exitCode = EXIT.FAILED;

  try {
    if (mode !== 'enroll' && mode !== 'verify') throw new SafeError(USAGE, EXIT.USAGE);

    // 1. Target and key are validated before any credential is asked for.
    const target = validateUrl(await io.ask('Local API URL (http://127.0.0.1:54321): '));
    const apikey = validateKey(await io.ask('Publishable (anon) key: '));
    request = makeApi(target.origin, apikey, fetchImpl, signal);

    const email = validateEmail(await io.ask('Your e-mail: '));
    let password = await io.askHidden('Your password (hidden): ');
    if (!password) throw new SafeError('The password is empty.', EXIT.USAGE);
    secrets.add(password);

    // 2. Password sign-in: aal1 session.
    const login = await request('/auth/v1/token?grant_type=password', {
      method: 'POST', body: { email, password },
    });
    password = null; // no longer needed
    if (login.status !== 200 || typeof login.json?.access_token !== 'string') {
      throw new SafeError(`Sign-in failed${errorCode(login)}. Check the e-mail and password; the address must be confirmed.`);
    }
    state.token = login.json.access_token;
    secrets.add(state.token);
    if (typeof login.json.refresh_token === 'string') secrets.add(login.json.refresh_token);
    state.userId = jwtPayload(state.token)?.sub ?? null;
    if (!state.userId) throw new SafeError('The sign-in response was not a valid session.');
    say(`Signed in (aal1) to ${target.origin}.`);

    const totpFactors = await listTotpFactors(request, state.token);
    const verified = totpFactors.filter((f) => f.status === 'verified');

    if (mode === 'enroll') {
      exitCode = await enroll({ request, io, say, secrets, state, totpFactors, verified, now });
    } else {
      exitCode = await verifyMode({ request, io, say, secrets, state, verified });
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      say('Interrupted.');
      exitCode = EXIT.INTERRUPTED;
    } else if (err instanceof SafeError) {
      say(`Error: ${err.message}`);
      exitCode = err.exitCode;
    } else {
      say('Error: unexpected failure (details hidden to avoid printing secrets).');
      exitCode = EXIT.FAILED;
    }
  } finally {
    await cleanup({ request, say, state });
    secrets.clear();
  }
  return exitCode;
}

async function listTotpFactors(request, token, opts = {}) {
  const user = await request('/auth/v1/user', { token, ...opts });
  if (user.status !== 200) throw new SafeError(`Could not read your account${errorCode(user)}.`);
  return (user.json?.factors ?? []).filter((f) => f?.factor_type === 'totp' && UUID_RE.test(f?.id ?? ''));
}

async function enroll({ request, io, say, secrets, state, totpFactors, verified, now }) {
  if (verified.length > 0) {
    throw new SafeError('A verified authenticator is already enrolled for this account. Use "verify" mode.');
  }
  // Leftovers from an earlier, interrupted attempt (never verified ones).
  for (const f of totpFactors.filter((x) => x.status === 'unverified')) {
    const del = await request(`/auth/v1/factors/${f.id}`, { method: 'DELETE', token: state.token });
    if (del.status !== 200) throw new SafeError(`Could not remove an unfinished earlier enrollment${errorCode(del)}.`);
    say('Removed an unfinished earlier enrollment.');
  }

  const stamp = now().toISOString().slice(0, 16).replace('T', ' ');
  const created = await request('/auth/v1/factors', {
    method: 'POST',
    token: state.token,
    body: { factor_type: 'totp', friendly_name: `PRISIM admin ${stamp} UTC`, issuer: ISSUER },
  });
  const factorId = created.json?.id;
  const secret = created.json?.totp?.secret;
  const uri = created.json?.totp?.uri;
  if (created.status !== 200 || !UUID_RE.test(factorId ?? '') || typeof secret !== 'string' || typeof uri !== 'string') {
    throw new SafeError(`Could not create the TOTP factor${errorCode(created)}.`);
  }
  state.pendingFactorId = factorId;
  secrets.add(secret);
  secrets.add(uri);

  io.showSecretOnce([
    'Add this account to your authenticator app now. It is shown only once.',
    `  otpauth URI : ${uri}`,
    `  Secret      : ${secret}`,
    'Clear your terminal and its scrollback when you have finished.',
  ]);

  const token = await stepUp({ request, io, say, secrets, state, factorId });
  if (!token) {
    throw new SafeError(`Verification failed after ${MAX_CODE_ATTEMPTS} attempts. The unfinished factor is removed; run enroll again.`);
  }
  say('Authenticator verified. Session is aal2.');

  const ctx = await myContext(request, token);
  say(`get_my_context: is_platform_admin=${ctx.is_platform_admin}, platform_admin_mfa_required=${ctx.platform_admin_mfa_required}`);
  if (!ctx.is_platform_admin) say('Not a platform admin. Expected unless this local user is in public.platform_admins.');
  return EXIT.OK;
}

async function verifyMode({ request, io, say, secrets, state, verified }) {
  if (verified.length === 0) {
    throw new SafeError('No verified authenticator is enrolled for this account. Run "enroll" first.');
  }
  const before = await myContext(request, state.token);
  say(`aal1 get_my_context: is_platform_admin=${before.is_platform_admin}, platform_admin_mfa_required=${before.platform_admin_mfa_required}`);

  let factor = verified[0];
  if (verified.length > 1) {
    verified.forEach((f, i) => say(`  ${i + 1}. ${printable(f.friendly_name ?? 'TOTP')}`));
    const choice = Number.parseInt((await io.ask(`Which authenticator? [1-${verified.length}]: `)).trim(), 10);
    if (!(choice >= 1 && choice <= verified.length)) throw new SafeError('Invalid choice.', EXIT.USAGE);
    factor = verified[choice - 1];
  }

  const token = await stepUp({ request, io, say, secrets, state, factorId: factor.id });
  if (!token) throw new SafeError(`Verification failed after ${MAX_CODE_ATTEMPTS} attempts.`);
  say('Code accepted. Session is aal2.');

  const after = await myContext(request, token);
  say(`aal2 get_my_context: is_platform_admin=${after.is_platform_admin}, platform_admin_mfa_required=${after.platform_admin_mfa_required}`);

  const pass = before.is_platform_admin === false && before.platform_admin_mfa_required === true && after.is_platform_admin === true;
  if (pass) {
    say('Platform-admin MFA check: PASS (no admin access at aal1, admin access at aal2).');
    return EXIT.OK;
  }
  say('Platform-admin MFA check: FAIL. This account is not an active platform admin.');
  return EXIT.NOT_ADMIN;
}

// Challenge + verify with a code typed by the user. Returns the aal2 access
// token, or null after MAX_CODE_ATTEMPTS failures.
async function stepUp({ request, io, say, secrets, state, factorId }) {
  for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = String(await io.ask(`6-digit code from your authenticator app (attempt ${attempt}/${MAX_CODE_ATTEMPTS}): `)).trim();
    if (!/^\d{6}$/.test(code)) {
      say('That is not a 6-digit code.');
      continue;
    }
    const challenge = await request(`/auth/v1/factors/${factorId}/challenge`, { method: 'POST', token: state.token, body: {} });
    if (challenge.status !== 200 || !UUID_RE.test(challenge.json?.id ?? '')) {
      throw new SafeError(`Could not start an MFA challenge${errorCode(challenge)}.`);
    }
    const result = await request(`/auth/v1/factors/${factorId}/verify`, {
      method: 'POST', token: state.token, body: { challenge_id: challenge.json.id, code },
    });
    if (result.status === 200) {
      // The server has verified the factor: from here on it must never be
      // deleted by cleanup, whatever happens next.
      if (state.pendingFactorId === factorId) state.pendingFactorId = null;
      const next = result.json?.access_token;
      if (typeof next !== 'string') throw new SafeError('Verification succeeded but returned no session.');
      secrets.add(next);
      if (typeof result.json?.refresh_token === 'string') secrets.add(result.json.refresh_token);
      const claims = jwtPayload(next);
      if (claims?.aal !== 'aal2' || claims?.sub !== state.userId) {
        throw new SafeError('Verification returned a session that is not aal2 for this account.');
      }
      state.token = next; // same session, now aal2
      return next;
    }
    if (result.status === 429) throw new SafeError(`Too many attempts${errorCode(result)}. Wait a few minutes and try again.`);
    say(`Code not accepted${errorCode(result)}.`);
  }
  return null;
}

async function myContext(request, token) {
  const res = await request('/rest/v1/rpc/get_my_context', { method: 'POST', token, body: {} });
  const ctx = res.json;
  if (res.status !== 200 || typeof ctx?.is_platform_admin !== 'boolean' || typeof ctx?.platform_admin_mfa_required !== 'boolean') {
    throw new SafeError(`get_my_context failed${errorCode(res)}. Is migration 0002 applied locally?`);
  }
  return { is_platform_admin: ctx.is_platform_admin, platform_admin_mfa_required: ctx.platform_admin_mfa_required };
}

// Removes the factor this run created if it is still unverified, then signs
// out this session only. Never throws, and never deletes a verified factor.
async function cleanup({ request, say, state }) {
  if (!request || !state.token) return;
  if (state.pendingFactorId) {
    try {
      const current = (await listTotpFactors(request, state.token, { cleanup: true }))
        .find((f) => f.id === state.pendingFactorId);
      if (!current) {
        say('The unverified factor is already gone.');
      } else if (current.status !== 'unverified') {
        say('The new factor is verified, so it was kept.');
      } else {
        const del = await request(`/auth/v1/factors/${current.id}`, { method: 'DELETE', token: state.token, cleanup: true });
        say(del.status === 200
          ? 'Removed the unverified factor.'
          : `Could not remove the unverified factor${errorCode(del)}. Running enroll again removes it.`);
      }
    } catch {
      say('Could not remove the unverified factor. Running enroll again removes it.');
    }
  }
  try {
    const out = await request('/auth/v1/logout?scope=local', { method: 'POST', token: state.token, cleanup: true });
    say(out.status === 204 || out.status === 200
      ? 'Signed out.'
      : `Sign-out failed${errorCode(out)}. The session expires with its access token.`);
  } catch {
    say('Sign-out failed. The session expires with its access token.');
  }
  state.token = null;
  state.userId = null;
  state.pendingFactorId = null;
}

// ---------- terminal I/O ----------
//
// A minimal line reader on public Node.js APIs only (tty raw mode + 'data'
// events). Raw mode is on only while a prompt is being read and is restored in
// every outcome: Enter, Ctrl+C, Ctrl+D, abort or error.

const MAX_INPUT_LENGTH = 1024;

const abortError = () => {
  const e = new Error('interrupted');
  e.name = 'AbortError';
  return e;
};

// Puts the input back to cooked mode. Safe to call at any time, any number of
// times; never throws.
export function restoreTerminal(input) {
  try {
    if (input?.isTTY && input.isRaw) input.setRawMode(false);
  } catch { /* the terminal is already gone */ }
  try { input?.pause?.(); } catch { /* ignore */ }
}

export function createTerminalIO({ input, output, signal, onInterrupt }) {
  let reading = false;

  function readLine(prompt, { hidden }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      if (reading) { reject(new Error('A prompt is already open.')); return; }
      reading = true;

      let value = '';
      let escape = 0; // 0 = none, 1 = after ESC, 2 = inside an escape sequence
      let done = false;

      const finish = (err) => {
        if (done) return;
        done = true;
        input.removeListener('data', onData);
        signal?.removeEventListener('abort', onAbort);
        restoreTerminal(input);
        reading = false;
        output.write('\n');
        const result = value;
        value = '';
        if (err) reject(err); else resolve(result);
      };
      const interrupt = () => { finish(abortError()); onInterrupt?.(); };
      const onAbort = () => finish(abortError());

      function onData(chunk) {
        for (const ch of String(chunk)) {
          if (done) return;
          if (escape === 1) { escape = (ch === '[' || ch === 'O') ? 2 : 0; continue; }
          if (escape === 2) { if (/[A-Za-z~]/.test(ch)) escape = 0; continue; }
          if (ch === '\u001b') { escape = 1; continue; }        // arrow keys etc.: ignored
          if (ch === '\u0003') { interrupt(); return; }           // Ctrl+C
          if (ch === '\u0004') { if (!value) { interrupt(); return; } continue; } // Ctrl+D
          if (ch === '\r' || ch === '\n') { finish(null); return; }
          if (ch === '\u007f' || ch === '\b') {                   // Backspace
            if (value) {
              value = Array.from(value).slice(0, -1).join('');
              if (!hidden) output.write('\b \b');
            }
            continue;
          }
          if (ch < ' ') continue;                                 // other control keys
          if (value.length >= MAX_INPUT_LENGTH) continue;
          value += ch;
          if (!hidden) output.write(ch);                          // hidden: nothing, not even '*'
        }
      }

      try {
        output.write(prompt);
        input.setEncoding('utf8');
        input.setRawMode(true);
        input.on('data', onData);
        signal?.addEventListener('abort', onAbort, { once: true });
        input.resume();
      } catch (err) {
        finish(err);
      }
    });
  }

  return {
    ask: (q) => readLine(q, { hidden: false }),
    askHidden: (q) => readLine(q, { hidden: true }),
    info: (line) => output.write(`${line}\n`),
    showSecretOnce: (lines) => output.write(`\n${lines.join('\n')}\n\n`),
    close: () => restoreTerminal(input),
  };
}

export async function main(argv, {
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  fetchImpl = globalThis.fetch,
} = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return err.exitCode ?? EXIT.USAGE;
  }
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }
  // Refuse piped input (passwords from files or history) and redirected
  // output (TOTP secret written to a file or log).
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
    stderr.write('Refused: run this in an interactive terminal. Input and output must not be piped or redirected.\n');
    return EXIT.USAGE;
  }

  const abort = new AbortController();
  let interrupts = 0;
  const interrupted = () => {
    interrupts += 1;
    if (interrupts === 1) {
      abort.abort();
    } else {
      // Second Ctrl+C while cleaning up: let a third one end the process.
      process.removeListener('SIGINT', interrupted);
      stderr.write('\nCleaning up (removing any unverified factor, signing out). Press Ctrl+C again to quit without cleanup.\n');
    }
  };
  // Ctrl+C while no prompt is open (raw mode off) arrives as SIGINT.
  process.on('SIGINT', interrupted);
  // Last line of defence: never leave the terminal in raw mode.
  const onExit = () => restoreTerminal(stdin);
  process.on('exit', onExit);

  const io = createTerminalIO({ input: stdin, output: stdout, signal: abort.signal, onInterrupt: interrupted });
  try {
    return await run(args.mode, io, { fetchImpl, signal: abort.signal });
  } finally {
    io.close();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('exit', onExit);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
