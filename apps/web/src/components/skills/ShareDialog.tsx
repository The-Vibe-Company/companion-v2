"use client";

import { useEffect, useRef, useState } from "react";
import type { SkillSharePlan } from "@companion/contracts";
import { Icon } from "../Icon";
import { fetchSkillSharePlan } from "@/lib/queries";
import type { SkillVM } from "@/lib/types";

/**
 * Confirm moving a personal skill into the org library ("Share to organization"). This is an action
 * confirm dialog — allowed by DESIGN.md (the ban is on modal-first *detail*, not confirmations). Esc
 * and the scrim close it; focus moves to Cancel on open and returns to the trigger on close.
 */
export function ShareDialog({
  skill,
  orgName,
  onConfirm,
  onClose,
}: {
  skill: SkillVM;
  orgName: string;
  onConfirm: (plan: SkillSharePlan) => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const [plan, setPlan] = useState<SkillSharePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  useEffect(() => {
    returnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      queueMicrotask(() => returnRef.current?.focus());
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    setPlanError(null);
    fetchSkillSharePlan(skill.id)
      .then((next) => {
        if (!cancelled) setPlan(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPlanError(error instanceof Error ? error.message : "Could not load the share plan.");
      });
    return () => {
      cancelled = true;
    };
  }, [skill.id]);

  const blocked = plan?.blocked ?? [];
  const dependencies = plan?.dependencies ?? [];
  const canConfirm = !!plan && !planError && blocked.length === 0;

  return (
    <>
      <button type="button" className="ls-scrim" aria-label="Cancel" onClick={onClose} />
      <div className="ml-share" role="dialog" aria-modal="true" aria-labelledby="ml-share-title">
        <div className="ml-share__head">
          <span className="ml-share__icon" aria-hidden="true">
            <Icon name="send" size={18} />
          </span>
          <div className="ml-share__heading">
            <div id="ml-share-title" className="ml-share__title">
              Share to organization?
            </div>
            <div className="ml-share__sub">
              Move <b className="mono">{skill.id}</b> into {orgName}
            </div>
          </div>
        </div>
        <div className="ml-share__why">
          <div className="ml-share__row">
            <span className="ml-share__rowico ml-share__rowico--ok" aria-hidden="true">
              <Icon name="check" size={15} />
            </span>
            <span>Everyone in the workspace can find, star, and install it.</span>
          </div>
          <div className="ml-share__row">
            <span className="ml-share__rowico" aria-hidden="true">
              <Icon name="arrow-up-circle" size={15} />
            </span>
            <span>It leaves your personal library. Org folders and labels apply from here on.</span>
          </div>
          <div className="ml-share__row">
            <span className="ml-share__rowico" aria-hidden="true">
              <Icon name="download" size={15} />
            </span>
            <span>You can install it back into My Skills anytime.</span>
          </div>
          {!plan && !planError && (
            <div className="ml-share__row">
              <span className="ml-share__rowico" aria-hidden="true">
                <Icon name="loader" size={15} />
              </span>
              <span>Checking private dependencies...</span>
            </div>
          )}
          {dependencies.length > 0 && (
            <div className="ml-share__deps" aria-label="Private dependencies included in this share">
              <div className="ml-share__depshead">Private dependencies included</div>
              {dependencies.map((dep) => (
                <div className="ml-share__dep" key={dep.slug}>
                  <Icon name="package" size={14} />
                  <span className="mono">{dep.slug}</span>
                </div>
              ))}
            </div>
          )}
          {blocked.length > 0 && (
            <div className="ml-share__block">
              <div className="ml-share__depshead">Resolve before sharing</div>
              {blocked.map((block) => (
                <div className="ml-share__dep" key={block.slug}>
                  <Icon name="alert-triangle" size={14} />
                  <span>
                    <b className="mono">{block.slug}</b>: {block.msg}
                  </span>
                </div>
              ))}
            </div>
          )}
          {planError && (
            <div className="ml-share__block">
              <div className="ml-share__dep">
                <Icon name="alert-triangle" size={14} />
                <span>{planError}</span>
              </div>
            </div>
          )}
        </div>
        <div className="ml-share__foot">
          <button type="button" className="ml-share__cancel" ref={cancelRef} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={() => plan && onConfirm(plan)} disabled={!canConfirm}>
            <Icon name="send" size={15} />
            Share to organization
          </button>
        </div>
      </div>
    </>
  );
}
