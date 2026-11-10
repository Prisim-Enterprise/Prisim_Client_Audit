-- =====================================================
-- 06 - service_role paths, Vault lifecycle and audit-log integrity
-- Run locally with: npx supabase test db
-- Vault RPCs run under the real service_role grant path (SET ROLE).
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

INSERT INTO auth.users (id, email, email_confirmed_at, aud, role) VALUES
    ('00000000-0000-4000-8000-0000000006a1', 'owner@a6.test', NOW(), 'authenticated', 'authenticated');

INSERT INTO public.tenants (id, business_name, slug, status) VALUES
    ('a6000000-0000-4000-8000-000000000000', 'Vault A', 'vault-a', 'active'),
    ('d6000000-0000-4000-8000-000000000000', 'Vault D', 'vault-d', 'active'),
    ('c6000000-0000-4000-8000-000000000000', 'Vault S', 'vault-s', 'suspended');

INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES
    ('a6000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000006a1', 'owner');

INSERT INTO public.oauth_connections (id, tenant_id, provider) VALUES
    ('a6000000-0000-4000-8000-0000000000c0', 'a6000000-0000-4000-8000-000000000000', 'google'),
    ('a6000000-0000-4000-8000-0000000000c1', 'a6000000-0000-4000-8000-000000000000', 'meta'),
    ('d6000000-0000-4000-8000-0000000000c0', 'd6000000-0000-4000-8000-000000000000', 'meta'),
    ('c6000000-0000-4000-8000-0000000000c0', 'c6000000-0000-4000-8000-000000000000', 'meta');

INSERT INTO public.tenant_invitations (tenant_id, email, role, token_hash, expires_at) VALUES
    ('a6000000-0000-4000-8000-000000000000', 'late@a6.test', 'client',
        encode(sha256('vault-fixture-expired-token-00000000'::bytea), 'hex'), NOW() - INTERVAL '1 hour');


-- =====================================================
-- 4. VAULT RPCs UNDER service_role
-- =====================================================
SET LOCAL ROLE service_role;
SET LOCAL request.jwt.claims TO '{"role":"service_role"}';

SELECT lives_ok(
    $$ SELECT public.store_oauth_tokens('a6000000-0000-4000-8000-0000000000c0', 'access-1', 'refresh-1', '2030-01-01T00:00:00Z') $$,
    'service_role: stores tokens');
SELECT results_eq(
    $$ SELECT access_token, refresh_token FROM public.get_oauth_tokens('a6000000-0000-4000-8000-0000000000c0') $$,
    $$ VALUES ('access-1'::text, 'refresh-1'::text) $$,
    'service_role: reads tokens back');
SELECT throws_ok($$ SELECT * FROM private.oauth_credentials $$,
    '42501', NULL, 'service_role: cannot read the credential mapping table directly');

-- Input validation
SELECT throws_ok($$ SELECT public.store_oauth_tokens('a6000000-0000-4000-8000-0000000000c0', NULL, 'r') $$,
    '22023', NULL, 'store: NULL access token rejected');
SELECT throws_ok($$ SELECT public.store_oauth_tokens('a6000000-0000-4000-8000-0000000000c0', '   ') $$,
    '22023', NULL, 'store: blank access token rejected');
SELECT throws_ok($$ SELECT public.store_oauth_tokens('a6000000-0000-4000-8000-0000000000c0', 'a', '') $$,
    '22023', NULL, 'store: empty refresh token rejected');
SELECT throws_ok($$ SELECT public.store_oauth_tokens('c6000000-0000-4000-8000-0000000000c0', 'a') $$,
    '22023', NULL, 'store: suspended tenant rejected');
SELECT throws_ok($$ SELECT public.store_oauth_tokens('ffffffff-0000-4000-8000-0000000000c0', 'a') $$,
    '22023', NULL, 'store: unknown connection rejected');

-- Invitation expiry job
SELECT is(public.expire_stale_invitations(), 1, 'service_role: expires overdue pending invitations');

-- Audit log: readable, but never writable, by service_role
SELECT lives_ok($$ SELECT count(*) FROM public.audit_logs $$, 'service_role: can read the audit log');
SELECT throws_ok(
    $$ INSERT INTO public.audit_logs (action, details) VALUES ('forged.event', '{}') $$,
    '42501', NULL, 'service_role: cannot insert forged audit entries');
SELECT throws_ok($$ UPDATE public.audit_logs SET action = 'tampered' $$,
    '42501', NULL, 'service_role: cannot update audit entries');
SELECT throws_ok($$ DELETE FROM public.audit_logs $$,
    '42501', NULL, 'service_role: cannot delete audit entries');
SELECT throws_ok($$ TRUNCATE public.audit_logs $$,
    '42501', NULL, 'service_role: cannot truncate the audit log');

-- Legitimate trigger insertion still works for service_role writes.
UPDATE public.tenants SET business_name = 'Vault A (renamed)' WHERE id = 'a6000000-0000-4000-8000-000000000000';

RESET ROLE;

SELECT results_eq(
    $$ SELECT user_id, actor_role FROM public.audit_logs
       WHERE action = 'tenants.update' AND tenant_id = 'a6000000-0000-4000-8000-000000000000' $$,
    $$ VALUES (NULL::uuid, 'service_role'::text) $$,
    'audit: service_role change is recorded by the trigger as service_role');
SELECT ok(EXISTS (SELECT 1 FROM public.audit_logs
                  WHERE action = 'oauth_credentials.insert' AND entity_id = 'a6000000-0000-4000-8000-0000000000c0'),
    'audit: token storage is audited');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.audit_logs
                      WHERE entity_type = 'oauth_credentials'
                        AND (details::text LIKE '%secret_id%' OR details::text LIKE '%access-1%')),
    'audit: Vault secret ids and token values are never logged');

SELECT is((SELECT count(*)::int FROM public.audit_logs WHERE action = 'forged.event'), 0, 'audit: no forged entry exists');


-- =====================================================
-- Audit log is append-only even for the table owner
-- =====================================================
SELECT throws_ok($$ UPDATE public.audit_logs SET action = 'tampered' $$,
    '42501', NULL, 'owner role: audit rows cannot be updated');
SELECT throws_ok($$ DELETE FROM public.audit_logs $$,
    '42501', NULL, 'owner role: audit rows cannot be deleted');
SELECT throws_ok($$ TRUNCATE public.audit_logs $$,
    '42501', NULL, 'owner role: audit log cannot be truncated');


-- =====================================================
-- Vault lifecycle edge cases (as postgres)
-- =====================================================
-- Token rotation keeps one secret per kind.
SELECT public.store_oauth_tokens('a6000000-0000-4000-8000-0000000000c0', 'access-2', NULL, NULL);
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE name LIKE 'oauth:a6000000-0000-4000-8000-0000000000c0:%'),
    2, 'vault: rotation does not duplicate secrets');

-- A dangling secret id (secret removed behind our back) is recreated.
DELETE FROM vault.secrets WHERE name = 'oauth:a6000000-0000-4000-8000-0000000000c0:access';
SELECT lives_ok($$ SELECT public.store_oauth_tokens('a6000000-0000-4000-8000-0000000000c0', 'access-3') $$,
    'vault: store recovers from a dangling secret id');
SELECT results_eq(
    $$ SELECT access_token, refresh_token FROM public.get_oauth_tokens('a6000000-0000-4000-8000-0000000000c0') $$,
    $$ VALUES ('access-3'::text, 'refresh-1'::text) $$,
    'vault: recovered token is readable and refresh token kept');

-- A leftover secret with the expected name does not block a first store.
SELECT vault.create_secret('stale', 'oauth:a6000000-0000-4000-8000-0000000000c1:access');
SELECT lives_ok($$ SELECT public.store_oauth_tokens('a6000000-0000-4000-8000-0000000000c1', 'meta-access') $$,
    'vault: orphaned secret with the same name is replaced');
SELECT results_eq(
    $$ SELECT access_token FROM public.get_oauth_tokens('a6000000-0000-4000-8000-0000000000c1') $$,
    $$ VALUES ('meta-access'::text) $$, 'vault: new token, not the stale one, is returned');
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE name = 'oauth:a6000000-0000-4000-8000-0000000000c1:access'),
    1, 'vault: exactly one secret remains for the name');

-- Re-pointing a credential row purges the secret it no longer references.
CREATE TEMP TABLE old_secret AS
    SELECT access_token_secret_id AS id FROM private.oauth_credentials
    WHERE connection_id = 'a6000000-0000-4000-8000-0000000000c1';
UPDATE private.oauth_credentials
SET access_token_secret_id = vault.create_secret('replacement', 'oauth:test:replacement')
WHERE connection_id = 'a6000000-0000-4000-8000-0000000000c1';
SELECT ok(NOT EXISTS (SELECT 1 FROM vault.secrets WHERE id = (SELECT id FROM old_secret)),
    'vault: secret replaced by UPDATE is purged');


-- =====================================================
-- 7. TENANT DELETION CLEANS UP VAULT SECRETS
-- =====================================================
SELECT public.store_oauth_tokens('d6000000-0000-4000-8000-0000000000c0', 'd-access', 'd-refresh');
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE name LIKE 'oauth:d6000000-0000-4000-8000-0000000000c0:%'),
    2, 'tenant delete: secrets exist before deletion');
DELETE FROM public.tenants WHERE id = 'd6000000-0000-4000-8000-000000000000';
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE name LIKE 'oauth:d6000000-0000-4000-8000-0000000000c0:%'),
    0, 'tenant delete: Vault secrets are purged by the cascade');
SELECT is((SELECT count(*)::int FROM private.oauth_credentials WHERE tenant_id = 'd6000000-0000-4000-8000-000000000000'),
    0, 'tenant delete: credential mapping rows are gone');
SELECT ok(EXISTS (SELECT 1 FROM public.audit_logs
                  WHERE action = 'tenants.delete' AND tenant_id = 'd6000000-0000-4000-8000-000000000000'),
    'tenant delete: audit rows keep the deleted tenant id');

-- User deletion keeps the actor on existing audit rows.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000006a1","role":"authenticated"}';
UPDATE public.profiles SET full_name = 'Owner A6 Updated'
WHERE id = '00000000-0000-4000-8000-0000000006a1';
RESET ROLE;
DELETE FROM auth.users WHERE id = '00000000-0000-4000-8000-0000000006a1';
SELECT ok(EXISTS (SELECT 1 FROM public.audit_logs
                  WHERE action = 'profiles.update'
                    AND user_id = '00000000-0000-4000-8000-0000000006a1'),
    'user delete: audit rows keep the actor id');

-- Token functions stay out of reach for signed-in users.
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000006a1","role":"authenticated","aal":"aal2"}';
SELECT throws_ok($$ SELECT public.expire_stale_invitations() $$,
    '42501', NULL, 'authenticated: cannot run the expiry job');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
