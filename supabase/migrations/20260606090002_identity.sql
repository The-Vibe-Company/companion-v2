-- Identity & tenancy: organizations, profiles, memberships, teams.
-- Every tenant row carries org_id. The hierarchy is Organization -> Team -> User.

create type org_role as enum ('owner', 'admin', 'member', 'guest');
create type team_role as enum ('admin', 'member');
create type scope as enum ('private', 'team', 'org');
create type validation_state as enum ('valid', 'validating', 'invalid');

create table organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       citext not null unique,
  created_at timestamptz not null default now()
);

-- 1:1 with auth.users; holds the display fields the UI needs.
create table profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      citext not null,
  name       text not null default '',
  handle     citext,
  initials   text generated always as (
    upper(
      coalesce(left(split_part(coalesce(nullif(name, ''), email), ' ', 1), 1), '') ||
      coalesce(left(nullif(split_part(coalesce(nullif(name, ''), email), ' ', 2), ''), 1), '')
    )
  ) stored,
  created_at timestamptz not null default now()
);

create table memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  org_role   org_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_user_idx on memberships (user_id);

create table teams (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  name       text not null,
  slug       citext not null,
  created_at timestamptz not null default now(),
  unique (org_id, slug)
);

create table team_memberships (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  team_id    uuid not null references teams (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  team_role  team_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (team_id, user_id)
);
create index team_memberships_user_idx on team_memberships (org_id, user_id);
