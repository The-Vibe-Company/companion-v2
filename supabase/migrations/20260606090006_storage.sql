-- Private bucket for skill package archives. Object key convention:
--   {org_id}/{skill_slug}/{version}.tar.gz   (tenant = first path segment)

insert into storage.buckets (id, name, public)
values ('skill-archives', 'skill-archives', false)
on conflict (id) do nothing;

-- Backs the read policy's storage_path -> skill_version lookup.
create index if not exists skill_versions_storage_path_idx on public.skill_versions (storage_path);

-- READ: tie object readability to SKILL visibility, not just org membership. An object is
-- readable iff its `skill_versions.storage_path` row is visible to the caller (skill_versions
-- RLS mirrors the skills visibility gate), so a same-org user cannot guess a private/team
-- archive path and bypass RLS.
create policy "skill archives read" on storage.objects for select to authenticated using (
  bucket_id = 'skill-archives'
  and exists (select 1 from public.skill_versions sv where sv.storage_path = name)
);

-- WRITE: org members may upload into their tenant prefix. (Capability nuance -- who may
-- create which skill -- is enforced by the publish RPC before the version row is written.)
create policy "skill archives write" on storage.objects for insert to authenticated with check (
  bucket_id = 'skill-archives'
  and app_member_of_org(((storage.foldername(name))[1])::uuid)
);

-- No UPDATE / DELETE policy: archives are immutable like skill_versions. Lifecycle
-- cleanup of orphaned uploads runs via the service role from a trusted server route.
