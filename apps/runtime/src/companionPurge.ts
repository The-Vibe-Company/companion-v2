/**
 * One-shot legacy Companion cutover command.
 *
 * This is an offline maintenance entrypoint owned by the runtime package, not part of the runtime
 * daemon. It owns the deliberately narrow bridge between legacy rows and Box's permanent-delete API:
 * provider deletion is durably journalled and completed first; one short SQL function then removes
 * every legacy row atomically. See the Runtime v2 cutover runbook in deploy/railway/README.md.
 */
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  AsciiBoxMaintenanceClient,
  BoxRuntimeProviderError,
  type BoxDeletionOperation,
  type BoxDeletionStatus,
  type BoxMaintenanceBox,
  type BoxMaintenanceClient,
} from "@companion/box-runtime";
import postgres from "postgres";

export const LEGACY_COMPANION_PURGE_RUN_ID = "legacy-companion-purge";
// Must stay identical to apps/api/src/migrate.ts. Importing that executable module into another
// bundled entrypoint would also run its `import.meta.url` main guard from this output file.
export const COMPANION_PURGE_LOCK_CLASS_ID = 72_401;
export const COMPANION_PURGE_LOCK_OBJECT_ID = 20_260_608;
const DEFAULT_DELETE_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DELETE_TIMEOUT_MS = 15 * 60_000;
const MAX_DISCOVERY_ROUNDS = 20;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_VALUE = new RegExp(`^${UUID_PATTERN}$`);
const COMPANION_BOX_NAME = new RegExp(`^Companion (${UUID_PATTERN})$`);
const ORG_BOX_NAME = new RegExp(`^Companion org (${UUID_PATTERN})$`);
const RETIRED_BOX_NAME = /^Retired (Companion .+) ([0-9]+)$/;

export type PurgeSql = ReturnType<typeof postgres>;
export type CompanionPurgeInvocation =
  | { command: "report"; dryRun: false; confirmed: false }
  | { command: "purge"; dryRun: true; confirmed: false }
  | { command: "purge"; dryRun: false; confirmed: true };

export type LegacyBoxNameKind =
  | "companion"
  | "org"
  | "personal"
  | "retired-companion"
  | "retired-org"
  | "retired-personal";

export interface LegacyDatabaseInventory {
  companions: Array<{ id: string; boxId: string | null }>;
  pools: Array<{
    id: string;
    scope: "personal" | "org";
    ownerId: string | null;
    boxId: string | null;
  }>;
  personalOwnerIds: string[];
  rowCounts: LegacyRowCounts;
}

export interface LegacyRowCounts {
  companions: number;
  runtimePools: number;
  workspaceAccess: number;
  memberState: number;
  threads: number;
  transcriptEntries: number;
  reconcileLeases: number;
  companionTokens: number;
}

export interface LegacyPurgeTarget {
  boxId: string;
  observedName: string | null;
  evidence: string[];
  providerPresent: boolean;
}

export interface LegacyPurgeInventory {
  database: LegacyDatabaseInventory;
  providerBoxCount: number;
  targets: LegacyPurgeTarget[];
  excludedProviderBoxes: Array<{ boxId: string; name: string }>;
  hash: string;
}

export type LegacyPurgeTargetState =
  | "discovered"
  | "requesting"
  | BoxDeletionStatus
  | "absent";

export interface LegacyPurgeLedgerTarget {
  boxId: string;
  observedName: string | null;
  evidence: string[];
  state: LegacyPurgeTargetState;
  operationId: string | null;
  attemptCount: number;
  lastError: string | null;
}

interface LegacyPurgeRun {
  phase: "deleting_external" | "external_complete" | "database_complete";
}

export const PRESERVED_DATA_CATEGORIES = [
  "organizations, memberships, users, profiles, sessions, accounts, and invitations",
  "Companion provider connections and encrypted credential generations",
  "member MCP accounts and encrypted credentials",
  "Skills, versions, dependencies, labels, installs, comments, releases, and Skill Databases",
  "secret slots, bindings, encrypted versions, recipients, and retrieval state",
  "billing subscriptions and webhook history",
  "audit_log, including historical Companion references",
  "human and Agent Auth PATs plus delegated Agent Auth identities and grants",
] as const;

function usage(): string {
  return "usage: node dist/companionPurge.js report | purge --dry-run | purge --confirm-delete-all-companions";
}

export function parseCompanionPurgeArgs(argv: readonly string[]): CompanionPurgeInvocation {
  if (argv.length === 1 && argv[0] === "report") {
    return { command: "report", dryRun: false, confirmed: false };
  }
  if (argv.length === 2 && argv[0] === "purge" && argv[1] === "--dry-run") {
    return { command: "purge", dryRun: true, confirmed: false };
  }
  if (
    argv.length === 2
    && argv[0] === "purge"
    && argv[1] === "--confirm-delete-all-companions"
  ) {
    return { command: "purge", dryRun: false, confirmed: true };
  }
  throw new Error(usage());
}

/** The command never falls back to the ordinary API role. */
export function companionPurgeDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DATABASE_MIGRATION_URL?.trim();
  if (!value) throw new Error("DATABASE_MIGRATION_URL is required for the legacy Companion purge");
  return value;
}

/** Normalized explicit false is required even when an empty allowlist would make the product gate false. */
export function assertCompanionPurgeDisabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env.COMPANION_COMPANIONS_ENABLED?.trim().toLowerCase() !== "false") {
    throw new Error(
      "COMPANION_COMPANIONS_ENABLED must be explicitly set to false before the legacy Companion purge",
    );
  }
}

function directLegacyBoxNameKind(
  name: string,
  personalOwnerIds: ReadonlySet<string>,
): Exclude<LegacyBoxNameKind, `retired-${string}`> | null {
  if (COMPANION_BOX_NAME.test(name)) return "companion";
  if (ORG_BOX_NAME.test(name)) return "org";
  if (name.startsWith("Companion personal ")) {
    const ownerId = name.slice("Companion personal ".length);
    // Better Auth has always generated production user ids with crypto.randomUUID(). Accepting the
    // canonical shape recovers an orphaned personal Box even after its user row was deleted. Exact
    // current DB ids additionally cover fixtures/imports without broadening arbitrary orphan names.
    if (ownerId !== "" && (UUID_VALUE.test(ownerId) || personalOwnerIds.has(ownerId))) {
      return "personal";
    }
  }
  return null;
}

/** Match only the three historical names and their exact `Retired ... <digits>` variants. */
export function recognizeLegacyCompanionBoxName(
  name: string,
  personalOwnerIds: ReadonlySet<string>,
): LegacyBoxNameKind | null {
  const direct = directLegacyBoxNameKind(name, personalOwnerIds);
  if (direct) return direct;
  const retired = RETIRED_BOX_NAME.exec(name);
  if (!retired) return null;
  const base = directLegacyBoxNameKind(retired[1]!, personalOwnerIds);
  return base ? `retired-${base}` as LegacyBoxNameKind : null;
}

function looksLegacy(name: string): boolean {
  return name.startsWith("Companion ") || name.startsWith("Retired Companion ");
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function addTarget(
  targets: Map<string, { observedName: string | null; evidence: Set<string>; providerPresent: boolean }>,
  input: LegacyPurgeTarget,
): void {
  const current = targets.get(input.boxId);
  if (current) {
    for (const evidence of input.evidence) current.evidence.add(evidence);
    if (input.observedName !== null) current.observedName = input.observedName;
    current.providerPresent ||= input.providerPresent;
    return;
  }
  targets.set(input.boxId, {
    observedName: input.observedName,
    evidence: new Set(input.evidence),
    providerPresent: input.providerPresent,
  });
}

/** Union DB-owned Box ids with provider Boxes carrying one of the six exact historical names. */
export function buildLegacyPurgeInventory(
  database: LegacyDatabaseInventory,
  providerBoxes: readonly BoxMaintenanceBox[],
): LegacyPurgeInventory {
  const providerById = new Map(providerBoxes.map((box) => [box.id, box]));
  const targets = new Map<
    string,
    { observedName: string | null; evidence: Set<string>; providerPresent: boolean }
  >();

  for (const companion of database.companions) {
    if (!companion.boxId) continue;
    const provider = providerById.get(companion.boxId);
    addTarget(targets, {
      boxId: companion.boxId,
      observedName: provider?.name ?? null,
      evidence: [`database:companion:${companion.id}`],
      providerPresent: provider !== undefined,
    });
  }
  for (const pool of database.pools) {
    if (!pool.boxId) continue;
    const provider = providerById.get(pool.boxId);
    addTarget(targets, {
      boxId: pool.boxId,
      observedName: provider?.name ?? null,
      evidence: [`database:runtime-pool:${pool.id}:${pool.scope}`],
      providerPresent: provider !== undefined,
    });
  }

  const owners = new Set(database.personalOwnerIds);
  const excludedProviderBoxes: Array<{ boxId: string; name: string }> = [];
  for (const box of providerBoxes) {
    if (box.name === undefined) continue;
    const kind = recognizeLegacyCompanionBoxName(box.name, owners);
    if (kind) {
      addTarget(targets, {
        boxId: box.id,
        observedName: box.name,
        evidence: [`provider-name:${kind}`],
        providerPresent: true,
      });
    } else if (looksLegacy(box.name)) {
      excludedProviderBoxes.push({ boxId: box.id, name: box.name });
    }
  }

  const orderedTargets = [...targets.entries()]
    .map(([boxId, target]) => ({
      boxId,
      observedName: target.observedName,
      evidence: [...target.evidence].sort(),
      providerPresent: target.providerPresent,
    }))
    .sort((left, right) => left.boxId.localeCompare(right.boxId));
  excludedProviderBoxes.sort((left, right) => left.boxId.localeCompare(right.boxId));

  return {
    database,
    providerBoxCount: providerBoxes.length,
    targets: orderedTargets,
    excludedProviderBoxes,
    hash: stableHash({
      rowCounts: database.rowCounts,
      targets: orderedTargets,
      excludedProviderBoxes,
      providerBoxCount: providerBoxes.length,
    }),
  };
}

function numberCount(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("database returned an invalid purge count");
  return parsed;
}

export async function inventoryLegacyDatabase(client: PurgeSql): Promise<LegacyDatabaseInventory> {
  const companions = await client<Array<{ id: string; boxId: string | null }>>`
    select id::text as id, box_id as "boxId"
    from public.companions
    order by id
  `;
  const pools = await client<Array<{
    id: string;
    scope: "personal" | "org";
    ownerId: string | null;
    boxId: string | null;
  }>>`
    select id::text as id, scope::text as scope, owner_id as "ownerId", box_id as "boxId"
    from public.companion_runtime_pools
    order by id
  `;
  const owners = await client<Array<{ id: string }>>`
    select id from public."user" order by id
  `;
  const [counts] = await client<Array<Record<keyof LegacyRowCounts, string>>>
    `select
      (select count(*)::bigint from public.companions)::text as companions,
      (select count(*)::bigint from public.companion_runtime_pools)::text as "runtimePools",
      (select count(*)::bigint from public.companion_workspace_access)::text as "workspaceAccess",
      (select count(*)::bigint from public.companion_member_state)::text as "memberState",
      (select count(*)::bigint from public.companion_threads)::text as threads,
      (select count(*)::bigint from public.companion_transcript_entries)::text as "transcriptEntries",
      (select count(*)::bigint from public.companion_reconcile_leases)::text as "reconcileLeases",
      (select count(*)::bigint from public.api_tokens where source_type = 'companion')::text
        as "companionTokens"`;
  if (!counts) throw new Error("database did not return legacy Companion counts");
  return {
    companions,
    pools,
    personalOwnerIds: owners.map((owner) => owner.id),
    rowCounts: {
      companions: numberCount(counts.companions),
      runtimePools: numberCount(counts.runtimePools),
      workspaceAccess: numberCount(counts.workspaceAccess),
      memberState: numberCount(counts.memberState),
      threads: numberCount(counts.threads),
      transcriptEntries: numberCount(counts.transcriptEntries),
      reconcileLeases: numberCount(counts.reconcileLeases),
      companionTokens: numberCount(counts.companionTokens),
    },
  };
}

export async function collectLegacyPurgeInventory(
  client: PurgeSql,
  boxClient: BoxMaintenanceClient,
): Promise<LegacyPurgeInventory> {
  const [database, boxes] = await Promise.all([
    inventoryLegacyDatabase(client),
    boxClient.listAllBoxes(),
  ]);
  return buildLegacyPurgeInventory(database, boxes);
}

export async function loadLegacyPurgeTargets(client: PurgeSql): Promise<LegacyPurgeLedgerTarget[]> {
  const rows = await client<Array<{
    boxId: string;
    observedName: string | null;
    evidence: unknown;
    state: LegacyPurgeTargetState;
    operationId: string | null;
    attemptCount: number;
    lastError: string | null;
  }>>`
    select box_id as "boxId", observed_name as "observedName", evidence, state,
           operation_id as "operationId", attempt_count as "attemptCount", last_error as "lastError"
    from public.companion_legacy_purge_targets
    order by box_id
  `;
  return rows.map((row) => {
    if (!Array.isArray(row.evidence) || !row.evidence.every((value) => typeof value === "string")) {
      throw new Error(`purge ledger evidence is invalid for ${row.boxId}`);
    }
    return { ...row, evidence: row.evidence };
  });
}

async function loadLegacyPurgeRun(client: PurgeSql): Promise<LegacyPurgeRun | null> {
  const [row] = await client<Array<LegacyPurgeRun>>`
    select phase from public.companion_legacy_purge_runs
    where id = ${LEGACY_COMPANION_PURGE_RUN_ID}
  `;
  return row ?? null;
}

async function seedLegacyPurgeLedger(
  client: PurgeSql,
  inventory: LegacyPurgeInventory,
): Promise<void> {
  const existing = new Map((await loadLegacyPurgeTargets(client)).map((target) => [target.boxId, target]));
  const snapshot = {
    hash: inventory.hash,
    rowCounts: inventory.database.rowCounts,
    providerBoxCount: inventory.providerBoxCount,
    targets: inventory.targets,
    excludedProviderBoxCount: inventory.excludedProviderBoxes.length,
  };
  // postgres-js' `json` helper prevents JSON/JSONB parameters from being serialized a second time.
  // Round-tripping this small operator ledger also gives its strict JSONValue type an exact runtime
  // guarantee: none of the snapshot fields can become bigint, symbol, or another non-JSON value.
  const snapshotJson = JSON.parse(JSON.stringify(snapshot)) as postgres.JSONValue;

  await client.begin(async (tx) => {
    await tx`
      insert into public.companion_legacy_purge_runs (
        id, phase, inventory_hash, inventory, updated_at
      ) values (
        ${LEGACY_COMPANION_PURGE_RUN_ID}, 'deleting_external', ${inventory.hash},
        ${tx.json(snapshotJson)}, statement_timestamp()
      )
      on conflict (id) do update set
        inventory_hash = excluded.inventory_hash,
        inventory = excluded.inventory,
        phase = case
          when companion_legacy_purge_runs.phase = 'database_complete'
            then companion_legacy_purge_runs.phase
          else 'deleting_external'
        end,
        updated_at = excluded.updated_at
    `;

    for (const target of inventory.targets) {
      const previous = existing.get(target.boxId);
      const evidence = [...new Set([...(previous?.evidence ?? []), ...target.evidence])].sort();
      const observedName = target.observedName ?? previous?.observedName ?? null;
      await tx`
        insert into public.companion_legacy_purge_targets (
          box_id, observed_name, evidence, state, updated_at
        ) values (
          ${target.boxId}, ${observedName}, ${tx.json(evidence)},
          'discovered', statement_timestamp()
        )
        on conflict (box_id) do update set
          observed_name = excluded.observed_name,
          evidence = excluded.evidence,
          updated_at = excluded.updated_at
      `;
    }
  });
}

export interface LegacyTargetJournal {
  markRequesting(boxId: string): Promise<void>;
  markAbsent(boxId: string): Promise<void>;
  markOperation(boxId: string, operation: BoxDeletionOperation, polled: boolean): Promise<void>;
  markError(boxId: string, error: string): Promise<void>;
}

function safeProviderFailure(error: unknown): string {
  if (error instanceof BoxRuntimeProviderError) {
    const code = error.code && /^[a-z0-9_.-]{1,80}$/i.test(error.code) ? ` (${error.code})` : "";
    return `Box API request failed with status ${error.status}${code}`;
  }
  if (error instanceof Error && error.message.startsWith("Box deletion ")) {
    return error.message.replace(/[\r\n]+/g, " ").slice(0, 500);
  }
  return "Box deletion failed; inspect the command error and retry";
}

export function createLegacyTargetJournal(client: PurgeSql): LegacyTargetJournal {
  return {
    async markRequesting(boxId) {
      await client`
        update public.companion_legacy_purge_targets
        set state = 'requesting', operation_id = null, requested_at = statement_timestamp(),
            completed_at = null, attempt_count = attempt_count + 1, last_error = null,
            updated_at = statement_timestamp()
        where box_id = ${boxId} and state not in ('completed', 'absent')
      `;
    },
    async markAbsent(boxId) {
      await client`
        update public.companion_legacy_purge_targets
        set state = 'absent', operation_id = null, completed_at = statement_timestamp(),
            last_error = null, updated_at = statement_timestamp()
        where box_id = ${boxId}
      `;
    },
    async markOperation(boxId, operation, polled) {
      await client`
        update public.companion_legacy_purge_targets
        set state = ${operation.status}, operation_id = ${operation.id},
            requested_at = coalesce(requested_at, statement_timestamp()),
            last_polled_at = case when ${polled} then statement_timestamp() else last_polled_at end,
            completed_at = case
              when ${operation.status} = 'completed' then statement_timestamp()
              else null
            end,
            last_error = case
              when ${operation.status} = 'blocked' then 'Box deletion operation is blocked'
              else null
            end,
            updated_at = statement_timestamp()
        where box_id = ${boxId}
      `;
    },
    async markError(boxId, error) {
      await client`
        update public.companion_legacy_purge_targets
        set last_error = ${error}, updated_at = statement_timestamp()
        where box_id = ${boxId}
      `;
    },
  };
}

export async function processLegacyPurgeTarget(input: {
  target: LegacyPurgeLedgerTarget;
  boxClient: BoxMaintenanceClient;
  journal: LegacyTargetJournal;
  log?: (message: string) => void;
  pause?: (milliseconds: number) => Promise<void>;
  nowMs?: () => number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<void> {
  if (input.target.state === "completed" || input.target.state === "absent") return;
  const log = input.log ?? console.log;
  const pause = input.pause ?? ((milliseconds: number) => sleep(milliseconds));
  const nowMs = input.nowMs ?? Date.now;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_DELETE_POLL_INTERVAL_MS;
  const pollTimeoutMs = input.pollTimeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS;
  let operationId = input.target.operationId;

  try {
    if (operationId === null) {
      await input.journal.markRequesting(input.target.boxId);
      const deletion = await input.boxClient.requestPermanentDeletion({ boxId: input.target.boxId });
      if (deletion.outcome === "absent") {
        await input.journal.markAbsent(input.target.boxId);
        log(`Box ${input.target.boxId}: absent (provider 404, treated as already deleted)`);
        return;
      }
      operationId = deletion.operation.id;
      await input.journal.markOperation(input.target.boxId, deletion.operation, false);
      log(
        `Box ${input.target.boxId}: deletion operation ${operationId} ${deletion.operation.status}`,
      );
      if (deletion.operation.status === "completed") return;
      if (deletion.operation.status === "blocked") {
        throw new Error(`Box deletion operation ${operationId} is blocked`);
      }
    }

    const deadline = nowMs() + pollTimeoutMs;
    for (;;) {
      if (nowMs() >= deadline) {
        throw new Error(`Box deletion operation ${operationId} timed out before completion`);
      }
      await pause(pollIntervalMs);
      const operation = await input.boxClient.getDeletionOperation({
        operationId,
        boxId: input.target.boxId,
      });
      await input.journal.markOperation(input.target.boxId, operation, true);
      log(`Box ${input.target.boxId}: deletion operation ${operation.id} ${operation.status}`);
      if (operation.status === "completed") return;
      if (operation.status === "blocked") {
        throw new Error(`Box deletion operation ${operation.id} is blocked`);
      }
    }
  } catch (error) {
    await input.journal.markError(input.target.boxId, safeProviderFailure(error)).catch(() => undefined);
    throw error;
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function successfulTarget(target: LegacyPurgeLedgerTarget): boolean {
  return target.state === "completed" || target.state === "absent";
}

export function legacyRowCountTotal(counts: LegacyRowCounts): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

async function assertMaintenanceOwner(client: PurgeSql): Promise<void> {
  const [row] = await client<Array<{ allowed: boolean }>>`
    select current_user = pg_get_userbyid(p.proowner) as allowed
    from pg_proc p
    where p.oid = to_regprocedure('public.companion_finalize_legacy_purge()')
  `;
  if (!row?.allowed) {
    throw new Error(
      "DATABASE_MIGRATION_URL must connect as the owner of companion_finalize_legacy_purge()",
    );
  }
}

export function printLegacyPurgeReport(input: {
  inventory: LegacyPurgeInventory;
  ledger: readonly LegacyPurgeLedgerTarget[];
  mode: "report" | "dry-run" | "purge-complete";
  log?: (message: string) => void;
}): void {
  const log = input.log ?? console.log;
  const counts = input.inventory.database.rowCounts;
  log(`Legacy Companion purge ${input.mode}: inventory ${input.inventory.hash}`);
  log(
    "Legacy database rows: "
      + `companions=${counts.companions}, pools=${counts.runtimePools}, `
      + `access=${counts.workspaceAccess}, member_state=${counts.memberState}, `
      + `threads=${counts.threads}, transcripts=${counts.transcriptEntries}, `
      + `leases=${counts.reconcileLeases}, companion_tokens=${counts.companionTokens}`,
  );
  log(
    `Provider Boxes scanned=${input.inventory.providerBoxCount}, purge targets=${input.inventory.targets.length}`,
  );
  for (const target of input.inventory.targets) {
    log(
      `  target ${target.boxId} name=${JSON.stringify(target.observedName)} `
        + `provider_present=${target.providerPresent} evidence=${target.evidence.join(",")}`,
    );
  }
  for (const box of input.inventory.excludedProviderBoxes) {
    log(`  excluded ${box.boxId} name=${JSON.stringify(box.name)} (not an exact legacy format)`);
  }
  if (input.ledger.length > 0) {
    log("Durable deletion ledger:");
    for (const target of input.ledger) {
      log(
        `  ${target.boxId} state=${target.state} operation=${target.operationId ?? "-"}`
          + `${target.lastError ? ` error=${JSON.stringify(target.lastError)}` : ""}`,
      );
    }
  }
  log(`Preserved: ${PRESERVED_DATA_CATEGORIES.join("; ")}.`);
}

async function finalizeLegacyDatabase(client: PurgeSql): Promise<Record<string, unknown>> {
  const [row] = await client<Array<{ result: Record<string, unknown> }>>`
    select public.companion_finalize_legacy_purge() as result
  `;
  if (!row?.result || typeof row.result !== "object") {
    throw new Error("legacy Companion purge finalizer returned no result");
  }
  return row.result;
}

export async function executeConfirmedLegacyPurge(input: {
  client: PurgeSql;
  boxClient: BoxMaintenanceClient;
  initialInventory: LegacyPurgeInventory;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): Promise<Record<string, unknown>> {
  const env = input.env ?? process.env;
  const log = input.log ?? console.log;
  const pollIntervalMs = positiveInteger(
    env.COMPANION_BOX_DELETE_POLL_INTERVAL_MS,
    DEFAULT_DELETE_POLL_INTERVAL_MS,
  );
  const pollTimeoutMs = positiveInteger(
    env.COMPANION_BOX_DELETE_TIMEOUT_MS,
    DEFAULT_DELETE_TIMEOUT_MS,
  );
  const existingRun = await loadLegacyPurgeRun(input.client);
  const existingTargets = await loadLegacyPurgeTargets(input.client);
  if (existingRun?.phase === "database_complete") {
    const known = new Map(existingTargets.map((target) => [target.boxId, target]));
    const unexpected = input.initialInventory.targets.filter((target) => {
      const ledger = known.get(target.boxId);
      return !ledger || !successfulTarget(ledger) || target.providerPresent;
    });
    const remainingRows = legacyRowCountTotal(input.initialInventory.database.rowCounts);
    if (unexpected.length > 0 || remainingRows > 0) {
      throw new Error(
        "legacy Companion purge is already complete but new legacy state appeared "
          + `(targets=${unexpected.length}, database_rows=${remainingRows})`,
      );
    }
    return { already_complete: true };
  }

  let inventory = input.initialInventory;
  for (let round = 1; round <= MAX_DISCOVERY_ROUNDS; round += 1) {
    await seedLegacyPurgeLedger(input.client, inventory);
    const journal = createLegacyTargetJournal(input.client);
    const targets = await loadLegacyPurgeTargets(input.client);
    for (const target of targets) {
      await processLegacyPurgeTarget({
        target,
        boxClient: input.boxClient,
        journal,
        log,
        pollIntervalMs,
        pollTimeoutMs,
      });
    }

    const fresh = await collectLegacyPurgeInventory(input.client, input.boxClient);
    const ledger = new Map((await loadLegacyPurgeTargets(input.client)).map((target) => [target.boxId, target]));
    const newTargets = fresh.targets.filter((target) => !ledger.has(target.boxId));
    if (newTargets.length > 0) {
      log(`Discovery round ${round}: found ${newTargets.length} additional exact legacy Box target(s)`);
      for (const target of newTargets) {
        log(
          `  discovered ${target.boxId} name=${JSON.stringify(target.observedName)} `
            + `evidence=${target.evidence.join(",")}`,
        );
      }
      inventory = fresh;
      continue;
    }
    const stillVisible = fresh.targets.filter((target) => target.providerPresent);
    if (stillVisible.length > 0) {
      throw new Error(
        `${stillVisible.length} confirmed legacy Box target(s) still appear in the provider inventory`,
      );
    }
    const incomplete = [...ledger.values()].filter((target) => !successfulTarget(target));
    if (incomplete.length > 0) {
      throw new Error(`${incomplete.length} legacy Box deletion operation(s) remain incomplete`);
    }
    return finalizeLegacyDatabase(input.client);
  }
  throw new Error("legacy Companion provider inventory did not stabilize after 20 discovery rounds");
}

function safeCommandFailure(error: unknown): string {
  if (error instanceof BoxRuntimeProviderError) return safeProviderFailure(error);
  if (error instanceof Error) return error.message.replace(/[\r\n]+/g, " ").slice(0, 1_000);
  return "unknown legacy Companion purge failure";
}

export async function run(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const invocation = parseCompanionPurgeArgs(argv);
  assertCompanionPurgeDisabled(env);
  const databaseUrl = companionPurgeDatabaseUrl(env);
  const boxClient = new AsciiBoxMaintenanceClient(env);
  const client = postgres(databaseUrl, { max: 1 });
  let lockAcquired = false;
  try {
    const [lock] = await client<Array<{ locked: boolean }>>`
      select pg_try_advisory_lock(
        ${COMPANION_PURGE_LOCK_CLASS_ID}, ${COMPANION_PURGE_LOCK_OBJECT_ID}
      ) as locked
    `;
    if (!lock?.locked) throw new Error("another migration or cutover holds the Drizzle migration lock");
    lockAcquired = true;
    await assertMaintenanceOwner(client);

    const inventory = await collectLegacyPurgeInventory(client, boxClient);
    const ledger = await loadLegacyPurgeTargets(client);
    if (invocation.command === "report") {
      printLegacyPurgeReport({ inventory, ledger, mode: "report" });
      return;
    }
    if (invocation.dryRun) {
      printLegacyPurgeReport({ inventory, ledger, mode: "dry-run" });
      console.log("Dry run only: no Box request and no database write was made.");
      return;
    }

    printLegacyPurgeReport({ inventory, ledger, mode: "report" });
    const result = await executeConfirmedLegacyPurge({ client, boxClient, initialInventory: inventory, env });
    console.log(`Legacy Companion database purge result: ${JSON.stringify(result)}`);
    const finalInventory = await collectLegacyPurgeInventory(client, boxClient);
    const finalLedger = await loadLegacyPurgeTargets(client);
    const remainingRows = legacyRowCountTotal(finalInventory.database.rowCounts);
    if (remainingRows > 0 || finalInventory.targets.length > 0) {
      throw new Error(
        "legacy Companion purge final verification failed "
          + `(targets=${finalInventory.targets.length}, database_rows=${remainingRows})`,
      );
    }
    printLegacyPurgeReport({ inventory: finalInventory, ledger: finalLedger, mode: "purge-complete" });
  } finally {
    if (lockAcquired) {
      await client`
        select pg_advisory_unlock(
          ${COMPANION_PURGE_LOCK_CLASS_ID}, ${COMPANION_PURGE_LOCK_OBJECT_ID}
        )
      `.catch(() => undefined);
    }
    await client.end();
  }
}

function isMain(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && pathToFileURL(entrypoint).href === import.meta.url);
}

if (isMain()) {
  run().catch((error: unknown) => {
    console.error("Legacy Companion purge failed");
    console.error(safeCommandFailure(error));
    process.exitCode = 1;
  });
}
