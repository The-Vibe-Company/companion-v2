-- Local dev seed: one org (Acme), three teams, and a sample skill registry mirroring the
-- design handoff. A ready-made admin account (admin@tvc.dev / adminadmin) is seeded as the
-- Org Owner so you can sign in immediately and see the whole registry (org-admin override).
--
-- The five "author" users (alice, marek, …) exist to OWN the sample skills (profiles ->
-- auth.users FK); their password is 'password'. We disable the membership-bootstrap trigger
-- while seeding so we can assign roles explicitly.

-- ---------------------------------------------------------------------------
-- Org + teams (platform is the earliest team -> the bootstrap default).
-- ---------------------------------------------------------------------------
insert into organizations (id, name, slug, kind, plan) values
  ('11111111-1111-1111-1111-111111111111', 'Acme', 'acme', 'team', 'team'),
  -- A second org (personal) so the org switcher + per-org Skills Hub have somewhere to
  -- switch to; admin@tvc.dev owns it and it starts empty.
  ('11111111-1111-1111-1111-111111111112', 'Vibe', 'vibe', 'personal', 'free');

insert into teams (id, org_id, name, slug, created_at) values
  ('22222222-2222-2222-2222-222222222221', '11111111-1111-1111-1111-111111111111', 'Platform', 'platform', now()),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Data', 'data', now() + interval '1 second'),
  ('22222222-2222-2222-2222-222222222223', '11111111-1111-1111-1111-111111111111', 'Support', 'support', now() + interval '2 second');

-- ---------------------------------------------------------------------------
-- Seed users. on_auth_user_created creates their profiles; we add memberships by hand.
-- ---------------------------------------------------------------------------
alter table public.profiles disable trigger on_profile_created;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  confirmation_token, email_change, email_change_token_new, recovery_token
) values
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333331', 'authenticated', 'authenticated', 'alice@acme.test', crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Alice Nardon"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333332', 'authenticated', 'authenticated', 'marek@acme.test', crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Marek Doan"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'priya@acme.test', crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Priya Sharma"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333334', 'authenticated', 'authenticated', 'tomas@acme.test', crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Tomas Okabe"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '33333333-3333-3333-3333-333333333335', 'authenticated', 'authenticated', 'sara@acme.test', crypt('password', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Sara Lindholm"}', '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '333333aa-3333-3333-3333-3333333333a0', 'authenticated', 'authenticated', 'admin@tvc.dev', crypt('adminadmin', gen_salt('bf')), now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"name":"Admin"}', '', '', '', '');

-- Memberships: admin@tvc.dev is the Org Owner; the skill authors are developers.
insert into memberships (org_id, user_id, org_role) values
  ('11111111-1111-1111-1111-111111111111', '333333aa-3333-3333-3333-3333333333a0', 'owner'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333331', 'developer'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333332', 'developer'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'developer'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333334', 'developer'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333335', 'developer'),
  -- admin@tvc.dev owns the personal "Vibe" workspace too.
  ('11111111-1111-1111-1111-111111111112', '333333aa-3333-3333-3333-3333333333a0', 'owner');

insert into team_memberships (org_id, team_id, user_id, team_role) values
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '333333aa-3333-3333-3333-3333333333a0', 'admin'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333331', 'admin'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333332', 'editor'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333334', 'editor'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'admin'),
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222223', '33333333-3333-3333-3333-333333333335', 'admin');

-- A pending invite into Acme (fixed token so the demo "join" link is reproducible).
insert into invitations (org_id, email, org_role, token, invited_by) values
  ('11111111-1111-1111-1111-111111111111', 'newhire@acme.test', 'developer',
   'seedtoken00000000000000000000000000000000000000000000000000acme',
   '333333aa-3333-3333-3333-3333333333a0');

alter table public.profiles enable trigger on_profile_created;

-- ---------------------------------------------------------------------------
-- Sample skills + immutable versions. Checksums are deterministic, valid sha256.
-- ---------------------------------------------------------------------------
insert into skills (id, org_id, slug, description, owner_id, scope, team_id, creator_id, validation, validation_error, created_at, updated_at) values
  ('44444444-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'pdf-extract',  'Extract text, tables, and metadata from PDF documents.', '33333333-3333-3333-3333-333333333331', 'public',  null,                                   '33333333-3333-3333-3333-333333333331', 'valid',      null, now() - interval '5 month', now() - interval '2 hour'),
  ('44444444-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'web-fetch',    'Fetch a URL and return clean, readable markdown.',       '33333333-3333-3333-3333-333333333332', 'public',  null,                                   '33333333-3333-3333-3333-333333333332', 'valid',      null, now() - interval '6 month', now() - interval '6 hour'),
  ('44444444-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'sql-query',    'Run read-only SQL against a connected Postgres database.', '33333333-3333-3333-3333-333333333333', 'team', '22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'validating', null, now() - interval '3 month', now()),
  ('44444444-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'granite-recall', 'Search and cite passages from a Granite memory vault.', '33333333-3333-3333-3333-333333333331', 'team', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333331', 'valid',      null, now() - interval '7 month', now() - interval '1 day'),
  ('44444444-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'repo-review',  'Review a pull request against the team house style.',    '33333333-3333-3333-3333-333333333334', 'team', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333334', 'valid',      null, now() - interval '8 month', now() - interval '1 day'),
  ('44444444-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'csv-profile',  'Profile a CSV: schema, null rates, and value distributions.', '33333333-3333-3333-3333-333333333333', 'private', null,                              '33333333-3333-3333-3333-333333333333', 'valid',      null, now() - interval '2 month', now() - interval '2 day'),
  ('44444444-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'jira-triage',  'Triage and label incoming issues from a project board.', '33333333-3333-3333-3333-333333333332', 'team', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333332', 'valid',      null, now() - interval '4 month', now() - interval '3 day'),
  ('44444444-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'image-ocr',    'OCR scanned images and screenshots to plain text.',      '33333333-3333-3333-3333-333333333334', 'private', null,                              '33333333-3333-3333-3333-333333333334', 'invalid',    'validation failed: SKILL.md frontmatter is missing required field `version`.' || chr(10) || 'Archive also contains a symlink `assets/model -> /usr/share/tessdata` which escapes the package root and was rejected.', now() - interval '7 day', now() - interval '4 day'),
  ('44444444-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'markdown-lint','Lint markdown against the Companion writing style guide.','33333333-3333-3333-3333-333333333331', 'team', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333331', 'valid',      null, now() - interval '9 month', now() - interval '1 week');

insert into skill_versions (id, org_id, skill_id, version, note, frontmatter, tools, license, size_bytes, checksum, storage_path, validation, created_by, created_at) values
  ('55555555-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000001', '2.3.0', 'Add metadata + outline extraction.', $fm$name: pdf-extract
version: 2.3.0
description: Extract text, tables, and metadata from PDF documents.
license: MIT
tools:
  - read_file
  - run_python
scope: org$fm$, '{read_file,run_python}', 'MIT', 41984, 'sha256:' || encode(digest('pdf-extract2.3.0', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/pdf-extract/2.3.0.tar.gz', 'valid', '33333333-3333-3333-3333-333333333331', now() - interval '9 day'),
  ('55555555-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000001', '2.3.1', 'Fix table extraction on rotated pages.', $fm$name: pdf-extract
version: 2.3.1
description: Extract text, tables, and metadata from PDF documents.
license: MIT
tools:
  - read_file
  - run_python
scope: org$fm$, '{read_file,run_python}', 'MIT', 43008, 'sha256:' || encode(digest('pdf-extract2.3.1', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/pdf-extract/2.3.1.tar.gz', 'valid', '33333333-3333-3333-3333-333333333331', now() - interval '2 hour'),
  ('55555555-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000002', '1.8.0', 'Strip nav and cookie banners before convert.', $fm$name: web-fetch
version: 1.8.0
description: Fetch a URL and return clean, readable markdown.
license: MIT
tools:
  - http_get
scope: org$fm$, '{http_get}', 'MIT', 11264, 'sha256:' || encode(digest('web-fetch1.8.0', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/web-fetch/1.8.0.tar.gz', 'valid', '33333333-3333-3333-3333-333333333332', now() - interval '6 hour'),
  ('55555555-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000003', '0.9.2', 'Validating upload.', $fm$name: sql-query
version: 0.9.2
description: Run read-only SQL against a connected Postgres database.
license: Apache-2.0
tools:
  - sql_read
scope: team$fm$, '{sql_read}', 'Apache-2.0', 8192, 'sha256:' || encode(digest('sql-query0.9.2', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/sql-query/0.9.2.tar.gz', 'validating', '33333333-3333-3333-3333-333333333333', now()),
  ('55555555-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000004', '1.2.0', 'Return source spans with every citation.', $fm$name: granite-recall
version: 1.2.0
description: Search and cite passages from a Granite memory vault.
license: MIT
tools:
  - granite_search
  - read_file
scope: org$fm$, '{granite_search,read_file}', 'MIT', 19456, 'sha256:' || encode(digest('granite-recall1.2.0', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/granite-recall/1.2.0.tar.gz', 'valid', '33333333-3333-3333-3333-333333333331', now() - interval '1 day'),
  ('55555555-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000005', '3.1.0', 'Add no-em-dash and sentence-case checks.', $fm$name: repo-review
version: 3.1.0
description: Review a pull request against the team house style.
license: MIT
tools:
  - git_diff
  - read_file
  - run_shell
scope: org$fm$, '{git_diff,read_file,run_shell}', 'MIT', 27648, 'sha256:' || encode(digest('repo-review3.1.0', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/repo-review/3.1.0.tar.gz', 'valid', '33333333-3333-3333-3333-333333333334', now() - interval '1 day'),
  ('55555555-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000006', '1.1.2', 'Handle BOM and mixed delimiters.', $fm$name: csv-profile
version: 1.1.2
description: Profile a CSV: schema, null rates, and value distributions.
license: MIT
tools:
  - read_file
  - run_python
scope: private$fm$, '{read_file,run_python}', 'MIT', 9216, 'sha256:' || encode(digest('csv-profile1.1.2', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/csv-profile/1.1.2.tar.gz', 'valid', '33333333-3333-3333-3333-333333333333', now() - interval '2 day'),
  ('55555555-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000007', '1.0.0', 'Stable release.', $fm$name: jira-triage
version: 1.0.0
description: Triage and label incoming issues from a project board.
license: MIT
tools:
  - http_get
  - http_post
scope: team$fm$, '{http_get,http_post}', 'MIT', 14336, 'sha256:' || encode(digest('jira-triage1.0.0', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/jira-triage/1.0.0.tar.gz', 'valid', '33333333-3333-3333-3333-333333333332', now() - interval '3 day'),
  ('55555555-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000008', '0.2.0', 'Rejected on upload (see error).', $fm$name: image-ocr
description: OCR scanned images and screenshots to plain text.
license: unknown
tools:
  - read_file
  - run_python
scope: private$fm$, '{read_file,run_python}', 'unknown', 31744, 'sha256:' || encode(digest('image-ocr0.2.0', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/image-ocr/0.2.0.tar.gz', 'invalid', '33333333-3333-3333-3333-333333333334', now() - interval '4 day'),
  ('55555555-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000009', '2.0.1', 'Fix false positive on code fences.', $fm$name: markdown-lint
version: 2.0.1
description: Lint markdown against the Companion writing style guide.
license: MIT
tools:
  - read_file
scope: org$fm$, '{read_file}', 'MIT', 10240, 'sha256:' || encode(digest('markdown-lint2.0.1', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/markdown-lint/2.0.1.tar.gz', 'valid', '33333333-3333-3333-3333-333333333331', now() - interval '1 week');

-- Point each skill at its current version (validating/invalid skills point at their latest too).
update skills set current_version_id = '55555555-0000-0000-0000-000000000002' where id = '44444444-0000-0000-0000-000000000001';
update skills set current_version_id = '55555555-0000-0000-0000-000000000003' where id = '44444444-0000-0000-0000-000000000002';
update skills set current_version_id = '55555555-0000-0000-0000-000000000004' where id = '44444444-0000-0000-0000-000000000003';
update skills set current_version_id = '55555555-0000-0000-0000-000000000005' where id = '44444444-0000-0000-0000-000000000004';
update skills set current_version_id = '55555555-0000-0000-0000-000000000006' where id = '44444444-0000-0000-0000-000000000005';
update skills set current_version_id = '55555555-0000-0000-0000-000000000007' where id = '44444444-0000-0000-0000-000000000006';
update skills set current_version_id = '55555555-0000-0000-0000-000000000008' where id = '44444444-0000-0000-0000-000000000007';
update skills set current_version_id = '55555555-0000-0000-0000-000000000009' where id = '44444444-0000-0000-0000-000000000008';
update skills set current_version_id = '55555555-0000-0000-0000-000000000010' where id = '44444444-0000-0000-0000-000000000009';

-- ---------------------------------------------------------------------------
-- More skills (matches the design's fuller registry), one version each.
-- ---------------------------------------------------------------------------
insert into skills (id, org_id, slug, description, owner_id, scope, team_id, creator_id, validation, created_at, updated_at) values
  ('44444444-0000-0000-0000-00000000000a', '11111111-1111-1111-1111-111111111111', 'email-draft',   'Draft replies in the team house style from a thread.',          '33333333-3333-3333-3333-333333333335', 'team', '22222222-2222-2222-2222-222222222223', '33333333-3333-3333-3333-333333333335', 'valid', now() - interval '4 month', now() - interval '4 day'),
  ('44444444-0000-0000-0000-00000000000b', '11111111-1111-1111-1111-111111111111', 'k8s-logs',      'Tail and grep logs from a Kubernetes namespace.',               '33333333-3333-3333-3333-333333333334', 'team', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333334', 'valid', now() - interval '3 month', now() - interval '6 day'),
  ('44444444-0000-0000-0000-00000000000c', '11111111-1111-1111-1111-111111111111', 'openapi-client','Generate a typed client from an OpenAPI specification.',        '33333333-3333-3333-3333-333333333332', 'team', '22222222-2222-2222-2222-222222222221', '33333333-3333-3333-3333-333333333332', 'valid', now() - interval '6 month', now() - interval '1 week'),
  ('44444444-0000-0000-0000-00000000000d', '11111111-1111-1111-1111-111111111111', 'slack-digest',  'Summarize a channel into a short daily digest.',                '33333333-3333-3333-3333-333333333335', 'team', '22222222-2222-2222-2222-222222222223', '33333333-3333-3333-3333-333333333335', 'valid', now() - interval '3 month', now() - interval '2 week'),
  ('44444444-0000-0000-0000-00000000000e', '11111111-1111-1111-1111-111111111111', 'secret-scan',   'Scan a repository for leaked credentials and tokens.',          '33333333-3333-3333-3333-333333333333', 'private', null,                                '33333333-3333-3333-3333-333333333333', 'valid', now() - interval '5 month', now() - interval '3 week');

insert into skill_versions (id, org_id, skill_id, version, note, frontmatter, tools, license, size_bytes, checksum, storage_path, validation, created_by, created_at) values
  ('55555555-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-00000000000a', '1.5.0', 'Match sentence case, drop em dashes.', $fm$name: email-draft
version: 1.5.0
description: Draft replies in the team house style from a thread.
license: MIT
tools:
  - read_file
scope: team$fm$, '{read_file}', 'MIT', 7168, 'sha256:' || encode(digest('email-draft1.5.0', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/email-draft/1.5.0.tar.gz', 'valid', '33333333-3333-3333-3333-333333333335', now() - interval '4 day'),
  ('55555555-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-00000000000b', '0.7.3', 'Add since/until time filters.', $fm$name: k8s-logs
version: 0.7.3
description: Tail and grep logs from a Kubernetes namespace.
license: Apache-2.0
tools:
  - run_shell
scope: team$fm$, '{run_shell}', 'Apache-2.0', 6144, 'sha256:' || encode(digest('k8s-logs0.7.3', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/k8s-logs/0.7.3.tar.gz', 'valid', '33333333-3333-3333-3333-333333333334', now() - interval '6 day'),
  ('55555555-0000-0000-0000-000000000013', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-00000000000c', '1.3.0', 'Support OpenAPI 3.1 nullable types.', $fm$name: openapi-client
version: 1.3.0
description: Generate a typed client from an OpenAPI specification.
license: MIT
tools:
  - read_file
  - run_shell
scope: org$fm$, '{read_file,run_shell}', 'MIT', 23552, 'sha256:' || encode(digest('openapi-client1.3.0', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/openapi-client/1.3.0.tar.gz', 'valid', '33333333-3333-3333-3333-333333333332', now() - interval '1 week'),
  ('55555555-0000-0000-0000-000000000014', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-00000000000d', '0.4.1', 'Dedupe thread replies.', $fm$name: slack-digest
version: 0.4.1
description: Summarize a channel into a short daily digest.
license: MIT
tools:
  - http_get
scope: team$fm$, '{http_get}', 'MIT', 5120, 'sha256:' || encode(digest('slack-digest0.4.1', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/slack-digest/0.4.1.tar.gz', 'valid', '33333333-3333-3333-3333-333333333335', now() - interval '2 week'),
  ('55555555-0000-0000-0000-000000000015', '11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-00000000000e', '0.6.0', 'Add entropy heuristic.', $fm$name: secret-scan
version: 0.6.0
description: Scan a repository for leaked credentials and tokens.
license: Apache-2.0
tools:
  - read_file
  - run_shell
scope: private$fm$, '{read_file,run_shell}', 'Apache-2.0', 13312, 'sha256:' || encode(digest('secret-scan0.6.0', 'sha256'), 'hex'), '11111111-1111-1111-1111-111111111111/secret-scan/0.6.0.tar.gz', 'valid', '33333333-3333-3333-3333-333333333333', now() - interval '3 week');

update skills set current_version_id = '55555555-0000-0000-0000-000000000011' where id = '44444444-0000-0000-0000-00000000000a';
update skills set current_version_id = '55555555-0000-0000-0000-000000000012' where id = '44444444-0000-0000-0000-00000000000b';
update skills set current_version_id = '55555555-0000-0000-0000-000000000013' where id = '44444444-0000-0000-0000-00000000000c';
update skills set current_version_id = '55555555-0000-0000-0000-000000000014' where id = '44444444-0000-0000-0000-00000000000d';
update skills set current_version_id = '55555555-0000-0000-0000-000000000015' where id = '44444444-0000-0000-0000-00000000000e';

-- ---------------------------------------------------------------------------
-- Stars (seed users) + a couple of comment threads, mirroring the design.
-- ---------------------------------------------------------------------------
insert into skill_stars (org_id, skill_id, user_id) values
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333331'),
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333332'),
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333334'),
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000005', '33333333-3333-3333-3333-333333333331'),
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000005', '33333333-3333-3333-3333-333333333334'),
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000004', '33333333-3333-3333-3333-333333333331'),
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000004', '33333333-3333-3333-3333-333333333333'),
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333332'),
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-00000000000c', '33333333-3333-3333-3333-333333333332');

insert into skill_comments (org_id, skill_id, author_id, body, created_at) values
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333332', 'Bumped this on research-agent. Table extraction is noticeably better on the rotated scans.', now() - interval '1 day'),
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333331', 'Shipped 2.3.1 with the fix. Re-run plan & apply to pick it up.', now() - interval '2 hour'),
  ('11111111-1111-1111-1111-111111111111', '44444444-0000-0000-0000-000000000005', '33333333-3333-3333-3333-333333333334', 'Added the no-em-dash and sentence-case checks. Flag me if it gets noisy on existing PRs.', now() - interval '3 hour');
