import type { RuntimeSettlementInput } from "./types";

export type RuntimeWorkDisposition =
  | { kind: "settle"; settlement: RuntimeSettlementInput }
  | { kind: "release" }
  | { kind: "defer_delete" };

export const runtimeSucceeded: RuntimeWorkDisposition = {
  kind: "settle",
  settlement: { terminalStatus: "succeeded" },
};

export function runtimeInterrupted(input: RuntimeSettlementInput["error"]): RuntimeWorkDisposition {
  const settlement: RuntimeSettlementInput = { terminalStatus: "interrupted" };
  if (input) settlement.error = input;
  return {
    kind: "settle",
    settlement,
  };
}
