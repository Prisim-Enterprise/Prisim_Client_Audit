// =====================================================
// Auth API integration test (LOCAL STACK ONLY)
//
// Creates a user through the real GoTrue Admin API (so the profile trigger
// fires as supabase_auth_admin, not as postgres), signs in to obtain a real
// JWT, and checks what that JWT can do through PostgREST.
//
// Run: npm run db:test:auth   (requires `npm run db:start`)
// Keys are read at runtime from `supabase status` (local demo keys only).
// The script refuses to run against anything other than localhost.
// =====================================================
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';

const status = JSON.parse(
  execSync('npx supabase status -o json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
);
const API = status.API_URL;
const ANON = status.ANON_KEY;
const SERVICE = status.SERVICE_ROLE_KEY;

const host = new URL(API).hostname;
if (!['127.0.0.1', 'localhost'].includes(host)) {
  console.error(`Refusing to run: API_URL ${API} is not the local stack.`);
  process.exit(2);
}

let passed = 0;
let failed = 0;
function check(condition, name, detail) {
  if (condition) {
    passed += 1;
    console.log(`ok ${passed + failed} - ${name}`);
  } else {
    failed += 1;
    console.log(`not ok ${passed + failed} - ${name}${detail ? `\n#   ${JSON.stringify(detail)}` : ''}`);
  }
}

async function call(path, { method = 'GET', key = ANON, token = key, body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the local MFA test.
function totp(base32Secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of base32Secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

const jwtClaims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

const stamp = Date.now();
const email = `Auth.Api.${stamp}@Example.com`;
const password = `Local-only-${stamp}-Aa1!`;
let userId = null;

try {
  // 1. Public sign-up is disabled.
  const signup = await call('/auth/v1/signup', {
    method: 'POST',
    body: { email: `self.signup.${stamp}@example.com`, password },
  });
  check(signup.status >= 400, 'public sign-up is rejected', signup);

  // 2. Create a user through the Admin API, with hostile metadata.
  const created = await call('/auth/v1/admin/users', {
    method: 'POST',
    key: SERVICE,
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: '  Auth API Tester  ', role: 'owner', is_platform_admin: true },
      app_metadata: { role: 'owner' },
    },
  });
  userId = created.json?.id;
  check(created.status === 200 && userId, 'Admin API creates the user', created);

  // 3. The profile trigger ran under the Auth service role.
  const profile = await call(`/rest/v1/profiles?id=eq.${userId}&select=id,email,full_name`, { key: SERVICE });
  check(profile.json?.length === 1, 'profile row created by trigger for an Auth API user', profile);
  check(profile.json?.[0]?.email === email.toLowerCase(), 'profile e-mail copied from auth.users', profile.json);
  check(profile.json?.[0]?.full_name === 'Auth API Tester', 'only full_name is taken from metadata (trimmed)', profile.json);

  const audit = await call(
    `/rest/v1/audit_logs?entity_id=eq.${userId}&action=eq.profiles.insert&select=action,actor_role`,
    { key: SERVICE }
  );
  check(audit.json?.length === 1, 'profile creation is audited', audit);

  // 4. Sign in with a password: a real aal1 JWT.
  const login = await call('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
  const jwt = login.json?.access_token;
  check(login.status === 200 && jwt, 'password sign-in returns a JWT', login.status);
  const claims = jwt ? jwtClaims(jwt) : {};
  check(claims.aal === 'aal1', 'password-only session is aal1', claims.aal);

  // 5. Metadata grants nothing.
  const ctx = await call('/rest/v1/rpc/get_my_context', { method: 'POST', token: jwt, body: {} });
  check(ctx.status === 200 && ctx.json?.user_id === userId, 'get_my_context works with a real JWT', ctx);
  check(ctx.json?.is_platform_admin === false, 'user_metadata cannot make a platform admin', ctx.json);
  check(Array.isArray(ctx.json?.memberships) && ctx.json.memberships.length === 0, 'user_metadata grants no memberships', ctx.json);

  const tenants = await call('/rest/v1/tenants?select=id', { token: jwt });
  check(tenants.status === 200 && tenants.json?.length === 0, 'new user sees no tenants', tenants);

  const ownProfile = await call('/rest/v1/profiles?select=id', { token: jwt });
  check(ownProfile.json?.length === 1 && ownProfile.json[0].id === userId, 'user sees only own profile', ownProfile);

  const emailEdit = await call(`/rest/v1/profiles?id=eq.${userId}`, {
    method: 'PATCH', token: jwt, body: { email: 'evil@example.com' },
  });
  check(emailEdit.status >= 400, 'user cannot change profile e-mail through the API', emailEdit);

  const selfAdmin = await call('/rest/v1/platform_admins', {
    method: 'POST', token: jwt, body: { user_id: userId },
  });
  check(selfAdmin.status >= 400, 'user cannot insert self into platform_admins', selfAdmin);

  const tokenRpc = await call('/rest/v1/rpc/get_oauth_tokens', {
    method: 'POST', token: jwt, body: { p_connection_id: userId },
  });
  check(tokenRpc.status >= 400, 'user cannot call get_oauth_tokens', tokenRpc);

  // The attribution binding cannot be set through the Data API, not even
  // with the service key (set_config lives in pg_catalog, which is not exposed).
  const forgedBinding = await call('/rest/v1/rpc/set_config', {
    method: 'POST', key: SERVICE,
    body: { setting_name: 'prisim.privileged_action_id', new_value: userId, is_local: true },
  });
  check(forgedBinding.status >= 400, 'service key: cannot set the attribution binding via the API', forgedBinding.status);
  const useAction = await call('/rest/v1/rpc/use_privileged_action', {
    method: 'POST', key: SERVICE, headers: { 'Content-Profile': 'private' },
    body: { p_action_id: userId, p_action: 'oauth.connect', p_tenant_id: userId, p_target_id: null },
  });
  check(useAction.status >= 400, 'service key: cannot call private.use_privileged_action via the API', useAction.status);

  const privateSchema = await call('/rest/v1/oauth_credentials?select=*', {
    token: jwt, headers: { 'Accept-Profile': 'private' },
  });
  check(privateSchema.status >= 400, 'private schema is not exposed through the Data API', privateSchema);

  // 6. Listed platform admin on an aal1 session gets no admin powers.
  const grant = await call('/rest/v1/platform_admins', {
    method: 'POST', key: SERVICE, body: { user_id: userId, note: 'auth-api.test.mjs' },
  });
  check(grant.status === 201, 'test setup: user added to platform_admins (service_role)', grant);

  const ctx2 = await call('/rest/v1/rpc/get_my_context', { method: 'POST', token: jwt, body: {} });
  check(ctx2.json?.is_platform_admin === false, 'aal1 platform admin: no admin privileges with a real JWT', ctx2.json);
  check(ctx2.json?.platform_admin_mfa_required === true, 'aal1 platform admin: MFA step-up requested', ctx2.json);

  const adminTenants = await call('/rest/v1/tenants?select=id', { token: jwt });
  check(adminTenants.json?.length === 0, 'aal1 platform admin: cannot list tenants', adminTenants);
  const seedTenant = '11111111-1111-4111-8111-111111111111';
  const aal1Action = await call('/rest/v1/rpc/begin_privileged_action', {
    method: 'POST', token: jwt, body: { p_tenant_id: seedTenant, p_action: 'oauth.connect' },
  });
  check(aal1Action.status >= 400, 'aal1 platform admin: cannot start a privileged action', aal1Action.status);

  // 7. Real TOTP step-up -> aal2 JWT -> admin privileges.
  const factor = await call('/auth/v1/factors', {
    method: 'POST', token: jwt, body: { factor_type: 'totp', friendly_name: `test-${stamp}` },
  });
  check(factor.status === 200 && factor.json?.totp?.secret, 'TOTP factor enrolled', factor.status);
  const challenge = await call(`/auth/v1/factors/${factor.json?.id}/challenge`, { method: 'POST', token: jwt, body: {} });
  const verify = await call(`/auth/v1/factors/${factor.json?.id}/verify`, {
    method: 'POST', token: jwt,
    body: { challenge_id: challenge.json?.id, code: totp(factor.json?.totp?.secret ?? '') },
  });
  const jwt2 = verify.json?.access_token;
  check(verify.status === 200 && jwt2, 'TOTP verification returns a new JWT', verify);
  check(jwt2 && jwtClaims(jwt2).aal === 'aal2', 'verified session is aal2', jwt2 && jwtClaims(jwt2).aal);

  const ctx3 = await call('/rest/v1/rpc/get_my_context', { method: 'POST', token: jwt2, body: {} });
  check(ctx3.json?.is_platform_admin === true, 'aal2 platform admin: admin privileges granted', ctx3.json);
  const adminTenants2 = await call('/rest/v1/tenants?select=id', { token: jwt2 });
  check(adminTenants2.json?.length > 0, 'aal2 platform admin: can list tenants', adminTenants2.json?.length);
  const stillAal1 = await call('/rest/v1/tenants?select=id', { token: jwt });
  check(stillAal1.json?.length === 0, 'the earlier aal1 JWT still has no admin privileges', stillAal1.json?.length);

  // Real end-to-end attribution: user JWT starts the action, the service key
  // performs the work, the audit row names the user.
  const action = await call('/rest/v1/rpc/begin_privileged_action', {
    method: 'POST', token: jwt2, body: { p_tenant_id: seedTenant, p_action: 'oauth.connect' },
  });
  const actionId = action.json?.[0]?.action_id;
  check(action.status === 200 && actionId, 'aal2 platform admin: starts a privileged action', action);
  const conn = await call('/rest/v1/rpc/create_oauth_connection', {
    method: 'POST', key: SERVICE,
    body: { p_action_id: actionId, p_tenant_id: seedTenant, p_provider: 'meta' },
  });
  check(conn.status === 200 && typeof conn.json === 'string', 'service key: creates the connection for that action', conn);
  const connAudit = await call(
    `/rest/v1/audit_logs?action=eq.oauth_connections.insert&entity_id=eq.${conn.json}&select=user_id,actor_role`,
    { key: SERVICE }
  );
  check(connAudit.json?.[0]?.user_id === userId && connAudit.json?.[0]?.actor_role === 'service_role',
    'audit: service_role work is attributed to the initiating user', connAudit.json);
  const browserTokens = await call('/rest/v1/rpc/get_oauth_tokens', {
    method: 'POST', token: jwt2, body: { p_connection_id: conn.json },
  });
  check(browserTokens.status >= 400, 'aal2 platform admin JWT: still cannot read OAuth tokens', browserTokens.status);
  if (typeof conn.json === 'string') {
    await call(`/rest/v1/oauth_connections?id=eq.${conn.json}`, { method: 'DELETE', key: SERVICE });
  }

  // 8. anon key alone reads nothing.
  const anonTenants = await call('/rest/v1/tenants?select=id');
  check(anonTenants.status >= 400, 'anon: tenants not readable', anonTenants.status);
  const anonCtx = await call('/rest/v1/rpc/get_my_context', { method: 'POST', body: {} });
  check(anonCtx.status >= 400, 'anon: cannot call get_my_context', anonCtx.status);
} catch (err) {
  check(false, `unexpected error: ${err.message}`);
} finally {
  if (userId) {
    const del = await call(`/auth/v1/admin/users/${userId}`, { method: 'DELETE', key: SERVICE });
    check(del.status === 200, 'cleanup: test user deleted through the Admin API', del.status);
  }
}

console.log(`1..${passed + failed}`);
console.log(`# auth-api: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
