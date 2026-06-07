-- Row-Level Security: the VISIBILITY gate (private/team/org + org-admin override).
-- The capability gate (role rules) is enforced in the service layer (packages/core)
-- and in the SECURITY DEFINER write RPCs; RLS is the enforced backstop.

-- Helpers run SECURITY DEFINER (owned by postgres -> bypass RLS, so no recursion).
create or replace function app_member_of_org(p_org uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from memberships m where m.org_id = p_org and m.user_id = auth.uid());
$$;

create or replace function app_is_org_admin(p_org uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m
    where m.org_id = p_org and m.user_id = auth.uid() and m.org_role in ('owner', 'admin')
  );
$$;

create or replace function app_member_of_team(p_team uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from team_memberships tm where tm.team_id = p_team and tm.user_id = auth.uid());
$$;

create or replace function app_shares_org(p_user uuid)
  returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from memberships m1
    join memberships m2 on m1.org_id = m2.org_id
    where m1.user_id = auth.uid() and m2.user_id = p_user
  );
$$;

alter table organizations    enable row level security;
alter table profiles         enable row level security;
alter table memberships      enable row level security;
alter table teams            enable row level security;
alter table team_memberships enable row level security;
alter table skills           enable row level security;
alter table skill_versions   enable row level security;
alter table audit_log        enable row level security;

-- organizations: members can see their org.
create policy organizations_select on organizations for select
  using (app_member_of_org(id));

-- profiles: yourself + anyone you share an org with (so owner joins in skill_list_v resolve).
create policy profiles_select on profiles for select
  using (id = auth.uid() or app_shares_org(id));

-- memberships: your own rows + org admins see all for their org.
create policy memberships_select on memberships for select
  using (user_id = auth.uid() or app_is_org_admin(org_id));

-- teams: any org member.
create policy teams_select on teams for select
  using (app_member_of_org(org_id));

-- team_memberships: your own, your team's, or org admins.
create policy team_memberships_select on team_memberships for select
  using (user_id = auth.uid() or app_member_of_team(team_id) or app_is_org_admin(org_id));

-- skills: visibility gate (recreated to the strict, team-centric model in a later migration).
create policy skills_select on skills for select using (
  app_member_of_org(org_id) and (
    (scope = 'private' and owner_id = auth.uid())
    or (scope = 'team' and app_member_of_team(team_id))
    or app_is_org_admin(org_id)
  )
);
create policy skills_insert on skills for insert with check (
  app_member_of_org(org_id) and creator_id = auth.uid()
);
create policy skills_update on skills for update
  using (app_member_of_org(org_id) and (owner_id = auth.uid() or app_is_org_admin(org_id)))
  with check (app_member_of_org(org_id));
create policy skills_delete on skills for delete
  using (app_member_of_org(org_id) and (owner_id = auth.uid() or app_is_org_admin(org_id)));

-- skill_versions: mirror the parent skill's visibility (no write policies -> immutable to clients).
create policy skill_versions_select on skill_versions for select
  using (exists (select 1 from skills s where s.id = skill_versions.skill_id));

-- audit_log: org admins only.
create policy audit_log_select on audit_log for select
  using (app_is_org_admin(org_id));

-- Grants. RLS restricts rows; grants restrict operations. The anon role gets nothing.
grant usage on schema public to authenticated;
grant select on organizations, profiles, memberships, teams, team_memberships,
  skill_versions, audit_log to authenticated;
grant select on skill_list_v to authenticated;
grant select, insert, update, delete on skills to authenticated;
