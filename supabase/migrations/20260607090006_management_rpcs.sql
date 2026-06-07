-- Org / team / membership / invitation mutations. All SECURITY DEFINER (bypass RLS),
-- each re-derives the caller's authority for the TARGET org/team from the DB — never
-- trusting a passed-in role. Guards mirror the design's useOrg(): never demote/remove the
-- last owner or last team admin; only an owner may grant/modify the owner role; a team
-- admin can manage their own team even without org-admin rights.

-- ---------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER so they re-check authority bypassing RLS recursion).
-- ---------------------------------------------------------------------------
create or replace function app_org_role(p_org uuid)
  returns org_role language sql stable security definer set search_path = public as $$
  select org_role from memberships where org_id = p_org and user_id = auth.uid();
$$;

create or replace function app_team_role(p_team uuid)
  returns team_role language sql stable security definer set search_path = public as $$
  select team_role from team_memberships where team_id = p_team and user_id = auth.uid();
$$;

create or replace function app_is_org_owner(p_org uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships where org_id = p_org and user_id = auth.uid() and org_role = 'owner');
$$;

create or replace function app_is_team_admin(p_team uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_memberships where team_id = p_team and user_id = auth.uid() and team_role = 'admin');
$$;

create or replace function app_slugify(p text)
  returns text language sql immutable set search_path = pg_catalog as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '-', 'g'));
$$;

-- ---------------------------------------------------------------------------
-- Org lifecycle
-- ---------------------------------------------------------------------------
create or replace function create_org(p_name text, p_kind text default 'team')
  returns organizations language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_org  organizations%rowtype;
  v_base text;
  v_slug text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if p_kind not in ('personal', 'team') then raise exception 'invalid kind' using errcode = '22023'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'name too short' using errcode = '22023'; end if;

  v_base := nullif(app_slugify(p_name), '');
  if v_base is null then v_base := 'workspace'; end if;
  v_slug := v_base;
  while exists (select 1 from organizations where slug = v_slug) loop
    v_slug := v_base || '-' || substr(md5(gen_random_uuid()::text), 1, 4);
  end loop;

  insert into organizations (name, slug, kind, plan)
  values (trim(p_name), v_slug, p_kind, case when p_kind = 'personal' then 'free' else 'team' end)
  returning * into v_org;
  insert into memberships (org_id, user_id, org_role) values (v_org.id, v_uid, 'owner');
  return v_org;
end;
$$;
grant execute on function create_org(text, text) to authenticated;

-- The caller's orgs (for the switcher), with their role + accurate member counts.
-- SECURITY DEFINER so counts are exact regardless of the caller's role; scoped to own rows.
create or replace function my_orgs()
  returns table(org_id uuid, name text, slug citext, kind text, plan text, org_role org_role, member_count bigint)
  language sql stable security definer set search_path = public as $$
  select o.id, o.name, o.slug, o.kind, o.plan, m.org_role,
         (select count(*) from memberships mm where mm.org_id = o.id)
  from memberships m
  join organizations o on o.id = m.org_id
  where m.user_id = auth.uid()
  order by o.created_at asc;
$$;
grant execute on function my_orgs() to authenticated;

-- ---------------------------------------------------------------------------
-- Invitations (copy-link)
-- ---------------------------------------------------------------------------
create or replace function invite_member(p_org uuid, p_email citext, p_role org_role)
  returns invitations language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_inv invitations%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if length(trim(coalesce(p_email::text, ''))) = 0 then raise exception 'email required' using errcode = '22023'; end if;
  if not app_is_org_admin(p_org) then raise exception 'insufficient role' using errcode = '42501'; end if;
  if p_role = 'owner' then raise exception 'cannot invite as owner' using errcode = '42501'; end if;
  if exists (
    select 1 from memberships m join profiles p on p.id = m.user_id
    where m.org_id = p_org and p.email = p_email
  ) then raise exception 'already a member' using errcode = '23505'; end if;
  if exists (select 1 from invitations where org_id = p_org and email = p_email and status = 'pending') then
    raise exception 'invite already pending' using errcode = '23505';
  end if;

  -- 64 hex chars from two v4 UUIDs (gen_random_uuid is built-in, so this works regardless of
  -- which schema pgcrypto lives in — our search_path is pinned to public).
  insert into invitations (org_id, email, org_role, token, invited_by)
  values (p_org, p_email, p_role,
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), v_uid)
  returning * into v_inv;
  return v_inv;
end;
$$;
grant execute on function invite_member(uuid, citext, org_role) to authenticated;

create or replace function revoke_invite(p_invite uuid)
  returns invitations language plpgsql security definer set search_path = public as $$
declare v_inv invitations%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_inv from invitations where id = p_invite;
  if not found then raise exception 'invite not found' using errcode = '42704'; end if;
  if not app_is_org_admin(v_inv.org_id) then raise exception 'insufficient role' using errcode = '42501'; end if;
  if v_inv.status <> 'pending' then raise exception 'invite is not pending' using errcode = '22023'; end if;
  update invitations set status = 'revoked' where id = p_invite returning * into v_inv;
  return v_inv;
end;
$$;
grant execute on function revoke_invite(uuid) to authenticated;

-- Redeem a token. Re-validates status, expiry, and that the invite was issued to the
-- caller's email (a leaked token cannot be redeemed by a different account).
create or replace function accept_invite(p_token text)
  returns memberships language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_inv   invitations%rowtype;
  v_email citext;
  v_team  uuid;
  v_mem   memberships%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_inv from invitations where token = p_token;
  if not found then raise exception 'invalid invite' using errcode = '42704'; end if;
  if v_inv.status <> 'pending' then raise exception 'invite is no longer valid' using errcode = '22023'; end if;
  if v_inv.expires_at <= now() then
    update invitations set status = 'expired' where id = v_inv.id;
    raise exception 'invite has expired' using errcode = '22023';
  end if;
  select email into v_email from profiles where id = v_uid;
  if v_email is distinct from v_inv.email then
    raise exception 'this invite was issued to a different email' using errcode = '42501';
  end if;

  insert into memberships (org_id, user_id, org_role) values (v_inv.org_id, v_uid, v_inv.org_role)
    on conflict (org_id, user_id) do nothing;
  -- Auto-join the earliest team as reader (least privilege; an admin can elevate later).
  select id into v_team from teams where org_id = v_inv.org_id order by created_at asc limit 1;
  if v_team is not null then
    insert into team_memberships (org_id, team_id, user_id, team_role) values (v_inv.org_id, v_team, v_uid, 'reader')
      on conflict (team_id, user_id) do nothing;
  end if;
  update invitations set status = 'accepted', accepted_by = v_uid, accepted_at = now() where id = v_inv.id;

  select * into v_mem from memberships where org_id = v_inv.org_id and user_id = v_uid;
  return v_mem;
end;
$$;
grant execute on function accept_invite(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Org membership management
-- ---------------------------------------------------------------------------
create or replace function set_member_role(p_org uuid, p_user uuid, p_role org_role)
  returns memberships language plpgsql security definer set search_path = public as $$
declare v_target org_role; v_mem memberships%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not app_is_org_admin(p_org) then raise exception 'insufficient role' using errcode = '42501'; end if;
  select org_role into v_target from memberships where org_id = p_org and user_id = p_user;
  if v_target is null then raise exception 'not a member' using errcode = '42704'; end if;
  -- Only an owner may grant or modify the owner role.
  if (v_target = 'owner' or p_role = 'owner') and not app_is_org_owner(p_org) then
    raise exception 'only an owner can change another owner' using errcode = '42501';
  end if;
  -- Never demote the last owner.
  if v_target = 'owner' and p_role <> 'owner'
     and (select count(*) from memberships where org_id = p_org and org_role = 'owner') <= 1 then
    raise exception 'cannot demote the last owner' using errcode = '42501';
  end if;
  update memberships set org_role = p_role where org_id = p_org and user_id = p_user returning * into v_mem;
  return v_mem;
end;
$$;
grant execute on function set_member_role(uuid, uuid, org_role) to authenticated;

create or replace function remove_member(p_org uuid, p_user uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_target org_role; v_self boolean := (p_user = auth.uid());
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not (app_is_org_admin(p_org) or v_self) then raise exception 'insufficient role' using errcode = '42501'; end if;
  select org_role into v_target from memberships where org_id = p_org and user_id = p_user;
  if v_target is null then raise exception 'not a member' using errcode = '42704'; end if;
  if v_target = 'owner' and not v_self and not app_is_org_owner(p_org) then
    raise exception 'only an owner can remove another owner' using errcode = '42501';
  end if;
  if v_target = 'owner' and (select count(*) from memberships where org_id = p_org and org_role = 'owner') <= 1 then
    raise exception 'cannot remove the last owner' using errcode = '42501';
  end if;
  delete from team_memberships where org_id = p_org and user_id = p_user;
  delete from memberships where org_id = p_org and user_id = p_user;
end;
$$;
grant execute on function remove_member(uuid, uuid) to authenticated;

create or replace function leave_org(p_org uuid)
  returns void language plpgsql security definer set search_path = public as $$
begin
  perform remove_member(p_org, auth.uid());
end;
$$;
grant execute on function leave_org(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------------
create or replace function create_team(p_org uuid, p_name text)
  returns teams language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_base text; v_slug text; v_team teams%rowtype;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not app_is_org_admin(p_org) then raise exception 'insufficient role' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'name too short' using errcode = '22023'; end if;

  v_base := nullif(app_slugify(p_name), '');
  if v_base is null then v_base := 'team'; end if;
  v_slug := v_base;
  while exists (select 1 from teams where org_id = p_org and slug = v_slug) loop
    v_slug := v_base || '-' || substr(md5(gen_random_uuid()::text), 1, 4);
  end loop;

  insert into teams (org_id, name, slug) values (p_org, trim(p_name), v_slug) returning * into v_team;
  insert into team_memberships (org_id, team_id, user_id, team_role) values (p_org, v_team.id, v_uid, 'admin');
  return v_team;
end;
$$;
grant execute on function create_team(uuid, text) to authenticated;

create or replace function rename_team(p_team uuid, p_name text)
  returns teams language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_team teams%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select org_id into v_org from teams where id = p_team;
  if v_org is null then raise exception 'team not found' using errcode = '42704'; end if;
  if not (app_is_org_admin(v_org) or app_is_team_admin(p_team)) then raise exception 'insufficient role' using errcode = '42501'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'name too short' using errcode = '22023'; end if;
  update teams set name = trim(p_name) where id = p_team returning * into v_team;  -- slug stays stable
  return v_team;
end;
$$;
grant execute on function rename_team(uuid, text) to authenticated;

create or replace function delete_team(p_team uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select org_id into v_org from teams where id = p_team;
  if v_org is null then raise exception 'team not found' using errcode = '42704'; end if;
  if not app_is_org_admin(v_org) then raise exception 'insufficient role' using errcode = '42501'; end if;
  if exists (select 1 from skills where team_id = p_team) then
    raise exception 'team has skills; reassign them first' using errcode = '42501';
  end if;
  delete from teams where id = p_team;
end;
$$;
grant execute on function delete_team(uuid) to authenticated;

create or replace function add_team_member(p_org uuid, p_team uuid, p_user uuid, p_role team_role default 'editor')
  returns team_memberships language plpgsql security definer set search_path = public as $$
declare v_team_org uuid; v_tm team_memberships%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select org_id into v_team_org from teams where id = p_team;
  if v_team_org is null then raise exception 'team not found' using errcode = '42704'; end if;
  if v_team_org <> p_org then raise exception 'team does not belong to org' using errcode = '22023'; end if;
  if not (app_is_org_admin(p_org) or app_is_team_admin(p_team)) then raise exception 'insufficient role' using errcode = '42501'; end if;
  if not exists (select 1 from memberships where org_id = p_org and user_id = p_user) then
    raise exception 'user is not an org member' using errcode = '42704';
  end if;
  insert into team_memberships (org_id, team_id, user_id, team_role)
  values (p_org, p_team, p_user, p_role)
  on conflict (team_id, user_id) do update set team_role = excluded.team_role
  returning * into v_tm;
  return v_tm;
end;
$$;
grant execute on function add_team_member(uuid, uuid, uuid, team_role) to authenticated;

create or replace function set_team_member_role(p_team uuid, p_user uuid, p_role team_role)
  returns team_memberships language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_target team_role; v_tm team_memberships%rowtype;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select org_id into v_org from teams where id = p_team;
  if v_org is null then raise exception 'team not found' using errcode = '42704'; end if;
  if not (app_is_org_admin(v_org) or app_is_team_admin(p_team)) then raise exception 'insufficient role' using errcode = '42501'; end if;
  select team_role into v_target from team_memberships where team_id = p_team and user_id = p_user;
  if v_target is null then raise exception 'not a team member' using errcode = '42704'; end if;
  if v_target = 'admin' and p_role <> 'admin'
     and (select count(*) from team_memberships where team_id = p_team and team_role = 'admin') <= 1 then
    raise exception 'cannot demote the last team admin' using errcode = '42501';
  end if;
  update team_memberships set team_role = p_role where team_id = p_team and user_id = p_user returning * into v_tm;
  return v_tm;
end;
$$;
grant execute on function set_team_member_role(uuid, uuid, team_role) to authenticated;

create or replace function remove_team_member(p_team uuid, p_user uuid)
  returns void language plpgsql security definer set search_path = public as $$
declare v_org uuid; v_target team_role; v_self boolean := (p_user = auth.uid());
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select org_id into v_org from teams where id = p_team;
  if v_org is null then raise exception 'team not found' using errcode = '42704'; end if;
  if not (app_is_org_admin(v_org) or app_is_team_admin(p_team) or v_self) then raise exception 'insufficient role' using errcode = '42501'; end if;
  select team_role into v_target from team_memberships where team_id = p_team and user_id = p_user;
  if v_target is null then raise exception 'not a team member' using errcode = '42704'; end if;
  if v_target = 'admin' and (select count(*) from team_memberships where team_id = p_team and team_role = 'admin') <= 1 then
    raise exception 'cannot remove the last team admin' using errcode = '42501';
  end if;
  delete from team_memberships where team_id = p_team and user_id = p_user;
end;
$$;
grant execute on function remove_team_member(uuid, uuid) to authenticated;
