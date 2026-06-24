"use client";

import { useEffect, useRef } from "react";
import { Icon } from "../Icon";
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
  onConfirm: () => void;
  onClose: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef<HTMLElement | null>(null);

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
        </div>
        <div className="ml-share__foot">
          <button type="button" className="ml-share__cancel" ref={cancelRef} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" onClick={onConfirm}>
            <Icon name="send" size={15} />
            Share to organization
          </button>
        </div>
      </div>
    </>
  );
}
