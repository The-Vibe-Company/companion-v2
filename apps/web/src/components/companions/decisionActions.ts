"use client";

import { createContext, useContext } from "react";

/**
 * How a permission card reaches the control plane. The card renders deep inside the thread — it is a
 * part of an assistant message, several primitives down — so the action is handed to it through
 * context rather than threaded past every layer in between. `canAct` is the Owner/Editor boundary:
 * a Viewer reads the same card and is never given the controls.
 */
export type DecisionAction =
  | { action: "allow" }
  | { action: "deny" }
  | { action: "answer"; answer: string };

export interface DecisionActions {
  canAct: boolean;
  onDecide: (requestId: string, input: DecisionAction) => Promise<void>;
}

export const DecisionActionsContext = createContext<DecisionActions>({
  canAct: false,
  onDecide: async () => undefined,
});

export function useDecisionActions(): DecisionActions {
  return useContext(DecisionActionsContext);
}
