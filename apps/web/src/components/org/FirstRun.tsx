"use client";

import { useState } from "react";
import { Onboarding, type OnboardingMode } from "./Onboarding";
import { useOrgActions } from "./useOrgActions";

/** Shown when a signed-in user belongs to no workspace yet — forces onboarding. */
export function FirstRun() {
  const actions = useOrgActions();
  const [mode, setMode] = useState<OnboardingMode>("choose");
  return (
    <div className="app">
      <Onboarding
        mode={mode}
        onMode={(m) => setMode(m ?? "choose")}
        onCreate={actions.createOrg}
        onJoin={actions.joinOrg}
        busy={actions.busy}
      />
      {actions.error && (
        <div className="og-toast" role="alert" onClick={() => actions.setError(null)}>
          {actions.error}
        </div>
      )}
    </div>
  );
}
