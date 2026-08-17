/**
 * Deterministic Pi RPC behaviours supported by the Box simulator.
 *
 * `normal`, `tool`, `ask_user`, `retry`, and `errors` are shaped from the public Pi RPC
 * documentation. The remaining scenarios deliberately inject transport faults that real Pi must
 * never emit during a healthy run. Keeping that distinction in the catalog prevents a synthetic
 * fault from quietly becoming an asserted vendor contract.
 */
export const PI_SCENARIO_NAMES = [
  "normal",
  "tool",
  "ask_user",
  "retry",
  "errors",
  "crash",
  "malformed",
  "oversized",
  "unknown",
] as const;

export type PiScenarioName = (typeof PI_SCENARIO_NAMES)[number];

export type PiScenarioProvenance = "official_docs_adapted" | "synthetic_fault";

export interface PiScenarioDefinition {
  name: PiScenarioName;
  description: string;
  provenance: PiScenarioProvenance;
  /** True when Pi pauses until an `extension_ui_response` carrying the request id arrives. */
  requiresExtensionUiResponse: boolean;
  /** True when the process intentionally exits before `agent_settled`. */
  exitsBeforeSettlement: boolean;
}

export const PI_SCENARIOS: Readonly<Record<PiScenarioName, PiScenarioDefinition>> = {
  normal: {
    name: "normal",
    description: "Accept a prompt, stream one text answer, and settle.",
    provenance: "official_docs_adapted",
    requiresExtensionUiResponse: false,
    exitsBeforeSettlement: false,
  },
  tool: {
    name: "tool",
    description: "Run one tool with progress and a correlated tool result before replying.",
    provenance: "official_docs_adapted",
    requiresExtensionUiResponse: false,
    exitsBeforeSettlement: false,
  },
  ask_user: {
    name: "ask_user",
    description: "Block on the Companion ask_user extension UI request, then resume the same run.",
    provenance: "official_docs_adapted",
    requiresExtensionUiResponse: true,
    exitsBeforeSettlement: false,
  },
  retry: {
    name: "retry",
    description: "Report one transient provider retry and then settle successfully.",
    provenance: "official_docs_adapted",
    requiresExtensionUiResponse: false,
    exitsBeforeSettlement: false,
  },
  errors: {
    name: "errors",
    description: "Accept a prompt, then finish with an expurgated assistant/provider error.",
    provenance: "official_docs_adapted",
    requiresExtensionUiResponse: false,
    exitsBeforeSettlement: false,
  },
  crash: {
    name: "crash",
    description: "Acknowledge the prompt and terminate before any terminal Pi event.",
    provenance: "synthetic_fault",
    requiresExtensionUiResponse: false,
    exitsBeforeSettlement: true,
  },
  malformed: {
    name: "malformed",
    description: "Emit one malformed LF-delimited record, then continue to a valid settlement.",
    provenance: "synthetic_fault",
    requiresExtensionUiResponse: false,
    exitsBeforeSettlement: false,
  },
  oversized: {
    name: "oversized",
    description: "Emit one valid but oversized JSON record, then continue to settlement.",
    provenance: "synthetic_fault",
    requiresExtensionUiResponse: false,
    exitsBeforeSettlement: false,
  },
  unknown: {
    name: "unknown",
    description: "Emit one future/unknown event type, then continue to settlement.",
    provenance: "synthetic_fault",
    requiresExtensionUiResponse: false,
    exitsBeforeSettlement: false,
  },
};

const PI_SCENARIO_NAME_SET = new Set<string>(PI_SCENARIO_NAMES);

export function isPiScenarioName(value: unknown): value is PiScenarioName {
  return typeof value === "string" && PI_SCENARIO_NAME_SET.has(value);
}

export function parsePiScenarioName(value: unknown, fallback: PiScenarioName = "normal"): PiScenarioName {
  if (value === undefined || value === null || value === "") return fallback;
  if (isPiScenarioName(value)) return value;
  throw new Error(`unknown Pi simulator scenario: ${String(value)}`);
}
