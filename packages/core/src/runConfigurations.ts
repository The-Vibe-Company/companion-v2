import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type {
  CreateRunConfigurationInput,
  DeleteRunConfigurationInput,
  RunConfiguration,
  RunConfigurationIssue,
  RunInputSelection,
  RunOptions,
  UpdateRunConfigurationInput,
} from "@companion/contracts";
import { getActivatedModelSets } from "./modelPreferences";
import { resolveProviderCredentialPin } from "./providerConnections";
import {
  RunBusyError,
  RunValidationError,
  loadRunDeclarations,
  resolveRunDependencyClosure,
  resolveRunRuntimeContext,
  validateRunInputSelection,
  type ResolvedRunDeclarations,
  type ResolvedRunSkill,
  type RunControlContext,
} from "./skillRuns";
import { assertMember, type ActorContext } from "./services";

type ConfigRow = typeof schema.skillRunConfigs.$inferSelect;

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505",
  );
}

async function currentClosure(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database: Db;
}): Promise<ResolvedRunSkill[]> {
  const rows = await input.database
    .select({ currentVersionId: schema.skills.currentVersionId })
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, input.slug)));
  const versionId = rows[0]?.currentVersionId;
  if (!versionId) throw new RunValidationError("skill not found", "skill_not_found");
  return resolveRunDependencyClosure({ ...input, skillVersionId: versionId });
}

async function loadConfigInputs(input: {
  orgId: string;
  configIds: string[];
  database: Db;
}): Promise<Map<string, RunInputSelection>> {
  const result = new Map<string, RunInputSelection>(
    input.configIds.map((id) => [id, { secrets: [], variables: [] }]),
  );
  if (input.configIds.length === 0) return result;
  const [secretRows, variableRows] = await Promise.all([
    input.database
      .select()
      .from(schema.skillRunConfigSecrets)
      .where(
        and(
          eq(schema.skillRunConfigSecrets.orgId, input.orgId),
          inArray(schema.skillRunConfigSecrets.configId, input.configIds),
        ),
      ),
    input.database
      .select()
      .from(schema.skillRunConfigVariables)
      .where(
        and(
          eq(schema.skillRunConfigVariables.orgId, input.orgId),
          inArray(schema.skillRunConfigVariables.configId, input.configIds),
        ),
      ),
  ]);
  for (const row of secretRows) {
    result.get(row.configId)?.secrets.push({
      skill_id: row.skillId,
      slot_id: row.slotId,
      secret_id: row.secretId,
    });
  }
  for (const row of variableRows) {
    result.get(row.configId)?.variables.push({
      skill_id: row.skillId,
      env_key: row.envKey,
      value: row.value,
    });
  }
  for (const selection of result.values()) {
    selection.secrets.sort((a, b) =>
      `${a.skill_id}:${a.slot_id}`.localeCompare(`${b.skill_id}:${b.slot_id}`),
    );
    selection.variables.sort((a, b) =>
      `${a.skill_id}:${a.env_key}`.localeCompare(`${b.skill_id}:${b.env_key}`),
    );
  }
  return result;
}

function issue(
  code: string,
  message: string,
  fields: Partial<Pick<RunConfigurationIssue, "skill_id" | "slot_id" | "env_key">> = {},
): RunConfigurationIssue {
  return {
    code,
    message,
    skill_id: fields.skill_id ?? null,
    slot_id: fields.slot_id ?? null,
    env_key: fields.env_key ?? null,
  };
}

async function inspectConfiguration(input: {
  actor: ActorContext;
  orgId: string;
  row: ConfigRow;
  selection: RunInputSelection;
  declarations: ResolvedRunDeclarations;
  activated: Set<string>;
  ctx: RunControlContext;
  database: Db;
}): Promise<RunConfigurationIssue[]> {
  const issues: RunConfigurationIssue[] = [];
  const selectedSecretKeys = new Set(
    input.selection.secrets.map((selection) => `${selection.skill_id}:${selection.slot_id}`),
  );
  const selectedVariableKeys = new Set(
    input.selection.variables.map((selection) => `${selection.skill_id}:${selection.env_key}`),
  );
  for (const declaration of input.declarations.secrets) {
    if (declaration.required && !selectedSecretKeys.has(`${declaration.skill_id}:${declaration.slot_id}`)) {
      issues.push(
        issue("required_secret_missing", `${declaration.env_key} is required`, {
          skill_id: declaration.skill_id,
          slot_id: declaration.slot_id,
          env_key: declaration.env_key,
        }),
      );
    }
  }
  for (const declaration of input.declarations.variables) {
    if (declaration.required && !selectedVariableKeys.has(`${declaration.skill_id}:${declaration.env_key}`)) {
      issues.push(
        issue("required_variable_missing", `${declaration.env_key} is required`, {
          skill_id: declaration.skill_id,
          env_key: declaration.env_key,
        }),
      );
    }
  }
  if (!input.activated.has(input.row.model)) {
    issues.push(issue("model_not_activated", "The saved model is not activated."));
  }
  const model = await input.ctx.resolveModelKeys(input.row.model);
  if (!model) {
    issues.push(issue("model_unavailable", "The saved model is no longer available."));
    return issues;
  }
  try {
    await validateRunInputSelection({
      actor: input.actor,
      orgId: input.orgId,
      model: input.row.model,
      modelEnvKeys: model.envKeys,
      selection: input.selection,
      declarations: input.declarations,
      database: input.database,
      allowMissingRequired: true,
      requireExplicitProviderSelection: false,
    });
  } catch (error) {
    const code = error instanceof RunValidationError ? error.code : "configuration_invalid";
    const message =
      code === "secret_unavailable"
        ? "Secret unavailable"
        : error instanceof Error
          ? error.message
          : "This configuration needs attention.";
    if (!issues.some((candidate) => candidate.code === code)) issues.push(issue(code, message));
  }
  if (input.ctx.runtimeAvailable === false || !input.ctx.goldenSnapshotId) {
    issues.push(issue("runtime_unavailable", input.ctx.runtimeMessage ?? "RunSkill is not configured."));
  }
  return issues;
}

async function mapConfigurations(input: {
  actor: ActorContext;
  orgId: string;
  skillSlug: string;
  rows: ConfigRow[];
  declarations: ResolvedRunDeclarations;
  ctx: RunControlContext;
  database: Db;
}): Promise<RunConfiguration[]> {
  const ctx = await resolveRunRuntimeContext(input.ctx, input.database);
  const inputs = await loadConfigInputs({
    orgId: input.orgId,
    configIds: input.rows.map((row) => row.id),
    database: input.database,
  });
  const activatedRows = await getActivatedModelSets({
    database: input.database,
    orgId: input.orgId,
    userId: input.actor.id,
  });
  const activated = new Set([...activatedRows.personal, ...activatedRows.org]);
  return Promise.all(
    input.rows.map(async (row) => {
      const selection = inputs.get(row.id) ?? { secrets: [], variables: [] };
      const issues = await inspectConfiguration({
        ...input,
        ctx,
        row,
        selection,
        activated,
      });
      return {
        id: row.id,
        skill_id: row.skillId,
        skill_slug: input.skillSlug,
        name: row.name,
        model: row.model,
        revision: row.revision,
        is_default: row.isDefault,
        status: issues.length === 0 ? "ready" : "needs_attention",
        issues,
        inputs: selection,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
        last_used_at: row.lastUsedAt?.toISOString() ?? null,
      } satisfies RunConfiguration;
    }),
  );
}

async function listConfigRows(input: {
  actor: ActorContext;
  orgId: string;
  skillId: string;
  database: Db;
}): Promise<ConfigRow[]> {
  return input.database
    .select()
    .from(schema.skillRunConfigs)
    .where(
      and(
        eq(schema.skillRunConfigs.orgId, input.orgId),
        eq(schema.skillRunConfigs.creatorId, input.actor.id),
        eq(schema.skillRunConfigs.skillId, input.skillId),
      ),
    )
    .orderBy(asc(schema.skillRunConfigs.name));
}

export async function listRunConfigurations(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  ctx: RunControlContext;
  database?: Db;
}): Promise<RunConfiguration[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const closure = await currentClosure({ ...input, database });
  const root = closure[0]!;
  const declarations = await loadRunDeclarations({
    actor: input.actor,
    orgId: input.orgId,
    closure,
    database,
  });
  const rows = await listConfigRows({ ...input, skillId: root.skill_id, database });
  return mapConfigurations({
    actor: input.actor,
    orgId: input.orgId,
    skillSlug: root.slug,
    rows,
    declarations,
    ctx: input.ctx,
    database,
  });
}

async function validateConfigurationSelection(input: {
  actor: ActorContext;
  orgId: string;
  model: string;
  selection: RunInputSelection;
  declarations: ResolvedRunDeclarations;
  ctx: RunControlContext;
  database: Db;
}): Promise<void> {
  const model = await input.ctx.resolveModelKeys(input.model);
  if (!model) throw new RunValidationError("the selected model is unavailable", "model_unavailable");
  await validateRunInputSelection({
    actor: input.actor,
    orgId: input.orgId,
    model: input.model,
    modelEnvKeys: model.envKeys,
    selection: input.selection,
    declarations: input.declarations,
    database: input.database,
    allowMissingRequired: true,
    providerRequired: false,
    requireExplicitProviderSelection: false,
  });
}

async function replaceConfigInputs(input: {
  orgId: string;
  configId: string;
  selection: RunInputSelection;
  database: Db;
}): Promise<void> {
  await input.database
    .delete(schema.skillRunConfigSecrets)
    .where(
      and(
        eq(schema.skillRunConfigSecrets.orgId, input.orgId),
        eq(schema.skillRunConfigSecrets.configId, input.configId),
      ),
    );
  await input.database
    .delete(schema.skillRunConfigVariables)
    .where(
      and(
        eq(schema.skillRunConfigVariables.orgId, input.orgId),
        eq(schema.skillRunConfigVariables.configId, input.configId),
      ),
    );
  if (input.selection.secrets.length > 0) {
    await input.database.insert(schema.skillRunConfigSecrets).values(
      input.selection.secrets.map((selection) => ({
        orgId: input.orgId,
        configId: input.configId,
        skillId: selection.skill_id,
        slotId: selection.slot_id,
        secretId: selection.secret_id,
      })),
    );
  }
  if (input.selection.variables.length > 0) {
    await input.database.insert(schema.skillRunConfigVariables).values(
      input.selection.variables.map((selection) => ({
        orgId: input.orgId,
        configId: input.configId,
        skillId: selection.skill_id,
        envKey: selection.env_key,
        value: selection.value,
      })),
    );
  }
}

export async function createRunConfiguration(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  value: CreateRunConfigurationInput;
  ctx: RunControlContext;
  database?: Db;
}): Promise<RunConfiguration> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const closure = await currentClosure({ ...input, database });
  const root = closure[0]!;
  const declarations = await loadRunDeclarations({
    actor: input.actor,
    orgId: input.orgId,
    closure,
    database,
  });
  await validateConfigurationSelection({
    actor: input.actor,
    orgId: input.orgId,
    model: input.value.model,
    selection: input.value.inputs,
    declarations,
    ctx: input.ctx,
    database,
  });

  try {
    const row = await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      if (input.value.is_default) {
        await tx
          .update(schema.skillRunConfigs)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.skillRunConfigs.orgId, input.orgId),
              eq(schema.skillRunConfigs.creatorId, input.actor.id),
              eq(schema.skillRunConfigs.skillId, root.skill_id),
              eq(schema.skillRunConfigs.isDefault, true),
            ),
          );
      }
      const inserted = await tx
        .insert(schema.skillRunConfigs)
        .values({
          orgId: input.orgId,
          skillId: root.skill_id,
          creatorId: input.actor.id,
          name: input.value.name.trim(),
          model: input.value.model,
          isDefault: input.value.is_default,
        })
        .returning();
      const created = inserted[0];
      if (!created) throw new Error("configuration insert returned no row");
      await replaceConfigInputs({
        orgId: input.orgId,
        configId: created.id,
        selection: input.value.inputs,
        database: tx,
      });
      await tx.insert(schema.auditLog).values({
        orgId: input.orgId,
        actorId: input.actor.id,
        action: "skill.run_configuration.create",
        targetType: "skill_run_config",
        targetId: created.id,
        metadata: { skill_id: root.skill_id },
      });
      return created;
    });
    const mapped = await mapConfigurations({
      actor: input.actor,
      orgId: input.orgId,
      skillSlug: root.slug,
      rows: [row],
      declarations,
      ctx: input.ctx,
      database,
    });
    return mapped[0]!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RunBusyError("a configuration with this name already exists", "configuration_name_conflict");
    }
    throw error;
  }
}

async function ownedConfig(input: {
  actor: ActorContext;
  orgId: string;
  configId: string;
  database: Db;
}): Promise<ConfigRow> {
  const rows = await input.database
    .select()
    .from(schema.skillRunConfigs)
    .where(
      and(
        eq(schema.skillRunConfigs.orgId, input.orgId),
        eq(schema.skillRunConfigs.id, input.configId),
        eq(schema.skillRunConfigs.creatorId, input.actor.id),
      ),
    );
  const row = rows[0];
  if (!row) throw new RunValidationError("run configuration not found", "configuration_not_found");
  return row;
}

export async function updateRunConfiguration(input: {
  actor: ActorContext;
  orgId: string;
  configId: string;
  value: UpdateRunConfigurationInput;
  ctx: RunControlContext;
  database?: Db;
}): Promise<RunConfiguration> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const existing = await ownedConfig({ ...input, database });
  const skillRows = await database
    .select({ slug: schema.skills.slug, currentVersionId: schema.skills.currentVersionId })
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.id, existing.skillId)));
  const skill = skillRows[0];
  if (!skill?.currentVersionId) throw new RunValidationError("skill not found", "skill_not_found");
  const closure = await resolveRunDependencyClosure({
    actor: input.actor,
    orgId: input.orgId,
    slug: skill.slug,
    skillVersionId: skill.currentVersionId,
    database,
  });
  const declarations = await loadRunDeclarations({
    actor: input.actor,
    orgId: input.orgId,
    closure,
    database,
  });
  const priorInputs = (await loadConfigInputs({ orgId: input.orgId, configIds: [existing.id], database })).get(
    existing.id,
  ) ?? { secrets: [], variables: [] };
  const nextInputs = input.value.inputs ?? priorInputs;
  const nextModel = input.value.model ?? existing.model;
  // A living configuration can become invalid after a secret revocation or manifest/model change.
  // Metadata-only actions (rename/default) must remain available so the user is never trapped with
  // an undeletable/unrenameable "Needs attention" row. Revalidate whenever executable inputs move.
  if (input.value.inputs !== undefined || input.value.model !== undefined) {
    await validateConfigurationSelection({
      actor: input.actor,
      orgId: input.orgId,
      model: nextModel,
      selection: nextInputs,
      declarations,
      ctx: input.ctx,
      database,
    });
  }

  try {
    const updated = await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      if (input.value.is_default === true) {
        await tx
          .update(schema.skillRunConfigs)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.skillRunConfigs.orgId, input.orgId),
              eq(schema.skillRunConfigs.creatorId, input.actor.id),
              eq(schema.skillRunConfigs.skillId, existing.skillId),
              ne(schema.skillRunConfigs.id, existing.id),
              eq(schema.skillRunConfigs.isDefault, true),
            ),
          );
      }
      const rows = await tx
        .update(schema.skillRunConfigs)
        .set({
          ...(input.value.name !== undefined ? { name: input.value.name.trim() } : {}),
          ...(input.value.model !== undefined ? { model: input.value.model } : {}),
          ...(input.value.is_default !== undefined ? { isDefault: input.value.is_default } : {}),
          revision: existing.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.skillRunConfigs.orgId, input.orgId),
            eq(schema.skillRunConfigs.id, existing.id),
            eq(schema.skillRunConfigs.creatorId, input.actor.id),
            eq(schema.skillRunConfigs.revision, input.value.revision),
          ),
        )
        .returning();
      const row = rows[0];
      if (!row) {
        throw new RunBusyError("the configuration changed; reload it and try again", "configuration_revision_conflict");
      }
      if (input.value.inputs !== undefined) {
        await replaceConfigInputs({ orgId: input.orgId, configId: row.id, selection: nextInputs, database: tx });
      }
      await tx.insert(schema.auditLog).values({
        orgId: input.orgId,
        actorId: input.actor.id,
        action: "skill.run_configuration.update",
        targetType: "skill_run_config",
        targetId: row.id,
        metadata: { revision: row.revision },
      });
      return row;
    });
    const mapped = await mapConfigurations({
      actor: input.actor,
      orgId: input.orgId,
      skillSlug: skill.slug,
      rows: [updated],
      declarations,
      ctx: input.ctx,
      database,
    });
    return mapped[0]!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RunBusyError("a configuration with this name already exists", "configuration_name_conflict");
    }
    throw error;
  }
}

export async function deleteRunConfiguration(input: {
  actor: ActorContext;
  orgId: string;
  configId: string;
  value: DeleteRunConfigurationInput;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const configs = await tx
      .select({ id: schema.skillRunConfigs.id })
      .from(schema.skillRunConfigs)
      .where(
        and(
          eq(schema.skillRunConfigs.orgId, input.orgId),
          eq(schema.skillRunConfigs.id, input.configId),
          eq(schema.skillRunConfigs.creatorId, input.actor.id),
          eq(schema.skillRunConfigs.revision, input.value.revision),
        ),
      )
      .for("update");
    if (!configs[0]) {
      throw new RunBusyError("the configuration changed; reload it and try again", "configuration_revision_conflict");
    }
    // Historical runs keep the immutable name/model/input snapshots, but a live FK must not make
    // an otherwise personal saved configuration undeletable after its first use. The transaction
    // rolls this detachment back if the optimistic revision check below loses a race.
    await tx
      .update(schema.skillRuns)
      .set({ runConfigId: null, updatedAt: new Date() })
      .where(
        and(
          eq(schema.skillRuns.orgId, input.orgId),
          eq(schema.skillRuns.runConfigId, input.configId),
          eq(schema.skillRuns.creatorId, input.actor.id),
        ),
      );
    const rows = await tx
      .delete(schema.skillRunConfigs)
      .where(
        and(
          eq(schema.skillRunConfigs.orgId, input.orgId),
          eq(schema.skillRunConfigs.id, input.configId),
          eq(schema.skillRunConfigs.creatorId, input.actor.id),
          eq(schema.skillRunConfigs.revision, input.value.revision),
        ),
      )
      .returning({ id: schema.skillRunConfigs.id });
    if (!rows[0]) {
      throw new RunBusyError("the configuration changed; reload it and try again", "configuration_revision_conflict");
    }
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "skill.run_configuration.delete",
      targetType: "skill_run_config",
      targetId: input.configId,
    });
  });
}

export async function getRunOptions(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  ctx: RunControlContext;
  database?: Db;
}): Promise<RunOptions> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const ctx = await resolveRunRuntimeContext(input.ctx, database);
  const closure = await currentClosure({ ...input, database });
  const root = closure[0]!;
  const declarations = await loadRunDeclarations({
    actor: input.actor,
    orgId: input.orgId,
    closure,
    database,
    includeCandidates: true,
  });
  const configRows = await listConfigRows({ ...input, skillId: root.skill_id, database });
  const configurations = await mapConfigurations({
    actor: input.actor,
    orgId: input.orgId,
    skillSlug: root.slug,
    rows: configRows,
    declarations,
    ctx,
    database,
  });
  const activatedRows = await getActivatedModelSets({
    database,
    orgId: input.orgId,
    userId: input.actor.id,
  });
  const activated = new Set([...activatedRows.personal, ...activatedRows.org]);
  const catalog = (ctx.models ?? []).filter((model) => activated.has(model.id));
  const providerPins = new Map<string, Awaited<ReturnType<typeof resolveProviderCredentialPin>>>();
  const models: RunOptions["models"] = [];
  for (const model of catalog) {
    let pin = providerPins.get(model.provider);
    if (pin === undefined) {
      try {
        pin = await resolveProviderCredentialPin({
          actor: input.actor,
          orgId: input.orgId,
          provider: model.provider,
          database,
        });
      } catch {
        pin = null;
      }
      providerPins.set(model.provider, pin);
    }
    const runtimeUnavailable = ctx.runtimeAvailable === false || !ctx.goldenSnapshotId;
    const connected = Boolean(pin && model.env_keys.includes(pin.keyName));
    models.push({
      model,
      readiness: runtimeUnavailable ? "runtime_unavailable" : connected ? "ready" : "provider_disconnected",
      message: runtimeUnavailable
        ? ctx.runtimeMessage ?? "RunSkill is not configured."
        : connected
          ? null
          : "Connect this model provider in Settings → Models.",
      provider_credential_pin:
        connected && pin
          ? {
              env_key: pin.keyName,
              connection_id: pin.connectionId,
              credential_version: pin.credentialVersion,
              scope: pin.scope,
            }
          : null,
    });
  }
  const dependency = (skill: ResolvedRunSkill) => ({
    skill_id: skill.skill_id,
    skill_version_id: skill.skill_version_id,
    slug: skill.slug,
    version: skill.version,
    root: skill.root,
    depth: skill.depth,
    via: skill.via,
  });
  return {
    root: dependency(root),
    dependencies: closure.slice(1).map(dependency),
    declared_secrets: declarations.secrets,
    declared_variables: declarations.variables,
    configurations,
    models,
    runtime: {
      available: ctx.runtimeAvailable !== false && Boolean(ctx.goldenSnapshotId),
      message:
        ctx.runtimeAvailable !== false && ctx.goldenSnapshotId
          ? null
          : ctx.runtimeMessage ?? "RunSkill is not configured.",
    },
  };
}
