"use client";

import type { ProvisionError } from "@companion/contracts";
import { Icon } from "../Icon";
import type { ProvisionStepVM } from "@/lib/types";

/**
 * Compose the errblock text from the structured ProvisionError, mirroring the design's mono
 * error string (message, then indented sandbox/region/step/exit lines, then the detail hint).
 */
export function provisionErrorText(error: ProvisionError): string {
  const lines: string[] = [error.message];
  const meta: string[] = [];
  if (error.sandbox_name) meta.push(`  sandbox  ${error.sandbox_name}`);
  if (error.region) meta.push(`  region   ${error.region}`);
  if (error.step) meta.push(`  step     ${error.step}`);
  if (error.exit_code != null) meta.push(`  exit     ${error.exit_code}`);
  if (meta.length) lines.push("", ...meta);
  if (error.detail) lines.push("", error.detail);
  return lines.join("\n");
}

function stepColor(state: ProvisionStepVM["state"]): string {
  if (state === "failed") return "var(--color-danger)";
  if (state === "pending") return "var(--color-faint)";
  return "var(--color-fg)";
}

function StepIcon({ state }: { state: ProvisionStepVM["state"] }) {
  if (state === "running") return <Icon name="loader" size={15} className="ls-spin" style={{ color: "var(--color-muted)" }} />;
  if (state === "done") return <Icon name="check" size={15} style={{ color: "var(--color-ok)" }} />;
  if (state === "failed") return <Icon name="alert-triangle" size={15} style={{ color: "var(--color-danger)" }} />;
  return <Icon name="circle-dashed" size={15} style={{ color: "var(--color-line-strong)" }} />;
}

/** The centered provisioning card (design "Provisioning" screen). Pure presentational. */
export function ProvisioningCard({
  name,
  steps,
  error,
  ok,
  skillsCount,
  onRetry,
  onBackToForm,
}: {
  name: string;
  steps: ProvisionStepVM[];
  error: ProvisionError | null;
  ok: boolean;
  skillsCount: number;
  onRetry: () => void;
  onBackToForm: () => void;
}) {
  return (
    <div
      data-screen-label="Provisioning"
      style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
    >
      <div
        style={{
          width: "min(520px, 100%)",
          border: "1px solid var(--color-line)",
          borderRadius: "var(--radius-lg)",
          background: "var(--color-surface)",
          boxShadow: "var(--shadow-md)",
          padding: "26px 28px",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--color-faint)",
            textTransform: "uppercase",
            letterSpacing: "var(--tracking-wide)",
          }}
        >
          Provisioning
        </div>
        <h2
          style={{
            margin: "6px 0 0",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-lg)",
            fontWeight: 600,
            letterSpacing: "var(--tracking-tight)",
          }}
        >
          {name}
        </h2>
        <p style={{ margin: "6px 0 22px", fontSize: "var(--text-sm)", color: "var(--color-muted)" }}>
          Forking the golden sandbox and pushing {skillsCount} {skillsCount === 1 ? "skill." : "skills."} Takes a few
          seconds.
        </p>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {steps.map((step) => (
            <div key={step.key} style={{ display: "flex", alignItems: "flex-start", gap: 11, padding: "9px 0" }}>
              <span style={{ flex: "none", width: 18, height: 18, display: "grid", placeItems: "center", marginTop: 1 }}>
                <StepIcon state={step.state} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: "var(--text-sm)", fontWeight: 500, color: stepColor(step.state) }}>
                  {step.label}
                </span>
                <span
                  style={{
                    display: "block",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--color-faint)",
                    marginTop: 1,
                  }}
                >
                  {step.detail}
                </span>
              </span>
              <span style={{ flex: "none", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-faint)", marginTop: 3 }}>
                {step.time}
              </span>
            </div>
          ))}
        </div>
        {error && (
          <>
            <pre className="errblock" style={{ margin: "14px 0 0" }}>
              {provisionErrorText(error)}
            </pre>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button type="button" className="btn-primary" onClick={onRetry}>
                Retry with a fresh fork
              </button>
              <button type="button" className="ag-btn" onClick={onBackToForm}>
                Back to form
              </button>
            </div>
          </>
        )}
        {ok && (
          <div className="ls-confirm" style={{ marginTop: 14 }}>
            <Icon name="check" size={14} />
            Healthy. Opening the agent…
          </div>
        )}
      </div>
    </div>
  );
}
