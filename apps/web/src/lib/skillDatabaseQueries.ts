"use client";

import type {
  SkillDatabaseAudience,
  SkillDatabaseDescribeResponse,
  SkillDatabaseSharesResponse,
  SkillDatabaseStatementResult,
} from "@companion/contracts";
import { apiFetch } from "./apiClient";

export interface SkillDatabaseRealmTarget {
  audience: SkillDatabaseAudience;
  realmId?: string;
}

function databasePath(slug: string, suffix = ""): string {
  return `/v1/skills/${encodeURIComponent(slug)}/database${suffix}`;
}

export function fetchSkillDatabase(slug: string): Promise<SkillDatabaseDescribeResponse> {
  return apiFetch<SkillDatabaseDescribeResponse>(databasePath(slug));
}

export function querySkillDatabase(
  slug: string,
  target: SkillDatabaseRealmTarget,
  sql: string,
  params: Array<string | number | boolean | null> = [],
): Promise<SkillDatabaseStatementResult> {
  return apiFetch<SkillDatabaseStatementResult>(databasePath(slug, "/query"), {
    method: "POST",
    body: JSON.stringify({
      audience: target.audience,
      ...(target.realmId !== undefined ? { realm_id: target.realmId } : {}),
      sql,
      params,
    }),
  });
}

export function executeSkillDatabase(
  slug: string,
  target: SkillDatabaseRealmTarget,
  sql: string,
  params: Array<string | number | boolean | null> = [],
): Promise<SkillDatabaseStatementResult> {
  return apiFetch<SkillDatabaseStatementResult>(databasePath(slug, "/execute"), {
    method: "POST",
    body: JSON.stringify({
      audience: target.audience,
      ...(target.realmId !== undefined ? { realm_id: target.realmId } : {}),
      sql,
      params,
    }),
  });
}

export function fetchSkillDatabaseShares(slug: string): Promise<SkillDatabaseSharesResponse> {
  return apiFetch<SkillDatabaseSharesResponse>(databasePath(slug, "/shares"));
}

export function setSkillDatabaseShares(
  slug: string,
  userIds: string[],
): Promise<SkillDatabaseSharesResponse> {
  return apiFetch<SkillDatabaseSharesResponse>(databasePath(slug, "/shares"), {
    method: "PUT",
    body: JSON.stringify({ user_ids: userIds }),
  });
}
