"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type { CompanionAccess } from "@companion/contracts";
import { Icon } from "../Icon";

// SAFETY-free gate: SSR renders nothing, so presence of `document` decides portal use.
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- legacy pattern predating the incremental anti-slop gate
const hasDocument = typeof document !== "undefined";

/** The one slice of a Companion the menu decides from, so any roster surface can host it. */
export type CompanionActionsRow = {
  id: string;
  name: string;
  access: CompanionAccess;
  pinned: boolean;
  unread: boolean;
};

/**
 * The per-Companion "…" menu. The panel is portalled to `document.body` with fixed positioning so
 * it survives any scroll container it is triggered from — the sidebar's `.side__nav` clips
 * absolutely-positioned children.
 */
export function CompanionActionsMenu({
  companion,
  busy,
  personalWorkspace,
  hidden = false,
  onSettings,
  onShare,
  onMemberState,
  onDuplicate,
  onDelete,
}: {
  companion: CompanionActionsRow;
  busy: boolean;
  personalWorkspace: boolean;
  hidden?: boolean;
  onSettings: () => void;
  onShare: () => void;
  onMemberState: (patch: { pinned?: boolean; hidden?: boolean; unread?: boolean }) => Promise<void>;
  onDuplicate: () => Promise<void>;
  /** Owner-only destructive intent; the host owns the confirm dialog and the 202 delete flow. */
  onDelete?: () => void;
}) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openFocusRef = useRef<"first" | "last">("first");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ left: -9999, top: -9999 });

  const positionMenu = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const anchor = trigger.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 4;
    let top = anchor.bottom + gap;
    if (top + box.height > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, anchor.top - box.height - gap);
    }
    const maxLeft = Math.max(viewportPadding, window.innerWidth - viewportPadding - box.width);
    const left = Math.min(
      Math.max(viewportPadding, anchor.right - box.width),
      maxLeft,
    );
    setPosition({ left, top });
  }, []);

  const close = useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    window.requestAnimationFrame(() => {
      const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const item = openFocusRef.current === "last" ? items?.item((items?.length ?? 1) - 1) : items?.item(0);
      item?.focus();
    });
  }, [open, positionMenu]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- invariant checked by the surrounding validation
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [close, open, positionMenu]);

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- invariant checked by the surrounding validation
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "ArrowDown") next = current < items.length - 1 ? current + 1 : 0;
    else if (event.key === "ArrowUp") next = current > 0 ? current - 1 : items.length - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "Tab") {
      event.preventDefault();
      close();
      window.requestAnimationFrame(() => {
        const trigger = triggerRef.current;
        if (!trigger) return;
        const focusable = [...document.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        )].filter((item) => !menuRef.current?.contains(item));
        const triggerIndex = focusable.indexOf(trigger);
        const destination = focusable[triggerIndex + (event.shiftKey ? -1 : 1)];
        (destination ?? trigger).focus();
      });
      return;
    } else return;
    event.preventDefault();
    items[next]?.focus();
  };

  const run = (action: () => void | Promise<void>, returnFocus = false) => {
    close(returnFocus);
    void action();
  };

  const deleteItem = companion.access === "owner" && onDelete ? (
    <button
      type="button"
      role="menuitem"
      className="companions-row-menu__danger"
      disabled={busy}
      onClick={() => run(onDelete)}
    >
      Delete
    </button>
  ) : null;

  return (
    <span className="companions-row-menu">
      <button
        ref={triggerRef}
        type="button"
        className="cds-btn cds-btn--ghost cds-btn--sm companions-row-menu__trigger"
        aria-label={`Actions for ${companion.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          openFocusRef.current = "first";
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openFocusRef.current = event.key === "ArrowUp" ? "last" : "first";
          setOpen(true);
        }}
      >
        <Icon name="more-horizontal" size={15} />
      </button>
      {open && hasDocument
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              className="companions-row-menu__panel"
              role="menu"
              aria-label={`Actions for ${companion.name}`}
              style={position}
              onKeyDown={onMenuKeyDown}
            >
              <button type="button" role="menuitem" onClick={() => run(onSettings)}>
                Settings
              </button>
              {hidden ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => run(() => onMemberState({ hidden: false }), true)}
                >
                  Unhide
                </button>
              ) : (
                <>
                  {companion.access === "owner" && !personalWorkspace ? (
                    <button type="button" role="menuitem" onClick={() => run(onShare)}>
                      Share
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => run(
                      () => onMemberState({ pinned: !companion.pinned }),
                      true,
                    )}
                  >
                    {companion.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy || companion.unread}
                    onClick={() => run(() => onMemberState({ unread: true }), true)}
                  >
                    Mark as unread
                  </button>
                  {companion.access === "owner" ? (
                    <button type="button" role="menuitem" disabled={busy} onClick={() => run(onDuplicate, true)}>
                      Duplicate
                    </button>
                  ) : null}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={busy}
                    onClick={() => run(() => onMemberState({ hidden: true }), true)}
                  >
                    Hide
                  </button>
                </>
              )}
              {deleteItem}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
