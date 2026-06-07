-- Private bucket for skill package archives. Object key convention:
--   {org_id}/{skill_slug}/{version}.tar.gz   (tenant = first path segment)

insert into storage.buckets (id, name, public)
values ('skill-archives', 'skill-archives', false)
on conflict (id) do nothing;

-- READ: org members may read their own tenant's prefix.
create policy "skill archives read" on storage.objects for select to authenticated using (
  bucket_id = 'skill-archives'
  and app_member_of_org(((storage.foldername(name))[1])::uuid)
);

-- WRITE: org members may upload into their tenant prefix. (Capability nuance -- who may
-- create which skill -- is enforced by the publish RPC before the version row is written.)
create policy "skill archives write" on storage.objects for insert to authenticated with check (
  bucket_id = 'skill-archives'
  and app_member_of_org(((storage.foldername(name))[1])::uuid)
);

-- No UPDATE / DELETE policy: archives are immutable like skill_versions. Lifecycle
-- cleanup of orphaned uploads runs via the service role from a trusted server route.
