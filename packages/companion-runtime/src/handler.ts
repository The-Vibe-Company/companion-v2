import type { RuntimeSettlementInput } from "./types";

export type RuntimeWorkDisposition =
  | { kind: "settle"; settlement: RuntimeSettlementInput }
  | { kind: "release" };

export const runtimeSucceeded: RuntimeWorkDisposition = {
  kind: "settle",
  settlement: { terminalStatus: "succeeded" },
};

export function runtimeInterrupted(input: RuntimeSettlementInput["error"]): RuntimeWorkDisposition {
  return {
    kind: "settle",
    settlement: { terminalStatus: "interrupted", ...(input ? { error: input } : {}) },
  };
}
