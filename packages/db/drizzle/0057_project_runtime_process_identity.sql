CREATE OR REPLACE FUNCTION companion_project_row_visible(
  p_org_id uuid,
  p_project_id uuid,
  p_creator_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT (
    -- app.org_id/app.user_id are request context, not process identity. Require the API-only
    -- pre-tenant capability as well so a split worker login cannot spoof creator visibility.
    pg_catalog.has_function_privilege(
      current_user,
      'public.companion_list_user_orgs(text)',
      'EXECUTE'
    )
    AND coalesce(current_setting('app.project_worker', true), '') <> 'exact_lease'
    AND p_org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    AND p_creator_id = NULLIF(current_setting('app.user_id', true), '')
    AND EXISTS (
      SELECT 1 FROM public."memberships" m
      WHERE m."org_id" = p_org_id AND m."user_id" = p_creator_id
    )
  )
  OR companion_project_exact_lease_visible(p_org_id, p_project_id, p_creator_id)
  OR (
    companion_project_policy_definer()
    AND current_setting('app.project_worker', true) IN (
      'claim',
      'enter_lease',
      'skill_refresh',
      'secret_signal',
      'provider_signal',
      'member_cleanup',
      'usage_aggregate',
      'attachment_orphan'
    )
  )
$$;--> statement-breakpoint

DROP POLICY "sandbox_usage_sessions_tenant_or_project_creator_rls"
ON "sandbox_usage_sessions";--> statement-breakpoint
CREATE POLICY "sandbox_usage_sessions_tenant_or_project_creator_rls"
ON "sandbox_usage_sessions"
USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND (
    "kind"::text <> 'project'
    OR (
      (
        pg_catalog.has_function_privilege(
          current_user,
          'public.companion_list_user_orgs(text)',
          'EXECUTE'
        )
        AND "creator_id" = NULLIF(current_setting('app.user_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public."memberships" membership
          WHERE membership."org_id" = "sandbox_usage_sessions"."org_id"
            AND membership."user_id" = "sandbox_usage_sessions"."creator_id"
        )
        AND EXISTS (
          SELECT 1
          FROM public."projects" project
          WHERE project."org_id" = "sandbox_usage_sessions"."org_id"
            AND project."id" = "sandbox_usage_sessions"."source_id"
            AND project."creator_id" = "sandbox_usage_sessions"."creator_id"
        )
      )
      OR (
        current_setting('app.project_worker', true) = 'exact_lease'
        AND companion_project_row_visible(
          "org_id",
          "source_id",
          "creator_id"
        )
      )
      OR (
        companion_project_policy_definer()
        AND current_setting('app.project_worker', true) = 'usage_aggregate'
      )
    )
  )
)
WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND (
    "kind"::text <> 'project'
    OR (
      (
        pg_catalog.has_function_privilege(
          current_user,
          'public.companion_list_user_orgs(text)',
          'EXECUTE'
        )
        AND "creator_id" = NULLIF(current_setting('app.user_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public."memberships" membership
          WHERE membership."org_id" = "sandbox_usage_sessions"."org_id"
            AND membership."user_id" = "sandbox_usage_sessions"."creator_id"
        )
        AND EXISTS (
          SELECT 1
          FROM public."projects" project
          WHERE project."org_id" = "sandbox_usage_sessions"."org_id"
            AND project."id" = "sandbox_usage_sessions"."source_id"
            AND project."creator_id" = "sandbox_usage_sessions"."creator_id"
        )
      )
      OR (
        current_setting('app.project_worker', true) = 'exact_lease'
        AND companion_project_row_visible(
          "org_id",
          "source_id",
          "creator_id"
        )
      )
      OR (
        companion_project_policy_definer()
        AND current_setting('app.project_worker', true) = 'usage_aggregate'
      )
    )
  )
);
