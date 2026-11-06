-- =====================================================
-- 05 - Storage: reports bucket configuration and object-level access
-- Run locally with: npx supabase test db
-- Exercises the real storage.objects / storage.buckets RLS policies, not
-- only the helper function.
-- =====================================================
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT no_plan();

-- -----------------------------------------------------
-- H3. Bucket is forced private, with the intended limits
-- -----------------------------------------------------
SELECT results_eq(
    $$ SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'reports' $$,
    $$ VALUES (FALSE, 20971520::bigint,
               ARRAY['application/pdf', 'text/csv',
                     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']::text[]) $$,
    'bucket: reports is private with 20 MiB limit and allowed MIME types');

-- Simulate a pre-existing bucket that was made public in the Dashboard.
UPDATE storage.buckets
SET public = TRUE, file_size_limit = NULL, allowed_mime_types = NULL
WHERE id = 'reports';
SELECT private.ensure_reports_bucket();
SELECT results_eq(
    $$ SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'reports' $$,
    $$ VALUES (FALSE, 20971520::bigint,
               ARRAY['application/pdf', 'text/csv',
                     'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']::text[]) $$,
    'bucket: an existing public reports bucket is forced back to private');

-- -----------------------------------------------------
-- Fixtures
-- -----------------------------------------------------
INSERT INTO auth.users (id, email, email_confirmed_at, aud, role) VALUES
    ('00000000-0000-4000-8000-0000000005a1', 'client@a5.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000005b1', 'client@b5.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000005e1', 'client@s5.test',  NOW(), 'authenticated', 'authenticated'),
    ('00000000-0000-4000-8000-0000000005ad', 'staff@p5.test',   NOW(), 'authenticated', 'authenticated');
INSERT INTO public.platform_admins (user_id) VALUES ('00000000-0000-4000-8000-0000000005ad');

INSERT INTO public.tenants (id, business_name, slug, status) VALUES
    ('a5000000-0000-4000-8000-000000000000', 'Storage A', 'storage-a', 'active'),
    ('b5000000-0000-4000-8000-000000000000', 'Storage B', 'storage-b', 'active'),
    ('c5000000-0000-4000-8000-000000000000', 'Storage S', 'storage-s', 'suspended');

INSERT INTO public.tenant_memberships (tenant_id, user_id, role) VALUES
    ('a5000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000005a1', 'owner'),
    ('b5000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000005b1', 'client'),
    ('c5000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-0000000005e1', 'client');

INSERT INTO storage.objects (bucket_id, name) VALUES
    ('reports', 'a5000000-0000-4000-8000-000000000000/report-1.pdf'),
    ('reports', 'b5000000-0000-4000-8000-000000000000/report-1.pdf'),
    ('reports', 'c5000000-0000-4000-8000-000000000000/report-1.pdf'),
    ('reports', 'not-a-tenant/stray.pdf');

SET LOCAL ROLE authenticated;

-- -----------------------------------------------------
-- Owner of A
-- -----------------------------------------------------
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000005a1","role":"authenticated"}';

SELECT results_eq($$ SELECT name FROM storage.objects WHERE bucket_id = 'reports' $$,
    $$ VALUES ('a5000000-0000-4000-8000-000000000000/report-1.pdf'::text) $$,
    'tenant A: lists only objects in its own folder');
SELECT throws_ok(
    $$ INSERT INTO storage.objects (bucket_id, name) VALUES ('reports', 'a5000000-0000-4000-8000-000000000000/upload.pdf') $$,
    '42501', NULL, 'tenant A owner: cannot upload, even into own folder');
SELECT throws_ok(
    $$ INSERT INTO storage.objects (bucket_id, name) VALUES ('reports', 'b5000000-0000-4000-8000-000000000000/evil.pdf') $$,
    '42501', NULL, 'tenant A owner: cannot upload into another tenant folder');
WITH u AS (UPDATE storage.objects SET name = 'a5000000-0000-4000-8000-000000000000/stolen.pdf'
           WHERE name = 'b5000000-0000-4000-8000-000000000000/report-1.pdf' RETURNING 1)
SELECT is(count(*)::int, 0, 'tenant A owner: cannot move another tenant object into own folder') FROM u;
WITH u AS (UPDATE storage.objects SET metadata = '{"x":1}'
           WHERE name = 'a5000000-0000-4000-8000-000000000000/report-1.pdf' RETURNING 1)
SELECT is(count(*)::int, 0, 'tenant A owner: cannot modify own tenant objects') FROM u;

SET LOCAL storage.allow_delete_query = 'true';
WITH d AS (DELETE FROM storage.objects WHERE bucket_id = 'reports' RETURNING 1)
SELECT is(count(*)::int, 0, 'tenant A owner: cannot delete report objects') FROM d;

-- Bucket configuration cannot be changed through the API.
WITH u AS (UPDATE storage.buckets SET public = TRUE WHERE id = 'reports' RETURNING 1)
SELECT is(count(*)::int, 0, 'tenant user: cannot make the reports bucket public') FROM u;
SELECT throws_ok($$ INSERT INTO storage.buckets (id, name, public) VALUES ('leak', 'leak', TRUE) $$,
    '42501', NULL, 'tenant user: cannot create buckets');

-- -----------------------------------------------------
-- Client of B, member of suspended S
-- -----------------------------------------------------
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000005b1","role":"authenticated"}';
SELECT results_eq($$ SELECT name FROM storage.objects WHERE bucket_id = 'reports' $$,
    $$ VALUES ('b5000000-0000-4000-8000-000000000000/report-1.pdf'::text) $$,
    'tenant B: lists only objects in its own folder');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000005e1","role":"authenticated"}';
SELECT is_empty($$ SELECT name FROM storage.objects WHERE bucket_id = 'reports' $$,
    'suspended tenant: no report objects visible');

SET LOCAL request.jwt.claims TO '{"role":"authenticated"}';
SELECT is_empty($$ SELECT name FROM storage.objects WHERE bucket_id = 'reports' $$,
    'no sub: no report objects visible');

-- -----------------------------------------------------
-- Platform admin: aal1 denied, aal2 allowed
-- -----------------------------------------------------
SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000005ad","role":"authenticated","aal":"aal1"}';
SELECT is_empty($$ SELECT name FROM storage.objects WHERE bucket_id = 'reports' $$,
    'admin aal1: no report objects visible');
SELECT throws_ok(
    $$ INSERT INTO storage.objects (bucket_id, name) VALUES ('reports', 'a5000000-0000-4000-8000-000000000000/aal1.pdf') $$,
    '42501', NULL, 'admin aal1: cannot upload');

SET LOCAL request.jwt.claims TO '{"sub":"00000000-0000-4000-8000-0000000005ad","role":"authenticated","aal":"aal2"}';
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'reports'), 4,
    'admin aal2: sees every report object');
SELECT lives_ok(
    $$ INSERT INTO storage.objects (bucket_id, name) VALUES ('reports', 'b5000000-0000-4000-8000-000000000000/report-2.pdf') $$,
    'admin aal2: can upload reports');
WITH d AS (DELETE FROM storage.objects WHERE name = 'not-a-tenant/stray.pdf' RETURNING 1)
SELECT is(count(*)::int, 1, 'admin aal2: can delete report objects') FROM d;

-- -----------------------------------------------------
-- anon
-- -----------------------------------------------------
RESET ROLE;
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims TO '{"role":"anon"}';
SELECT is_empty($$ SELECT name FROM storage.objects WHERE bucket_id = 'reports' $$,
    'anon: no report objects visible');

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
