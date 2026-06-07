-- Write path: the atomic, immutable publish RPC + attach RPC + immutability/audit
-- triggers + the auth bootstrap (first user becomes Org Owner).

-- Comparable semver key for monotonicity checks. Strips build metadata (`+...`) before the
-- int cast, and adds a 4th element so a release outranks a prerelease at the same core
-- (`1.0.0` > `1.0.0-beta`), preventing a prerelease from downgrading a stable current version.
-- `core` is the version with build + prerelease removed.
create or replace function app_semver_key(v text)
  returns int[] language sql immutable as $$
  with parts as (select split_part(v, '+', 1) as no_build),
       core as (select split_part(no_build, '-', 1) as c, (no_build ~ '-') as is_pre from parts)
  select case
    when (select c from core) ~ '^[0-9]+\.[0-9]+\.[0-9]+$' then array[
      split_part((select c from core), '.', 1)::int,
      split_part((select c from core), '.', 2)::int,
      split_part((select c from core), '.', 3)::int,
      case when (select is_pre from core) then 0 else 1 end
    ]
    else array[-1, -1, -1, -1]
  end;
$$;

-- Immutability: skill_versions rows can never be updated or deleted.
create or replace function app_forbid_mutation()
  returns trigger language plpgsql as $$
begin
  raise exception 'skill_versions rows are immutable';
end;
$$;
create trigger skill_versions_immutable
  before update or delete on skill_versions
  for each row execute function app_forbid_mutation();

-- Append-only audit. Robust to tables without a scope column (reads via jsonb).
create or replace function app_write_audit()
  returns trigger language plpgsql security definer set search_path = public as $$
declare
  rec jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
begin
  insert into audit_log (org_id, actor_id, action, resource_type, resource_id, scope)
  values (
    (rec->>'org_id')::uuid,
    auth.uid(),
    lower(tg_table_name) || '.' || lower(tg_op),
    tg_table_name,
    (rec->>'id')::uuid,
    (rec->>'scope')::scope
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger skills_audit after insert or update or delete on skills
  for each row execute function app_write_audit();
create trigger skill_versions_audit after insert on skill_versions
  for each row execute function app_write_audit();

-- Atomic publish: capability gate + monotonic version + immutable insert + pointer flip.
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
  p_note text
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

  select org_id, org_role into v_org, v_role
  from memberships where user_id = v_uid order by created_at asc limit 1;
  if v_org is null then raise exception 'no organization membership' using errcode = '42501'; end if;
  if v_role = 'guest' then raise exception 'insufficient role' using errcode = '42501'; end if;
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
    if not v_admin then raise exception 'only org admins can publish at org scope' using errcode = '42501'; end if;
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
  text, scope, text, text, text, text, text, bigint, text, text[], text, text
) to authenticated;

-- Auth bootstrap: create a profile for every new auth user, then attach the user to an
-- org. The FIRST user (no existing owner) becomes Org Owner; later users join as members.
create or replace function handle_new_user()
  returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, handle)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    split_part(new.email, '@', 1)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

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
    v_role := 'member';
  else
    v_role := 'owner';
  end if;
  insert into memberships (org_id, user_id, org_role) values (v_org, new.id, v_role)
    on conflict (org_id, user_id) do nothing;

  select id into v_team from teams where org_id = v_org order by created_at asc limit 1;
  if v_team is not null then
    insert into team_memberships (org_id, team_id, user_id, team_role) values (v_org, v_team, new.id, 'member')
      on conflict (team_id, user_id) do nothing;
  end if;

  return new;
end;
$$;
create trigger on_profile_created
  after insert on profiles
  for each row execute function handle_new_profile();
