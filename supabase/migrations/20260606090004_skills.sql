-- Skills Hub core. Three-column separation throughout:
--   owner_id   = the principal the skill is FOR
--   scope/team_id = VISIBILITY
--   creator_id = who ACTED (provenance/audit)

create table skills (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations (id) on delete cascade,
  slug               citext not null,                          -- the kebab id, e.g. 'pdf-extract'
  description        text not null default '',
  owner_id           uuid not null references profiles (id),
  scope              scope not null default 'private',
  team_id            uuid references teams (id),
  creator_id         uuid not null references profiles (id),
  current_version_id uuid,                                     -- FK added after skill_versions
  validation         validation_state not null default 'validating',
  validation_error   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (org_id, slug),
  check ((scope = 'team') = (team_id is not null))
);
create index skills_access_idx on skills (org_id, scope, team_id);  -- the PRD-mandated index
create index skills_validation_idx on skills (org_id, validation);

-- Immutable, checksummed version history. Written ONLY by the publish RPC; a trigger
-- forbids UPDATE/DELETE (see the functions migration).
create table skill_versions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organizations (id) on delete cascade,
  skill_id         uuid not null references skills (id) on delete cascade,
  version          text not null,
  note             text not null default '',
  frontmatter      text not null,                              -- raw YAML (preview source)
  tools            text[] not null default '{}',
  license          text,
  size_bytes       bigint not null,
  checksum         text not null,
  storage_path     text not null,
  validation       validation_state not null default 'valid',
  validation_error text,
  created_by       uuid not null references profiles (id),
  created_at       timestamptz not null default now(),
  unique (skill_id, version),
  check (checksum ~ '^sha256:[0-9a-f]{64}$')
);
create index skill_versions_skill_idx on skill_versions (org_id, skill_id, created_at desc);

alter table skills
  add constraint skills_current_version_fk
  foreign key (current_version_id) references skill_versions (id);

-- Append-only audit trail. Written only by SECURITY DEFINER triggers.
create table audit_log (
  id            bigint generated always as identity primary key,
  org_id        uuid not null references organizations (id) on delete cascade,
  actor_id      uuid references profiles (id),
  action        text not null,
  resource_type text not null,
  resource_id   uuid,
  scope         scope,
  metadata      jsonb not null default '{}',
  created_at    timestamptz not null default now()
);
create index audit_log_org_idx on audit_log (org_id, created_at desc);

-- The denormalized read shape the web table and CLI list both consume. security_invoker
-- so the querying user's RLS on the base tables filters the view rows.
create view skill_list_v with (security_invoker = true) as
select
  s.id,
  s.org_id,
  s.slug,
  s.description,
  s.scope,
  s.team_id,
  s.validation,
  s.validation_error,
  s.owner_id,
  s.created_at,
  s.updated_at,
  p.name as owner_name,
  p.handle as owner_handle,
  p.initials as owner_initials,
  t.name as team_name,
  cv.version as current_version,
  cv.size_bytes,
  cv.license,
  cv.checksum,
  coalesce(cv.tools, '{}') as tools
from skills s
join profiles p on p.id = s.owner_id
left join teams t on t.id = s.team_id
left join skill_versions cv on cv.id = s.current_version_id;
