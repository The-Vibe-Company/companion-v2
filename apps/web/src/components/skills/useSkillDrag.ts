"use client";

// Pointer-events drag-and-drop for the Skills sidebar. Replaces native HTML5 DnD,
// which gave unreliable hover feedback with a real mouse AND was unverifiable (the
// only test seam was dispatching synthetic DragEvents at handlers, which always pass).
//
// How it works: onPointerDown records a *pending* press but does NOT start a drag, so
// a plain click still opens the skill. Once the pointer moves past a small threshold
// we commit: begin the drag, show a floating ghost, and on every move resolve the
// element under the cursor via `document.elementFromPoint` -> `resolveDropTarget`.
// That resolution is the real production decision path; tests drive it by stubbing
// only `resolveTargetEl` (layout), never the logic. Teardown always runs on
// pointerup/pointercancel/Escape/unmount — fixing the native bug where `dragend`
// sometimes never fired and the sidebar stayed stuck in drop mode.

import { useEffect, useRef, useState } from "react";
import type { SkillsLibrary } from "./route";
import type { DragItem } from "./SkillsApp";
import {
  exceedsThreshold,
  isDwellCandidate,
  resolveDropTarget,
  sameDropTarget,
  type ResolvedTarget,
} from "./dragGeometry";

const FOLDER_DWELL_OPEN_DELAY_MS = 650;
const DROP_DONE_FLASH_MS = 850;
const GHOST_OFFSET_PX = 12;

/** Minimal shape we read off a pointer event — satisfied by both React synthetic and native events. */
export interface PointerLike {
  clientX: number;
  clientY: number;
  pointerId: number;
}

interface UseSkillDragOptions {
  beginDrag: (item: DragItem) => void;
  endDrag: () => void;
  onDropSkillOnLabel: (lib: SkillsLibrary, skillId: string, targetPath: string, sourceLabel: string | null) => void;
  onDropSkillOnRoot: (lib: SkillsLibrary, skillId: string, sourceLabel: string | null) => void;
  onReparentLabel: (lib: SkillsLibrary, from: string, targetParent: string | null) => void;
  onReorderLabel: (
    lib: SkillsLibrary,
    from: string,
    target: string,
    position: "before" | "after",
  ) => void;
  onToggleExpand: (path: string) => void;
  expanded: Set<string>;
  treeRowsByPath: Map<string, { hasChildren: boolean }>;
  /** Injectable for tests (happy-dom has no layout). Defaults to document.elementFromPoint. */
  resolveTargetEl?: (x: number, y: number) => Element | null;
}

export interface SkillDrag {
  /** Call from onPointerDown on a drag source (skill row or label row). */
  startDrag: (item: DragItem, e: PointerLike) => void;
  /** The currently hovered, validated drop target (drives --dropok styling). */
  hovered: ResolvedTarget | null;
  /** The folder whose 650ms auto-open is counting down (drives --openpending). */
  openPendingPath: string | null;
  /** The target that just received a drop (drives the --dropdone flash). */
  dropDone: ResolvedTarget | null;
}

export function useSkillDrag(options: UseSkillDragOptions): SkillDrag {
  const optsRef = useRef(options);
  optsRef.current = options;

  const [hovered, setHovered] = useState<ResolvedTarget | null>(null);
  const [openPendingPath, setOpenPendingPath] = useState<string | null>(null);
  const [dropDone, setDropDone] = useState<ResolvedTarget | null>(null);

  // Live state read by the window listeners — refs, never closures, so a StrictMode
  // double-invoke or a stale render can't drop or duplicate a drag.
  const pendingRef = useRef<{ item: DragItem; startX: number; startY: number; pointerId: number } | null>(null);
  const activeRef = useRef(false);
  const itemRef = useRef<DragItem | null>(null);
  const hoveredRef = useRef<ResolvedTarget | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwellTargetRef = useRef<string | null>(null);
  const dropDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Built exactly once: stable identities so add/removeEventListener pair up, and the
  // mutually-recursive handlers (teardown <-> listeners) can reference each other freely.
  const [api] = useState(() => {
    const setHov = (t: ResolvedTarget | null) => {
      if (sameDropTarget(t, hoveredRef.current)) return;
      hoveredRef.current = t;
      setHovered(t);
    };

    const clearDwell = () => {
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
      dwellTimerRef.current = null;
      dwellTargetRef.current = null;
      setOpenPendingPath(null);
    };

    const scheduleDwell = (path: string) => {
      if (dwellTargetRef.current === path) return; // already counting down on this folder
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current);
      dwellTargetRef.current = path;
      setOpenPendingPath(path);
      dwellTimerRef.current = setTimeout(() => {
        if (dwellTargetRef.current === path && !optsRef.current.expanded.has(path)) {
          optsRef.current.onToggleExpand(path);
        }
        dwellTimerRef.current = null;
        dwellTargetRef.current = null;
        setOpenPendingPath(null);
      }, FOLDER_DWELL_OPEN_DELAY_MS);
    };

    const createGhost = (item: DragItem) => {
      if (typeof document === "undefined") return;
      const el = document.createElement("div");
      el.className = "skill-drag-preview";
      el.style.left = "0px";
      el.style.top = "0px";
      // Belt-and-suspenders with the stylesheet: the ghost must never be the elementFromPoint
      // result, or it would shadow the real drop target under the cursor.
      el.style.pointerEvents = "none";
      const name = document.createElement("span");
      name.className = "skill-drag-preview__name";
      name.textContent = item.kind === "skill" ? item.skillId : item.leaf;
      el.appendChild(name);
      document.body.appendChild(el);
      ghostRef.current = el;
    };

    const positionGhost = (x: number, y: number) => {
      if (ghostRef.current) {
        ghostRef.current.style.transform = `translate(${x + GHOST_OFFSET_PX}px, ${y + GHOST_OFFSET_PX}px)`;
      }
    };

    const flashDropDone = (target: ResolvedTarget) => {
      if (dropDoneTimerRef.current) clearTimeout(dropDoneTimerRef.current);
      setDropDone(target);
      dropDoneTimerRef.current = setTimeout(() => {
        setDropDone(null);
        dropDoneTimerRef.current = null;
      }, DROP_DONE_FLASH_MS);
    };

    const teardown = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown);
      clearDwell();
      if (ghostRef.current) {
        ghostRef.current.remove();
        ghostRef.current = null;
      }
      pendingRef.current = null;
      if (activeRef.current) {
        activeRef.current = false;
        itemRef.current = null;
        if (typeof document !== "undefined") {
          document.body.style.userSelect = "";
          document.body.style.cursor = "";
        }
        setHov(null);
        optsRef.current.endDrag();
      }
    };

    const commitDrag = (item: DragItem) => {
      activeRef.current = true;
      itemRef.current = item;
      if (typeof document !== "undefined") {
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      optsRef.current.beginDrag(item);
      createGhost(item);
    };

    const onPointerMove = (e: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending || e.pointerId !== pending.pointerId) return;
      if (!activeRef.current) {
        if (!exceedsThreshold({ x: pending.startX, y: pending.startY }, { x: e.clientX, y: e.clientY })) return;
        commitDrag(pending.item);
      }
      positionGhost(e.clientX, e.clientY);
      const resolveEl = optsRef.current.resolveTargetEl ?? defaultResolveTargetEl;
      const next = resolveDropTarget(resolveEl(e.clientX, e.clientY), itemRef.current, e.clientY);
      setHov(next);
      if (isDwellCandidate(next, itemRef.current, optsRef.current.treeRowsByPath, optsRef.current.expanded)) {
        scheduleDwell((next as { path: string }).path);
      } else {
        clearDwell();
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const pending = pendingRef.current;
      if (pending && e.pointerId !== pending.pointerId) return;
      const item = itemRef.current;
      const target = hoveredRef.current;
      if (activeRef.current && item && target) {
        const o = optsRef.current;
        if (target.kind === "label") {
          if (item.kind === "skill") o.onDropSkillOnLabel(target.lib, item.skillId, target.path, item.sourceLabel);
          else o.onReparentLabel(target.lib, item.path, target.path);
        } else if (target.kind === "reorder") {
          if (item.kind === "label") o.onReorderLabel(target.lib, item.path, target.path, target.position);
        } else {
          if (item.kind === "skill") o.onDropSkillOnRoot(target.lib, item.skillId, item.sourceLabel);
          else o.onReparentLabel(target.lib, item.path, null);
        }
        flashDropDone(target);
      }
      teardown();
    };

    const onPointerCancel = () => teardown();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") teardown();
    };

    const startDrag = (item: DragItem, e: PointerLike) => {
      if (pendingRef.current || activeRef.current) return; // one drag at a time
      pendingRef.current = { item, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
      window.addEventListener("keydown", onKeyDown);
    };

    return { startDrag, teardown };
  });

  // Always tear down on unmount (removes listeners, ghost, timers; restores body styles).
  useEffect(() => api.teardown, [api]);

  return { startDrag: api.startDrag, hovered, openPendingPath, dropDone };
}

function defaultResolveTargetEl(x: number, y: number): Element | null {
  return typeof document === "undefined" ? null : document.elementFromPoint(x, y);
}
