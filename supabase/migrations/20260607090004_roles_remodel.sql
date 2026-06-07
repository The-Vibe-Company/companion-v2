-- Role remodel: align the RBAC vocabulary with the design that shipped.
--   org_role:  owner / admin / member / guest  ->  owner / admin / developer
--   team_role: admin / member                 ->  admin / editor / reader
-- Postgres cannot drop/rename enum values in place, so we swap the enum TYPES and
-- recast the columns. Plus org metadata columns (kind/plan) the General pane shows.

-- 1. Rename the old types out of the way (keeps existing column data castable).
alter type org_role  rename to org_role_old;
alter type team_role rename to team_role_old;

-- 2. New types matching the design.
create type org_role  as enum ('owner', 'admin', 'developer');
create type team_role as enum ('admin', 'editor', 'reader');

-- 3. Drop column defaults (a default of the old type blocks the type swap).
alter table memberships      alter column org_role  drop default;
alter table team_memberships alter column team_role drop default;

-- 4. Recast columns with an explicit value mapping.
--    member -> developer, guest -> developer (the least-privileged real role).
alter table memberships
  alter column org_role type org_role
  using (case when org_role::text in ('owner', 'admin') then org_role::text else 'developer' end)::org_role;

--    member -> editor: preserves the publish capability team members had (the RLS
--    publish gate keys off team membership, and the team-RLS tests rely on it).
alter table team_memberships
  alter column team_role type team_role
  using (case when team_role::text = 'admin' then 'admin' else 'editor' end)::team_role;

-- 5. Restore defaults in the NEW type.
alter table memberships      alter column org_role  set default 'developer';
alter table team_memberships alter column team_role set default 'editor';

-- 6. Org metadata the design's General pane + onboarding need.
alter table organizations
  add column kind text not null default 'team' check (kind in ('personal', 'team')),
  add column plan text not null default 'team' check (plan in ('free', 'team'));

-- 7. Replace the functions whose local vars are typed by the enum (so the old type
--    can be dropped) and apply the logic changes (no more `guest`; honor `p_org`).

-- Auth bootstrap: first user -> Owner, later -> Developer; auto-join earliest team as Editor.
create or replace function handle_new_profile()
  returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_org  uuid;
  v_team uuid;
  v_role org_role;
begin
  if exists (select 1 from memberships where user_id = new.id) then return new; end if;

  select id into v_org from organizations order by created_at asc limit 1;
  if v_org is null then
    insert into organizations (name, slug) values ('Companion', 'companion') returning id into v_org;
  end if;

  if exists (select 1 from memberships where org_id = v_org and org_role = 'owner') then
    v_role := 'developer';
  else
    v_role := 'owner';
  end if;
  insert into memberships (org_id, user_id, org_role) values (v_org, new.id, v_role)
    on conflict (org_id, user_id) do nothing;

  select id into v_team from teams where org_id = v_org order by created_at asc limit 1;
  if v_team is not null then
    insert into team_memberships (org_id, team_id, user_id, team_role) values (v_org, v_team, new.id, 'editor')
      on conflict (team_id, user_id) do nothing;
  end if;

  return new;
end;
$$;

-- Atomic publish. Drop the old (enum-typed) function, recreate with an optional p_org
-- (the current workspace) and without the now-nonexistent `guest` role check.
drop function if exists publish_skill_version(
  text, scope, text, text, text, text, text, bigint, text, text[], text, text
);
create or replace function publish_skill_version(
  p_slug text,
  p_scope scope,
  p_team_slug text,
  p_version text,
  p_description text,
  p_checksum text,
  p_storage_path text,
  p_size bigint,
  p_frontmatter text,
  p_tools text[],
  p_license text,
  p_note text,
  p_org uuid default null
) returns skill_versions language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_org   uuid;
  v_role  org_role;
  v_team  uuid;
  v_admin boolean;
  v_skill skills%rowtype;
  v_new   skill_versions%rowtype;
  v_cur   text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;

  -- Resolve the target org: the explicit current workspace, else the earliest membership.
  if p_org is not null then
    v_org := p_org;
    select org_role into v_role from memberships where user_id = v_uid and org_id = v_org;
    if v_role is null then raise exception 'not a member of org' using errcode = '42501'; end if;
  else
    select org_id, org_role into v_org, v_role
    from memberships where user_id = v_uid order by created_at asc limit 1;
    if v_org is null then raise exception 'no organization membership' using errcode = '42501'; end if;
  end if;
  v_admin := v_role in ('owner', 'admin');

  -- Scope capability gate.
  if p_scope = 'team' then
    if p_team_slug is null then raise exception 'team scope requires a team' using errcode = '22023'; end if;
    select id into v_team from teams where org_id = v_org and slug = p_team_slug;
    if v_team is null then raise exception 'unknown team: %', p_team_slug using errcode = '42704'; end if;
    if not (v_admin or app_member_of_team(v_team)) then
      raise exception 'not a member of team: %', p_team_slug using errcode = '42501';
    end if;
  elsif p_scope = 'org' then
    -- The org-wide tier was removed; scope is private/team/public. Reject the legacy value
    -- (a direct RPC caller could still pass it; the app/contracts never do).
    raise exception 'org scope is no longer supported' using errcode = '22023';
  end if;

  if p_checksum !~ '^sha256:[0-9a-f]{64}$' then raise exception 'invalid checksum format' using errcode = '22023'; end if;
  if app_semver_key(p_version) = array[-1, -1, -1, -1] then raise exception 'invalid version: %', p_version using errcode = '22023'; end if;

  select * into v_skill from skills where org_id = v_org and slug = p_slug;
  if found then
    if not (v_admin or v_skill.owner_id = v_uid) then
      raise exception 'not permitted to modify skill: %', p_slug using errcode = '42501';
    end if;
    if v_skill.current_version_id is not null then
      select version into v_cur from skill_versions where id = v_skill.current_version_id;
      if exists (select 1 from skill_versions where skill_id = v_skill.id and version = p_version) then
        raise exception 'version % already exists', p_version using errcode = '23505';
      end if;
      if app_semver_key(p_version) < app_semver_key(v_cur) then
        raise exception 'version % is older than current %', p_version, v_cur using errcode = '22023';
      end if;
    end if;
  else
    insert into skills (org_id, slug, description, owner_id, scope, team_id, creator_id, validation)
    values (v_org, p_slug, p_description, v_uid, p_scope, v_team, v_uid, 'validating')
    returning * into v_skill;
  end if;

  insert into skill_versions (
    org_id, skill_id, version, note, frontmatter, tools, license,
    size_bytes, checksum, storage_path, validation, created_by
  ) values (
    v_org, v_skill.id, p_version, coalesce(p_note, ''), p_frontmatter, coalesce(p_tools, '{}'), p_license,
    p_size, p_checksum, p_storage_path, 'valid', v_uid
  ) returning * into v_new;

  update skills set
    current_version_id = v_new.id,
    description = coalesce(nullif(p_description, ''), description),
    scope = p_scope,
    team_id = v_team,
    validation = 'valid',
    validation_error = null,
    updated_at = now()
  where id = v_skill.id;

  return v_new;
end;
$$;
grant execute on function publish_skill_version(
  text, scope, text, text, text, text, text, bigint, text, text[], text, text, uuid
) to authenticated;

-- set_skill_scope: recreate with an optional p_org (current workspace).
drop function if exists set_skill_scope(text, scope, text);
create or replace function set_skill_scope(p_slug text, p_scope scope, p_team_slug text default null, p_org uuid default null)
  returns skills language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_role org_role;
  v_admin boolean;
  v_skill skills%rowtype;
  v_team uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_org is not null then
    v_org := p_org;
    select org_role into v_role from memberships where user_id = v_uid and org_id = v_org;
    if v_role is null then raise exception 'not a member of org' using errcode = '42501'; end if;
  else
    select org_id, org_role into v_org, v_role from memberships where user_id = v_uid order by created_at asc limit 1;
  end if;
  v_admin := v_role in ('owner', 'admin');
  select * into v_skill from skills where slug = p_slug and org_id = v_org;
  if not found then raise exception 'skill not found: %', p_slug using errcode = '42704'; end if;
  if not (v_admin or v_skill.owner_id = v_uid) then raise exception 'not permitted' using errcode = '42501'; end if;

  if p_scope = 'team' then
    if p_team_slug is not null then
      -- An explicit team that doesn't exist is an error, not a silent fallback to another team.
      select id into v_team from teams where org_id = v_org and slug = p_team_slug;
      if v_team is null then raise exception 'unknown team: %', p_team_slug using errcode = '42704'; end if;
    else
      v_team := v_skill.team_id;
      if v_team is null then
        select team_id into v_team from team_memberships where user_id = v_uid and org_id = v_org limit 1;
      end if;
      if v_team is null then raise exception 'no team available for team scope' using errcode = '22023'; end if;
    end if;
    if not (v_admin or app_member_of_team(v_team)) then raise exception 'not a member of that team' using errcode = '42501'; end if;
  else
    v_team := null;
    if p_scope = 'org' then raise exception 'org scope is no longer supported' using errcode = '22023'; end if;
  end if;

  update skills set scope = p_scope, team_id = v_team, updated_at = now() where id = v_skill.id returning * into v_skill;
  return v_skill;
end;
$$;
grant execute on function set_skill_scope(text, scope, text, uuid) to authenticated;

-- 8. Drop the old enum types (now unreferenced).
drop type org_role_old;
drop type team_role_old;
