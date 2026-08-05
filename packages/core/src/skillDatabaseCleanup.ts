import { sql } from "drizzle-orm";
import { db, type Db } from "@companion/db";

export interface SkillDatabaseObjectDeletion {
  storageKey: string;
  claimToken: string;
}

export async function claimSkillDatabaseObjectDeletions(input: {
  limit?: number;
  leaseSeconds?: number;
  database?: Db;
} = {}): Promise<SkillDatabaseObjectDeletion[]> {
  const result = await (input.database ?? db).execute(sql`
    select "storageKey", "claimToken"
    from companion_claim_skill_database_object_deletions(
      ${input.limit ?? 100},
      ${input.leaseSeconds ?? 60}
    )
  `);
  return Array.from(result as unknown as Iterable<SkillDatabaseObjectDeletion>);
}

export async function completeSkillDatabaseObjectDeletion(input: {
  deletion: SkillDatabaseObjectDeletion;
  database?: Db;
}): Promise<boolean> {
  const result = await (input.database ?? db).execute(sql`
    select companion_complete_skill_database_object_deletion(
      ${input.deletion.storageKey},
      ${input.deletion.claimToken}::uuid
    ) as completed
  `);
  return Array.from(result as unknown as Iterable<{ completed: boolean }>)[0]?.completed ?? false;
}

export async function deferSkillDatabaseObjectDeletion(input: {
  deletion: SkillDatabaseObjectDeletion;
  database?: Db;
}): Promise<boolean> {
  const result = await (input.database ?? db).execute(sql`
    select companion_defer_skill_database_object_deletion(
      ${input.deletion.storageKey},
      ${input.deletion.claimToken}::uuid
    ) as deferred
  `);
  return Array.from(result as unknown as Iterable<{ deferred: boolean }>)[0]?.deferred ?? false;
}
