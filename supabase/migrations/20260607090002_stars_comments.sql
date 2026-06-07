-- Stars (GitHub-style, per user) + comments, plus the `public` scope wiring and the
-- editable-visibility / star / comment RPCs. Capability gate stays in SECURITY DEFINER.

-- --- Stars ------------------------------------------------------------------
create table skill_stars (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  skill_id   uuid not null references skills (id) on delete cascade,
  user_id    uuid not null references profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (skill_id, user_id)
);
create index skill_stars_skill_idx on skill_stars (skill_id);

alter table skill_stars enable row level security;
create policy skill_stars_select on skill_stars for select
  using (exists (select 1 from skills s where s.id = skill_stars.skill_id));
create policy skill_stars_insert on skill_stars for insert
  with check (user_id = auth.uid() and exists (select 1 from skills s where s.id = skill_stars.skill_id));
create policy skill_stars_delete on skill_stars for delete using (user_id = auth.uid());
grant select, insert, delete on skill_stars to authenticated;

-- --- Comments ---------------------------------------------------------------
create table skill_comments (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references organizations (id) on delete cascade,
  skill_id   uuid not null references skills (id) on delete cascade,
  author_id  uuid not null references profiles (id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);
create index skill_comments_skill_idx on skill_comments (skill_id, created_at);

alter table skill_comments enable row level security;
create policy skill_comments_select on skill_comments for select
  using (exists (select 1 from skills s where s.id = skill_comments.skill_id));
create policy skill_comments_insert on skill_comments for insert
  with check (author_id = auth.uid() and exists (select 1 from skills s where s.id = skill_comments.skill_id));
grant select, insert on skill_comments to authenticated;

-- --- `public` scope: visible to ANY authenticated user ----------------------
drop policy skills_select on skills;
create policy skills_select on skills for select using (
  scope = 'public'
  or (
    app_member_of_org(org_id) and (
      scope = 'org'
      or (scope = 'private' and owner_id = auth.uid())
      or (scope = 'team' and app_member_of_team(team_id))
      or app_is_org_admin(org_id)
    )
  )
);

-- --- Read view: add star_count + starred ------------------------------------
drop view skill_list_v;
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
  coalesce(cv.tools, '{}') as tools,
  t.slug as team_slug,
  (select count(*) from skill_stars st where st.skill_id = s.id) as star_count,
  exists (select 1 from skill_stars st where st.skill_id = s.id and st.user_id = auth.uid()) as starred
from skills s
join profiles p on p.id = s.owner_id
left join teams t on t.id = s.team_id
left join skill_versions cv on cv.id = s.current_version_id;
grant select on skill_list_v to authenticated;

-- --- RPCs -------------------------------------------------------------------
-- Resolve a skill by slug to one the caller can SEE. SECURITY DEFINER bypasses RLS, so the
-- visibility gate is replicated here explicitly (public OR own OR member of its team) — the
-- star/comment RPCs must not act on skills the caller cannot see.
create or replace function app_resolve_skill(p_slug text)
  returns skills language sql stable security definer set search_path = public as $$
  select * from skills
  where slug = p_slug
    and (
      scope = 'public'
      or owner_id = auth.uid()
      or (scope = 'team' and app_member_of_team(team_id))
    )
  order by case when org_id = (select org_id from memberships where user_id = auth.uid() limit 1) then 0 else 1 end
  limit 1;
$$;

create or replace function toggle_star(p_slug text)
  returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_skill skills%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  v_skill := app_resolve_skill(p_slug);
  if v_skill.id is null then raise exception 'skill not found: %', p_slug using errcode = '42704'; end if;
  if exists (select 1 from skill_stars where skill_id = v_skill.id and user_id = v_uid) then
    delete from skill_stars where skill_id = v_skill.id and user_id = v_uid;
    return false;
  end if;
  insert into skill_stars (org_id, skill_id, user_id) values (v_skill.org_id, v_skill.id, v_uid);
  return true;
end;
$$;
grant execute on function toggle_star(text) to authenticated;

create or replace function add_comment(p_slug text, p_body text)
  returns skill_comments language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_skill skills%rowtype;
  v_row skill_comments%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'empty comment' using errcode = '22023'; end if;
  v_skill := app_resolve_skill(p_slug);
  if v_skill.id is null then raise exception 'skill not found: %', p_slug using errcode = '42704'; end if;
  insert into skill_comments (org_id, skill_id, author_id, body)
  values (v_skill.org_id, v_skill.id, v_uid, trim(p_body))
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function add_comment(text, text) to authenticated;

create or replace function set_skill_scope(p_slug text, p_scope scope, p_team_slug text default null)
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
  select org_id, org_role into v_org, v_role from memberships where user_id = v_uid order by created_at asc limit 1;
  v_admin := v_role in ('owner', 'admin');
  select * into v_skill from skills where slug = p_slug and org_id = v_org;
  if not found then raise exception 'skill not found: %', p_slug using errcode = '42704'; end if;
  if not (v_admin or v_skill.owner_id = v_uid) then raise exception 'not permitted' using errcode = '42501'; end if;

  if p_scope = 'team' then
    if p_team_slug is not null then
      select id into v_team from teams where org_id = v_org and slug = p_team_slug;
    else
      v_team := v_skill.team_id;
    end if;
    if v_team is null then
      select team_id into v_team from team_memberships where user_id = v_uid and org_id = v_org limit 1;
    end if;
    if v_team is null then raise exception 'no team available for team scope' using errcode = '22023'; end if;
    if not (v_admin or app_member_of_team(v_team)) then raise exception 'not a member of that team' using errcode = '42501'; end if;
  else
    v_team := null;
    if p_scope = 'org' and not v_admin then raise exception 'only org admins can set org scope' using errcode = '42501'; end if;
  end if;

  update skills set scope = p_scope, team_id = v_team, updated_at = now() where id = v_skill.id returning * into v_skill;
  return v_skill;
end;
$$;
grant execute on function set_skill_scope(text, scope, text) to authenticated;
