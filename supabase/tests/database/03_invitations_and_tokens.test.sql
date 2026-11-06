-- =====================================================
-- 03 - Invitation workflow and OAuth token vault
-- Run locally with: npx supabase test db
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- -----------------------------------------------------
-- Fixtures
-- -----------------------------------------------------
INSERT INTO auth.users (id, email, email_confirmed_at, aud, role) VALUES
    ('00000000-0000-4000-8000-0000000003a1', 'invitee@inv.test',     NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000003a2', 'other@inv.test',       NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000003a3', 'unconfirmed@inv.test', NULL,  'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000003a4', 'boss@inv.test',        NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000003a5', 'Mixed.Case@Inv.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000003a6', 'former@inv.test',      NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000003ad', 'staff@inv.test',       NOW(), 'authenticated', 'authenticated');

INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-0000000003ad');

-- Raw tokens returned by create_invitation, kept only for this test.
CREATE TEMP TABLE issued (label TEXT PRIMARY KEY, id UUID, token TEXT);
GRANT ALL ON issued TO authenticated;

INSERT INTO public.tenants (id, business_name, slug, status) VALUES
    ('a3000000-0000-4000-8000-000000000000', 'Invite Co',     'invite-co',     'active'),
    ('c3000000-0000-4000-8000-000000000000', 'Suspended Co',  'suspended-co',  'suspended');

INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES
    ('a3000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000003a4', 'owner');

-- Raw tokens below would normally only exist in the invite e-mail.
INSERT INTO public.tenant_invitations (id, tenant_id, email, role, token_hash, expires_at) VALUES
    ('a3000000-0000-4000-8000-0000000000e1', 'a3000000-0000-4000-8000-000000000000', 'invitee@inv.test',     'manager',
        encode(sha256('valid-token-0123456789abcdef0123456789'::bytea), 'hex'), NOW() + INTERVAL '7 days'),
    ('a3000000-0000-4000-8000-0000000000e2', 'a3000000-0000-4000-8000-000000000000', 'other@inv.test',       'client',
        encode(sha256('expired-token-0123456789abcdef01234567'::bytea), 'hex'), NOW() - INTERVAL '1 day'),
    ('a3000000-0000-4000-8000-0000000000e3', 'a3000000-0000-4000-8000-000000000000', 'unconfirmed@inv.test', 'client',
        encode(sha256('unconfirmed-token-0123456789abcdef0123'::bytea), 'hex'), NOW() + INTERVAL '7 days'),
    ('a3000000-0000-4000-8000-0000000000e4', 'a3000000-0000-4000-8000-000000000000', 'boss@inv.test',        'client',
        encode(sha256('boss-token-0123456789abcdef0123456789ab'::bytea), 'hex'), NOW() + INTERVAL '7 days'),
    ('c3000000-0000-4000-8000-0000000000e5', 'c3000000-0000-4000-8000-000000000000', 'other@inv.test',       'client',
        encode(sha256('suspended-token-0123456789abcdef012345'::bytea), 'hex'), NOW() + INTERVAL '7 days');

INSERT INTO public.oauth_connections (id, tenant_id, provider, account_name) VALUES
    ('a3000000-0000-4000-8000-0000000000c0', 'a3000000-0000-4000-8000-000000000000', 'google', 'Invite Co Google'),
    ('a3000000-0000-4000-8000-0000000000c1', 'a3000000-0000-4000-8000-000000000000', 'meta',   'Invite Co Meta');


-- =====================================================
-- INVITATIONS
-- =====================================================
SET LOCAL ROLE authenticated;

-- Invitee
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003a1","role":"authenticated"}';

SELECT throws_ok($$ SELECT public.accept_invitation('short') $$,
    '22023', NULL, 'invite: too-short token rejected');
SELECT throws_ok($$ SELECT public.accept_invitation('wrong-token-0123456789abcdef0123456789') $$,
    '22023', NULL, 'invite: unknown token rejected');
SELECT throws_ok($$ SELECT public.accept_invitation('expired-token-0123456789abcdef01234567') $$,
    '22023', NULL, 'invite: token addressed to another e-mail rejected');
SELECT is(public.accept_invitation('valid-token-0123456789abcdef0123456789'),
    'a3000000-0000-4000-8000-000000000000'::uuid, 'invite: valid token accepted and returns tenant id');
SELECT results_eq($$ SELECT tenant_id, role, status FROM public.tenant_memberships $$,
    $$ VALUES ('a3000000-0000-4000-8000-000000000000'::uuid, 'manager'::text, 'active'::text) $$,
    'invite: membership created with the invited role');
SELECT ok(public.is_tenant_member('a3000000-0000-4000-8000-000000000000'), 'invite: invitee now has tenant access');
SELECT throws_ok($$ SELECT public.accept_invitation('valid-token-0123456789abcdef0123456789') $$,
    '22023', NULL, 'invite: token cannot be reused');

-- Other user
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003a2","role":"authenticated"}';
SELECT throws_ok($$ SELECT public.accept_invitation('expired-token-0123456789abcdef01234567') $$,
    '22023', NULL, 'invite: expired invitation rejected');
SELECT throws_ok($$ SELECT public.accept_invitation('suspended-token-0123456789abcdef012345') $$,
    '22023', NULL, 'invite: invitation to a suspended tenant rejected');

-- Unconfirmed e-mail
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003a3","role":"authenticated"}';
SELECT throws_ok($$ SELECT public.accept_invitation('unconfirmed-token-0123456789abcdef0123') $$,
    '42501', NULL, 'invite: unconfirmed e-mail cannot accept');

-- Existing owner accepting a lower-role invitation keeps the owner role
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003a4","role":"authenticated"}';
SELECT lives_ok($$ SELECT public.accept_invitation('boss-token-0123456789abcdef0123456789ab') $$,
    'invite: existing member can accept');
SELECT is((SELECT role FROM public.tenant_memberships WHERE user_id = '00000000-0000-4000-8000-0000000003a4'),
    'owner', 'invite: accepting never downgrades an existing role');

-- -----------------------------------------------------
-- create_invitation (owner 3a4): DB-generated token, normalized e-mail
-- -----------------------------------------------------
INSERT INTO issued
SELECT 'mixed', invitation_id, invitation_token
FROM public.create_invitation('a3000000-0000-4000-8000-000000000000', '  Mixed.Case@INV.test ', 'viewer');

SELECT ok((SELECT token ~ '^[0-9a-f]{64}$' FROM issued WHERE label = 'mixed'),
    'create: returns a 256-bit hex token');
SELECT is((SELECT email FROM public.tenant_invitations WHERE id = (SELECT id FROM issued WHERE label = 'mixed')),
    'mixed.case@inv.test', 'create: e-mail is trimmed and lower-cased');
SELECT throws_ok($$ SELECT public.create_invitation('a3000000-0000-4000-8000-000000000000', 'not-an-email', 'client') $$,
    '23514', NULL, 'create: malformed e-mail rejected');
SELECT throws_ok($$ SELECT public.create_invitation('c3000000-0000-4000-8000-000000000000', 'x@inv.test', 'client') $$,
    '42501', NULL, 'create: cannot invite into a tenant the caller does not manage');

-- Resend replaces the earlier pending invitation and kills its token.
INSERT INTO issued
SELECT 'resend-1', invitation_id, invitation_token
FROM public.create_invitation('a3000000-0000-4000-8000-000000000000', 'former@inv.test', 'client');
INSERT INTO issued
SELECT 'resend-2', invitation_id, invitation_token
FROM public.create_invitation('a3000000-0000-4000-8000-000000000000', 'former@inv.test', 'manager');
SELECT is((SELECT status FROM public.tenant_invitations WHERE id = (SELECT id FROM issued WHERE label = 'resend-1')),
    'revoked', 'resend: the earlier pending invitation is revoked');

-- An expired pending invitation is closed as expired when re-invited.
SELECT public.create_invitation('a3000000-0000-4000-8000-000000000000', 'other@inv.test', 'client');
SELECT is((SELECT status FROM public.tenant_invitations WHERE id = 'a3000000-0000-4000-8000-0000000000e2'),
    'expired', 'resend: an overdue pending invitation is marked expired');

-- Revoke through the RPC; terminal invitations cannot be revoked again.
SELECT lives_ok($$ SELECT public.revoke_invitation('a3000000-0000-4000-8000-0000000000e3') $$,
    'revoke: owner revokes a pending invitation');
SELECT throws_ok($$ SELECT public.revoke_invitation('a3000000-0000-4000-8000-0000000000e3') $$,
    '22023', NULL, 'revoke: already revoked invitation cannot be revoked again');

-- Mixed-case auth e-mail accepts the lower-cased invitation.
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003a5","role":"authenticated"}';
SELECT is(public.accept_invitation((SELECT token FROM issued WHERE label = 'mixed')),
    'a3000000-0000-4000-8000-000000000000'::uuid, 'case: mixed-case account e-mail accepts the invitation');

-- Former member: old invitation token, deactivation, new invitation.
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003a6","role":"authenticated"}';
SELECT throws_ok(format('SELECT public.accept_invitation(%L)', (SELECT token FROM issued WHERE label = 'resend-1')),
    '22023', NULL, 'resend: the replaced token no longer works');
SELECT lives_ok(format('SELECT public.accept_invitation(%L)', (SELECT token FROM issued WHERE label = 'resend-2')),
    'former: joins with the current invitation');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003a4","role":"authenticated"}';
INSERT INTO issued
SELECT 'stale', invitation_id, invitation_token
FROM public.create_invitation('a3000000-0000-4000-8000-000000000000', 'former@inv.test', 'owner');
SELECT lives_ok($$ SELECT public.deactivate_member('a3000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000003a6') $$,
    'inactive: owner deactivates the member');
SELECT is((SELECT status FROM public.tenant_invitations WHERE id = (SELECT id FROM issued WHERE label = 'stale')),
    'revoked', 'inactive: deactivation revokes the member''s pending invitations');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003a6","role":"authenticated"}';
SELECT ok(NOT public.is_tenant_member('a3000000-0000-4000-8000-000000000000'), 'inactive: access removed');
SELECT throws_ok(format('SELECT public.accept_invitation(%L)', (SELECT token FROM issued WHERE label = 'stale')),
    '22023', NULL, 'inactive: an old invitation cannot restore access');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003a4","role":"authenticated"}';
INSERT INTO issued
SELECT 'rejoin', invitation_id, invitation_token
FROM public.create_invitation('a3000000-0000-4000-8000-000000000000', 'former@inv.test', 'viewer');
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003a6","role":"authenticated"}';
SELECT lives_ok(format('SELECT public.accept_invitation(%L)', (SELECT token FROM issued WHERE label = 'rejoin')),
    'inactive: a fresh invitation re-admits the member');
SELECT results_eq($$ SELECT role, status FROM public.tenant_memberships WHERE user_id = '00000000-0000-4000-8000-0000000003a6' $$,
    $$ VALUES ('viewer'::text, 'active'::text) $$, 'inactive: re-admitted with the newly invited role');

-- -----------------------------------------------------
-- token_hash and direct writes, even for an aal2 platform admin
-- -----------------------------------------------------
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000003ad","role":"authenticated","aal":"aal2"}';
SELECT ok((SELECT count(*) FROM public.tenant_invitations) > 0, 'admin aal2: can list invitations');
SELECT throws_ok($$ SELECT token_hash FROM public.tenant_invitations $$,
    '42501', NULL, 'admin aal2: token_hash is not selectable');
SELECT throws_ok($$ INSERT INTO public.tenant_invitations (tenant_id, email, token_hash)
                    VALUES ('a3000000-0000-4000-8000-000000000000', 'direct@inv.test', repeat('a', 64)) $$,
    '42501', NULL, 'admin aal2: cannot insert invitations directly');
SELECT throws_ok($$ UPDATE public.tenant_invitations SET status = 'pending' $$,
    '42501', NULL, 'admin aal2: cannot update invitations directly');
SELECT throws_ok($$ DELETE FROM public.tenant_invitations $$,
    '42501', NULL, 'admin aal2: cannot delete invitations');

RESET ROLE;

-- -----------------------------------------------------
-- Status transitions are enforced even for the table owner
-- -----------------------------------------------------
SELECT throws_ok($$ UPDATE public.tenant_invitations SET status = 'pending' WHERE id = 'a3000000-0000-4000-8000-0000000000e1' $$,
    '23514', NULL, 'transition: accepted cannot return to pending');
SELECT throws_ok($$ UPDATE public.tenant_invitations SET status = 'pending' WHERE id = 'a3000000-0000-4000-8000-0000000000e3' $$,
    '23514', NULL, 'transition: revoked cannot return to pending');
SELECT throws_ok($$ UPDATE public.tenant_invitations SET role = 'owner' WHERE id = (SELECT id FROM issued WHERE label = 'rejoin') $$,
    '23514', NULL, 'transition: invited role cannot be changed');
SELECT throws_ok($$ UPDATE public.tenant_invitations SET expires_at = NOW() + INTERVAL '1 year'
                    WHERE id = 'c3000000-0000-4000-8000-0000000000e5' $$,
    '23514', NULL, 'transition: expiry cannot be extended');
SELECT throws_ok($$ UPDATE public.tenant_invitations SET status = 'accepted' WHERE id = 'c3000000-0000-4000-8000-0000000000e5' $$,
    '23514', NULL, 'transition: accepted requires accepted_by and accepted_at');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.tenant_invitations i JOIN issued s ON s.id = i.id WHERE i.token_hash = s.token),
    'create: raw tokens are never stored');
SELECT ok((SELECT bool_and(i.token_hash = encode(sha256(convert_to(s.token, 'UTF8')), 'hex'))
           FROM public.tenant_invitations i JOIN issued s ON s.id = i.id),
    'create: stored value is the SHA-256 of the issued token');

SELECT results_eq(
    $$ SELECT status, accepted_by FROM public.tenant_invitations WHERE id = 'a3000000-0000-4000-8000-0000000000e1' $$,
    $$ VALUES ('accepted'::text, '00000000-0000-4000-8000-0000000003a1'::uuid) $$,
    'invite: invitation marked accepted by the invitee');
SELECT ok(EXISTS (SELECT 1 FROM public.audit_logs
                  WHERE action = 'tenant_memberships.insert'
                    AND user_id = '00000000-0000-4000-8000-0000000003a1'),
    'invite: acceptance recorded in the audit log with the actor');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.audit_logs
                      WHERE entity_type = 'tenant_invitations' AND details::text LIKE '%token_hash%'),
    'invite: token hashes are never copied into the audit log');


-- =====================================================
-- OAUTH TOKEN VAULT (as postgres, standing in for service_role RPC calls)
-- =====================================================
SELECT lives_ok(
    $$ SELECT public.store_oauth_tokens('a3000000-0000-4000-8000-0000000000c0', 'access-1', 'refresh-1', '2030-01-01T00:00:00Z') $$,
    'vault: first token store succeeds');
SELECT results_eq(
    $$ SELECT access_token, refresh_token FROM public.get_oauth_tokens('a3000000-0000-4000-8000-0000000000c0') $$,
    $$ VALUES ('access-1'::text, 'refresh-1'::text) $$,
    'vault: tokens round-trip');
SELECT results_eq(
    $$ SELECT status, token_expires_at FROM public.oauth_connections WHERE id = 'a3000000-0000-4000-8000-0000000000c0' $$,
    $$ VALUES ('connected'::text, '2030-01-01T00:00:00Z'::timestamptz) $$,
    'vault: connection marked connected with expiry');

SELECT lives_ok(
    $$ SELECT public.store_oauth_tokens('a3000000-0000-4000-8000-0000000000c0', 'access-2', NULL, '2030-02-01T00:00:00Z') $$,
    'vault: token rotation succeeds');
SELECT results_eq(
    $$ SELECT access_token, refresh_token FROM public.get_oauth_tokens('a3000000-0000-4000-8000-0000000000c0') $$,
    $$ VALUES ('access-2'::text, 'refresh-1'::text) $$,
    'vault: rotation replaces access token and keeps refresh token');
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE name LIKE 'oauth:a3000000-0000-4000-8000-0000000000c0:%'),
    2, 'vault: rotation updates secrets in place (no duplicates)');
SELECT ok((SELECT secret <> 'access-2' FROM vault.secrets WHERE name = 'oauth:a3000000-0000-4000-8000-0000000000c0:access'),
    'vault: secret is stored encrypted');
SELECT ok((SELECT encrypted_access_token IS NULL AND encrypted_refresh_token IS NULL
           FROM public.oauth_connections WHERE id = 'a3000000-0000-4000-8000-0000000000c0'),
    'vault: legacy public columns stay empty');

SELECT lives_ok($$ SELECT public.delete_oauth_tokens('a3000000-0000-4000-8000-0000000000c0') $$,
    'vault: delete succeeds');
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE name LIKE 'oauth:a3000000-0000-4000-8000-0000000000c0:%'),
    0, 'vault: delete purges secrets');
SELECT is((SELECT status FROM public.oauth_connections WHERE id = 'a3000000-0000-4000-8000-0000000000c0'),
    'revoked', 'vault: delete marks connection revoked');
SELECT is_empty($$ SELECT * FROM public.get_oauth_tokens('a3000000-0000-4000-8000-0000000000c0') $$,
    'vault: no tokens after delete');

-- Deleting the connection itself also purges its secrets.
SELECT lives_ok($$ SELECT public.store_oauth_tokens('a3000000-0000-4000-8000-0000000000c1', 'meta-access', 'meta-refresh', NULL) $$,
    'vault: second connection stored');
DELETE FROM public.oauth_connections WHERE id = 'a3000000-0000-4000-8000-0000000000c1';
SELECT is((SELECT count(*)::int FROM vault.secrets WHERE name LIKE 'oauth:a3000000-0000-4000-8000-0000000000c1:%'),
    0, 'vault: deleting a connection purges its secrets');

SELECT throws_ok($$ SELECT public.store_oauth_tokens('a3000000-0000-4000-8000-0000000000ff', 'x') $$,
    '22023', NULL, 'vault: unknown connection rejected');

SELECT * FROM finish();
ROLLBACK;
