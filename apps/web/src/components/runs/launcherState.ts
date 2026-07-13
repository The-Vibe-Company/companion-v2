import {
  runInputSelectionSchema,
  type RunConfiguration,
  type RunDependency,
  type RunInputSelection,
  type RunInputSnapshot,
  type RunOptions,
} from "@companion/contracts";

export interface RunLauncherDraft {
  prompt: string;
  files: File[];
  model: string;
  inputs: RunInputSelection;
  configurationId: string | null;
  /** Reused only after an ambiguous launch response for the exact same draft payload. */
  launchIdempotencyKey?: string | null;
  /** Stable signature paired with launchIdempotencyKey, including the pinned root version. */
  launchPayloadSignature?: string | null;
}

export interface RunInputGroup {
  skill: RunDependency;
  secrets: RunOptions["declared_secrets"];
  variables: RunOptions["declared_variables"];
}

export function withRunDraft(
  current: ReadonlyMap<string, RunLauncherDraft>,
  slug: string,
  draft: RunLauncherDraft | null,
): Map<string, RunLauncherDraft> {
  const next = new Map(current);
  if (draft) next.set(slug, draft);
  else next.delete(slug);
  return next;
}

export function emptyRunInputSelection(): RunInputSelection {
  return { secrets: [], variables: [] };
}

export function secretSelectionKey(skillId: string, slotId: string): string {
  return `${skillId}:${slotId}`;
}

export function variableSelectionKey(skillId: string, envKey: string): string {
  return `${skillId}:${envKey}`;
}

export function normalizeRunInputs(inputs: RunInputSelection): RunInputSelection {
  return {
    secrets: inputs.secrets
      .map((item) => ({ skill_id: item.skill_id, slot_id: item.slot_id, secret_id: item.secret_id }))
      .sort((a, b) => secretSelectionKey(a.skill_id, a.slot_id).localeCompare(secretSelectionKey(b.skill_id, b.slot_id))),
    variables: inputs.variables
      .map((item) => ({ skill_id: item.skill_id, env_key: item.env_key, value: item.value }))
      .sort((a, b) => variableSelectionKey(a.skill_id, a.env_key).localeCompare(variableSelectionKey(b.skill_id, b.env_key))),
  };
}

export function configurationIsModified(
  configuration: RunConfiguration | null,
  model: string,
  inputs: RunInputSelection,
): boolean {
  if (!configuration) return false;
  return configuration.model !== model || JSON.stringify(normalizeRunInputs(configuration.inputs)) !== JSON.stringify(normalizeRunInputs(inputs));
}

export function groupRunInputs(options: RunOptions): RunInputGroup[] {
  const skills = [options.root, ...options.dependencies].sort((left, right) => {
    if (left.root !== right.root) return left.root ? -1 : 1;
    return left.depth - right.depth || left.slug.localeCompare(right.slug);
  });
  return skills
    .map((skill) => ({
      skill,
      secrets: options.declared_secrets.filter((item) => item.skill_id === skill.skill_id),
      variables: options.declared_variables.filter((item) => item.skill_id === skill.skill_id),
    }))
    .filter((group) => group.secrets.length > 0 || group.variables.length > 0);
}

/** Remove stale selections no longer declared by the exact version shown in run-options. */
export function authoritativeInputs(options: RunOptions, inputs: RunInputSelection): RunInputSelection {
  const secretSlots = new Set(options.declared_secrets.map((item) => secretSelectionKey(item.skill_id, item.slot_id)));
  const variableSlots = new Set(options.declared_variables.map((item) => variableSelectionKey(item.skill_id, item.env_key)));
  return normalizeRunInputs({
    secrets: inputs.secrets.filter((item) => secretSlots.has(secretSelectionKey(item.skill_id, item.slot_id))),
    variables: inputs.variables.filter((item) => variableSlots.has(variableSelectionKey(item.skill_id, item.env_key))),
  });
}

export function prefilledInputs(options: RunOptions): RunInputSelection {
  return {
    secrets: options.declared_secrets.flatMap((slot) =>
      slot.prefill_secret_id
        ? [{ skill_id: slot.skill_id, slot_id: slot.slot_id, secret_id: slot.prefill_secret_id }]
        : [],
    ),
    variables: [],
  };
}

export function runInputsFromSnapshot(snapshot: RunInputSnapshot | undefined): RunInputSelection {
  if (!snapshot) return emptyRunInputSelection();
  return {
    secrets: snapshot.secrets.flatMap((item) =>
      item.provenance === "skill" && item.skill_id && item.slot_id && item.secret_id
        ? [{ skill_id: item.skill_id, slot_id: item.slot_id, secret_id: item.secret_id }]
        : [],
    ),
    variables: snapshot.variables.map((item) => ({
      skill_id: item.skill_id,
      env_key: item.env_key,
      value: item.value,
    })),
  };
}

export function runDraftBlockers(options: RunOptions, model: string, inputs: RunInputSelection): string[] {
  const blockers: string[] = [];
  const validatedInputs = runInputSelectionSchema.safeParse(inputs);
  if (!validatedInputs.success) blockers.push(...validatedInputs.error.issues.map((issue) => issue.message));
  if (!options.runtime.available) blockers.push(options.runtime.message ?? "RunSkill is not available on this workspace.");

  const modelOption = options.models.find((item) => item.model.id === model);
  if (!modelOption) blockers.push("Select an activated model.");
  else if (modelOption.readiness !== "ready") {
    blockers.push(modelOption.message ?? {
      not_activated: "This model is not activated.",
      provider_disconnected: "Connect this model provider to a vault secret.",
      runtime_unavailable: "The model runtime is unavailable.",
      ready: "",
    }[modelOption.readiness]);
  } else if (!modelOption.provider_secret_pin) {
    blockers.push("Reload run options to select the model provider secret explicitly.");
  }

  const secretBySlot = new Map(inputs.secrets.map((item) => [secretSelectionKey(item.skill_id, item.slot_id), item]));
  const variableBySlot = new Map(inputs.variables.map((item) => [variableSelectionKey(item.skill_id, item.env_key), item]));
  const envValues = new Map<string, { kind: "secret" | "variable"; identity: string }>();
  if (modelOption?.provider_secret_pin) {
    envValues.set(modelOption.provider_secret_pin.env_key, {
      kind: "secret",
      identity: modelOption.provider_secret_pin.secret_id,
    });
  }

  for (const slot of options.declared_secrets) {
    const selected = secretBySlot.get(secretSelectionKey(slot.skill_id, slot.slot_id));
    if (!selected) {
      if (slot.required) blockers.push(`${slot.skill_slug}: ${slot.env_key} requires a secret.`);
      continue;
    }
    if (!slot.candidates.some((candidate) => candidate.id === selected.secret_id)) {
      blockers.push(`${slot.skill_slug}: ${slot.env_key} references a secret that is no longer available.`);
      continue;
    }
    const current = envValues.get(slot.env_key);
    if (current && (current.kind !== "secret" || current.identity !== selected.secret_id)) {
      blockers.push(`${slot.env_key} has conflicting values across the dependency closure.`);
    } else envValues.set(slot.env_key, { kind: "secret", identity: selected.secret_id });
  }

  for (const declaration of options.declared_variables) {
    const selected = variableBySlot.get(variableSelectionKey(declaration.skill_id, declaration.env_key));
    if (!selected) {
      if (declaration.required) blockers.push(`${declaration.skill_slug}: ${declaration.env_key} is required.`);
      continue;
    }
    const current = envValues.get(declaration.env_key);
    if (current && (current.kind !== "variable" || current.identity !== selected.value)) {
      blockers.push(`${declaration.env_key} has conflicting values across the dependency closure.`);
    } else envValues.set(declaration.env_key, { kind: "variable", identity: selected.value });
  }

  return [...new Set(blockers.filter(Boolean))];
}
