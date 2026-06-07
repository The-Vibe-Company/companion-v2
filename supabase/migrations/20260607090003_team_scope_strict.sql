-- Strict, team-centric visibility. A user sees ONLY:
--   * public skills (anyone),
--   * skills of teams they belong to,
--   * their own skills (any scope).
-- There is no org-wide tier and no org-admin override — a user never sees the whole org.
drop policy skills_select on skills;
create policy skills_select on skills for select using (
  scope = 'public'
  or owner_id = auth.uid()
  or (scope = 'team' and app_member_of_team(team_id))
);
