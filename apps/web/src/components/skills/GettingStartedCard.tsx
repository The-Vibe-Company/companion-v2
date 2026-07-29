"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GettingStartedState,
  GettingStartedStep,
  LocalSkillRow,
} from "@companion/contracts";
import {
  apiBase,
  dismissGettingStarted,
  fetchGettingStarted,
} from "@/lib/queries";
import { Icon } from "../Icon";
import { fillPrompt } from "./prompts";

type AgentId = "claude-code" | "codex" | "opencode";

const AGENTS: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

const STEPS: Array<{
  id: GettingStartedStep;
  title: string;
  description: string;
  timestamp: keyof Pick<
    GettingStartedState,
    "companion_installed_at" | "local_reviewed_at" | "org_reviewed_at"
  >;
}> = [
  {
    id: "companion_install",
    title: "Install Companion",
    description: "Connect Companion to your coding agent.",
    timestamp: "companion_installed_at",
  },
  {
    id: "local_review",
    title: "Review local skills",
    description: "Choose which skills from this machine belong in My Skills.",
    timestamp: "local_reviewed_at",
  },
  {
    id: "org_review",
    title: "Explore organization skills",
    description: "Review the shared library and install what is useful.",
    timestamp: "org_reviewed_at",
  },
];

function mergeMonotonicState(
  current: GettingStartedState,
  next: GettingStartedState,
): GettingStartedState {
  const companionInstalledAt = next.companion_installed_at ?? current.companion_installed_at;
  const localReviewedAt = next.local_reviewed_at ?? current.local_reviewed_at;
  const orgReviewedAt = next.org_reviewed_at ?? current.org_reviewed_at;
  const completedAt = next.completed_at ?? current.completed_at;
  return {
    companion_installed_at: companionInstalledAt,
    local_reviewed_at: localReviewedAt,
    org_reviewed_at: orgReviewedAt,
    completed_at: completedAt,
    dismissed_at: next.dismissed_at,
    completed: Boolean(completedAt),
    first_incomplete_step: !companionInstalledAt
      ? "companion_install"
      : !localReviewedAt
        ? "local_review"
        : !orgReviewedAt
          ? "org_review"
          : null,
  };
}

export function GettingStartedCard({
  initialState,
  companionSkill,
  workspaceId,
}: {
  initialState: GettingStartedState;
  companionSkill: LocalSkillRow;
  workspaceId: string;
}) {
  const [state, setState] = useState(initialState);
  const [agent, setAgent] = useState<AgentId>("claude-code");
  const [copiedStep, setCopiedStep] = useState<GettingStartedStep | null>(null);
  const [copyFailedStep, setCopyFailedStep] = useState<GettingStartedStep | null>(null);
  const [hidden, setHidden] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const refreshSequence = useRef(0);
  const workspaceRef = useRef(workspaceId);
  const stateWorkspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const visible = !hidden && !state.completed_at && !state.dismissed_at;

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const requestedWorkspace = workspaceId;
    try {
      const next = await fetchGettingStarted(requestedWorkspace);
      if (
        sequence === refreshSequence.current
        && requestedWorkspace === workspaceRef.current
      ) {
        setState((current) => mergeMonotonicState(current, next));
      }
    } catch {
      // Best effort: keep the last confirmed server state. A failed read never invents progress.
    }
  }, [workspaceId]);

  useEffect(() => {
    refreshSequence.current += 1;
    const workspaceChanged = stateWorkspaceRef.current !== workspaceId;
    stateWorkspaceRef.current = workspaceId;
    setState((current) => (
      workspaceChanged ? initialState : mergeMonotonicState(current, initialState)
    ));
    if (workspaceChanged) {
      setHidden(false);
      setCopiedStep(null);
      setCopyFailedStep(null);
      setDismissing(false);
    }
  }, [initialState, workspaceId]);

  useEffect(() => {
    if (!visible) return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [refresh, visible]);

  const prompt = useMemo(() => {
    const template = state.companion_installed_at
      ? companionSkill.prompts.resume
      : companionSkill.prompts.onboarding;
    const tool = AGENTS[agent];
    return fillPrompt(template, apiBase(), workspaceId, tool, tool);
  }, [agent, companionSkill, state.companion_installed_at, workspaceId]);

  const copyForStep = async (step: GettingStartedStep) => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyFailedStep(null);
      setCopiedStep(step);
      window.setTimeout(() => setCopiedStep((current) => current === step ? null : current), 2000);
    } catch {
      setCopiedStep(null);
      setCopyFailedStep(step);
    }
  };

  const hide = async () => {
    if (dismissing) return;
    const requestedWorkspace = workspaceId;
    setDismissing(true);
    setHidden(true);
    try {
      const next = await dismissGettingStarted(requestedWorkspace);
      if (requestedWorkspace === workspaceRef.current) setState(next);
    } catch {
      if (requestedWorkspace === workspaceRef.current) setHidden(false);
    } finally {
      if (requestedWorkspace === workspaceRef.current) setDismissing(false);
    }
  };

  if (!visible) return null;

  return (
    <section className="gs-card" aria-labelledby="getting-started-title">
      <div className="gs-card__head">
        <div>
          <h2 className="gs-card__title" id="getting-started-title">Getting started</h2>
          <p className="gs-card__desc">
            Set up Companion, bring in your local skills, and explore what your organization shares.
          </p>
        </div>
        <button type="button" className="gs-card__hide" onClick={() => void hide()} disabled={dismissing}>
          Hide
        </button>
      </div>

      <label className="gs-agent">
        <span className="gs-agent__label">My agent</span>
        <select value={agent} onChange={(event) => setAgent(event.target.value as AgentId)}>
          {Object.entries(AGENTS).map(([id, label]) => (
            <option value={id} key={id}>{label}</option>
          ))}
        </select>
      </label>

      <ol className="gs-steps">
        {STEPS.map((step) => {
          const done = Boolean(state[step.timestamp]);
          const current = state.first_incomplete_step === step.id;
          return (
            <li className={`gs-step${done ? " gs-step--done" : ""}`} key={step.id}>
              <span className="gs-step__mark" aria-hidden="true">
                <Icon name={done ? "check" : "circle"} size={13} />
              </span>
              <span className="gs-step__copy">
                <span className="gs-step__title">{step.title}</span>
                <span className="gs-step__desc">{step.description}</span>
              </span>
              <span className={`gs-step__status${done ? " gs-step__status--done" : ""}`}>
                {done ? "Done" : "To do"}
              </span>
              {!done ? (
                <button
                  type="button"
                  className={current ? "btn-primary gs-step__action" : "btn-sec gs-step__action"}
                  onClick={() => void copyForStep(step.id)}
                  disabled={!prompt}
                >
                  <Icon name={copiedStep === step.id ? "check" : "copy"} size={13} />
                  {copiedStep === step.id ? "Copied" : "Continue with my agent"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {copyFailedStep && prompt ? (
        <div className="gs-copy-fallback">
          <label className="gs-copy-fallback__label" htmlFor="getting-started-prompt">
            Copy failed. Select and copy this prompt manually.
          </label>
          <textarea
            id="getting-started-prompt"
            className="gs-copy-fallback__prompt"
            readOnly
            rows={5}
            value={prompt}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}
      <span className="sr-only" role="status" aria-live="polite">
        {copiedStep
          ? `Prompt copied for ${STEPS.find((step) => step.id === copiedStep)?.title}.`
          : copyFailedStep
            ? "Copy failed. The prompt is available for manual copying."
            : ""}
      </span>
    </section>
  );
}
