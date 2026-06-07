-- Invitations: copy-link membership invites. invite_member mints an unguessable token;
-- an admin shares the link/code; the invitee redeems it via accept_invite (no email sent).

create type invite_status as enum ('pending', 'accepted', 'revoked', 'expired');

create table invitations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  email       citext not null,
  org_role    org_role not null default 'developer' check (org_role <> 'owner'),
  token       text not null unique,                 -- encode(gen_random_bytes(32), 'hex')
  status      invite_status not null default 'pending',
  invited_by  uuid not null references profiles (id),
  accepted_by uuid references profiles (id),
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '7 days'
);

-- At most ONE active (pending) invite per (org, email); historical rows can coexist.
create unique index invitations_active_uniq on invitations (org_id, email) where status = 'pending';
create index invitations_org_idx   on invitations (org_id, created_at desc);
create index invitations_token_idx on invitations (token);

alter table invitations enable row level security;

-- Org admins see their org's invites; an invitee can see a pending invite addressed to them.
create policy invitations_select on invitations for select using (
  app_is_org_admin(org_id)
  or email = (select email from profiles where id = auth.uid())
);
-- No insert/update/delete policies: all writes go through SECURITY DEFINER RPCs.

grant select on invitations to authenticated;
