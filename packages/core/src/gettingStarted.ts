import { and, eq, isNull, sql } from "drizzle-orm";
import type {
  GettingStartedState,
  GettingStartedStep,
} from "@companion/contracts";
import { gettingStartedStateSchema } from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import type { ActorContext } from "./services";

type StateTimestamps = {
  companionInstalledAt: Date | null;
  localReviewedAt: Date | null;
  orgReviewedAt: Date | null;
  completedAt: Date | null;
  dismissedAt: Date | null;
};

const EMPTY_TIMESTAMPS: StateTimestamps = {
  companionInstalledAt: null,
  localReviewedAt: null,
  orgReviewedAt: null,
  completedAt: null,
  dismissedAt: null,
};

async function assertSelfMembership(database: Db, actor: ActorContext, orgId: string): Promise<void> {
  const membership = await database.query.memberships.findFirst({
    where: and(
      eq(schema.memberships.orgId, orgId),
      eq(schema.memberships.userId, actor.id),
    ),
    columns: { userId: true },
  });
  if (!membership) throw new Error("not a member of this organization");
}

const STEP_COLUMNS = {
  companion_install: {
    field: "companionInstalledAt",
    column: schema.gettingStartedStates.companionInstalledAt,
  },
  local_review: {
    field: "localReviewedAt",
    column: schema.gettingStartedStates.localReviewedAt,
  },
  org_review: {
    field: "orgReviewedAt",
    column: schema.gettingStartedStates.orgReviewedAt,
  },
} as const;

export function firstIncompleteGettingStartedStep(
  state: Pick<StateTimestamps, "companionInstalledAt" | "localReviewedAt" | "orgReviewedAt">,
): GettingStartedStep | null {
  if (!state.companionInstalledAt) return "companion_install";
  if (!state.localReviewedAt) return "local_review";
  if (!state.orgReviewedAt) return "org_review";
  return null;
}

export function isGettingStartedComplete(
  state: Pick<StateTimestamps, "companionInstalledAt" | "localReviewedAt" | "orgReviewedAt">,
): boolean {
  return firstIncompleteGettingStartedStep(state) === null;
}

function serializeState(state: StateTimestamps): GettingStartedState {
  const firstIncompleteStep = firstIncompleteGettingStartedStep(state);
  return gettingStartedStateSchema.parse({
    companion_installed_at: state.companionInstalledAt?.toISOString() ?? null,
    local_reviewed_at: state.localReviewedAt?.toISOString() ?? null,
    org_reviewed_at: state.orgReviewedAt?.toISOString() ?? null,
    completed_at: state.completedAt?.toISOString() ?? null,
    dismissed_at: state.dismissedAt?.toISOString() ?? null,
    completed: state.completedAt != null,
    first_incomplete_step: firstIncompleteStep,
  });
}

/**
 * Read the caller's own checklist state. The service deliberately accepts no foreign user id:
 * membership is checked once, and every row predicate is hard-keyed to `actor.id`, so an
 * administrator has no cross-user override.
 */
export async function getGettingStartedState(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<GettingStartedState> {
  const database = input.database ?? db;
  await assertSelfMembership(database, input.actor, input.orgId);
  const row = await database.query.gettingStartedStates.findFirst({
    where: and(
      eq(schema.gettingStartedStates.orgId, input.orgId),
      eq(schema.gettingStartedStates.userId, input.actor.id),
    ),
  });
  return serializeState(row ?? EMPTY_TIMESTAMPS);
}

/**
 * Set one checklist step exactly once, then set completion exactly once in the same transaction.
 * Retried and concurrent calls cannot regress or move any recorded timestamp.
 */
export async function recordGettingStartedStep(input: {
  actor: ActorContext;
  orgId: string;
  step: GettingStartedStep;
  agent?: string | null;
  database?: Db;
}): Promise<GettingStartedState> {
  const database = input.database ?? db;
  const agent = input.agent?.trim() || null;
  return database.transaction(async (tx) => {
    const transaction = tx as unknown as Db;
    await assertSelfMembership(transaction, input.actor, input.orgId);
    const now = new Date();
    const { field: stepField, column: stepColumn } = STEP_COLUMNS[input.step];

    await transaction
      .insert(schema.gettingStartedStates)
      .values({
        orgId: input.orgId,
        userId: input.actor.id,
        [stepField]: now,
      })
      .onConflictDoUpdate({
        target: [schema.gettingStartedStates.orgId, schema.gettingStartedStates.userId],
        set: {
          [stepField]: sql`COALESCE(${stepColumn}, excluded.${sql.identifier(stepColumn.name)})`,
          updatedAt: now,
        },
      });

    await transaction.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      privateToUserId: input.actor.id,
      action: "getting_started.step",
      targetType: "getting_started",
      targetId: input.actor.id,
      metadata: { step: input.step, agent },
    });

    const completedRows = await transaction
      .update(schema.gettingStartedStates)
      .set({ completedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.gettingStartedStates.orgId, input.orgId),
          eq(schema.gettingStartedStates.userId, input.actor.id),
          isNull(schema.gettingStartedStates.completedAt),
          sql`${schema.gettingStartedStates.companionInstalledAt} IS NOT NULL`,
          sql`${schema.gettingStartedStates.localReviewedAt} IS NOT NULL`,
          sql`${schema.gettingStartedStates.orgReviewedAt} IS NOT NULL`,
        ),
      )
      .returning({ completedAt: schema.gettingStartedStates.completedAt });

    if (completedRows.length > 0) {
      await transaction.insert(schema.auditLog).values({
        orgId: input.orgId,
        actorId: input.actor.id,
        privateToUserId: input.actor.id,
        action: "getting_started.complete",
        targetType: "getting_started",
        targetId: input.actor.id,
        metadata: {},
      });
    }

    const row = await transaction.query.gettingStartedStates.findFirst({
      where: and(
        eq(schema.gettingStartedStates.orgId, input.orgId),
        eq(schema.gettingStartedStates.userId, input.actor.id),
      ),
    });
    if (!row) throw new Error("could not record getting-started state");
    return serializeState(row);
  });
}

async function setDismissal(input: {
  actor: ActorContext;
  orgId: string;
  dismissed: boolean;
  database?: Db;
}): Promise<GettingStartedState> {
  const database = input.database ?? db;
  return database.transaction(async (tx) => {
    const transaction = tx as unknown as Db;
    await assertSelfMembership(transaction, input.actor, input.orgId);
    const now = new Date();
    const dismissedAt = input.dismissed ? now : null;
    await transaction
      .insert(schema.gettingStartedStates)
      .values({
        orgId: input.orgId,
        userId: input.actor.id,
        dismissedAt,
      })
      .onConflictDoUpdate({
        target: [schema.gettingStartedStates.orgId, schema.gettingStartedStates.userId],
        set: { dismissedAt, updatedAt: now },
      });
    await transaction.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      privateToUserId: input.actor.id,
      action: input.dismissed ? "getting_started.dismiss" : "getting_started.reopen",
      targetType: "getting_started",
      targetId: input.actor.id,
      metadata: {},
    });
    const row = await transaction.query.gettingStartedStates.findFirst({
      where: and(
        eq(schema.gettingStartedStates.orgId, input.orgId),
        eq(schema.gettingStartedStates.userId, input.actor.id),
      ),
    });
    if (!row) throw new Error("could not update getting-started state");
    return serializeState(row);
  });
}

export function dismissGettingStarted(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<GettingStartedState> {
  return setDismissal({ ...input, dismissed: true });
}

export function reopenGettingStarted(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<GettingStartedState> {
  return setDismissal({ ...input, dismissed: false });
}
