"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ensureProjectSkill, fetchProjects } from "@/lib/projects";
import type {
  ProjectRowVM,
  ProjectRuntimeAvailability,
} from "@/lib/projectsModel";
import { relativeTime } from "@/lib/format";
import { Icon } from "../Icon";
import { CoworkDialog } from "./ProjectDialogs";

function projectStatusLabel(status: ProjectRowVM["status"]): string {
  if (status === "running") return "Working";
  if (status === "queued" || status === "provisioning") return "Getting ready";
  if (status === "stopping") return "Going to sleep";
  if (status === "stopped") return "Sleeping";
  if (status === "needs_attention" || status === "error")
    return "Needs attention";
  if (status === "deleting" || status === "deleted") return "Deleting";
  return "Idle";
}

function projectStatusTone(
  status: ProjectRowVM["status"],
): "working" | "waiting" | "error" | "done" {
  if (status === "running") return "working";
  if (["queued", "provisioning", "stopping", "deleting"].includes(status))
    return "waiting";
  if (status === "needs_attention" || status === "error") return "error";
  return "done";
}

export function ProjectRunPicker({
  skillSlug,
  skillName,
  onClose,
}: {
  skillSlug: string;
  skillName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectRowVM[]>([]);
  const [runtime, setRuntime] = useState<ProjectRuntimeAvailability | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const actionRequestRef = useRef(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    fetchProjects()
      .then((response) => {
        if (!active) return;
        setProjects(response.projects);
        setRuntime(response.runtime);
      })
      .catch((cause) => {
        if (!active) return;
        setLoadError(
          cause instanceof Error ? cause.message : "Could not load projects.",
        );
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      actionRequestRef.current += 1;
    };
  }, [reload]);

  const dismiss = () => {
    actionRequestRef.current += 1;
    onClose();
  };

  const choose = (projectId: string) => {
    if (busyId || runtime?.available !== true) return;
    const requestId = ++actionRequestRef.current;
    setBusyId(projectId);
    setError(null);
    void ensureProjectSkill(projectId, skillSlug)
      .then(() => {
        if (requestId !== actionRequestRef.current) return;
        onClose();
        router.push(
          `/projects/${projectId}?newSession=1&skill=${encodeURIComponent(skillSlug)}`,
        );
      })
      .catch((cause) => {
        if (requestId !== actionRequestRef.current) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not add this skill to the project.",
        );
        setBusyId(null);
      });
  };

  return (
    <CoworkDialog
      title={`Run ${skillName}`}
      description="Choose the project whose files, skills and secrets this session should use."
      onClose={dismiss}
      width="540px"
      dismissible={busyId === null}
    >
      <div className="cowork-dialog__body cowork-project-picker">
        {loading ? (
          <div className="cowork-project-picker__loading" role="status">
            <Icon name="loader" size={15} className="ls-spin" />
            Loading projects…
          </div>
        ) : loadError ? (
          <div className="cowork-project-picker__empty" role="alert">
            <Icon name="alert-triangle" size={18} />
            <strong>Projects could not be loaded.</strong>
            <span>{loadError}</span>
            <button
              type="button"
              className="cds-btn cds-btn--secondary cds-btn--sm"
              onClick={() => setReload((current) => current + 1)}
            >
              Retry
            </button>
          </div>
        ) : runtime?.available === false ? (
          <div className="cowork-project-picker__empty">
            <Icon name="alert-triangle" size={18} />
            <strong>Projects are not available.</strong>
            <span>
              {runtime.message ||
                "Configure the Projects runtime before starting a session."}
            </span>
          </div>
        ) : projects.length === 0 ? (
          <div className="cowork-project-picker__empty">
            <Icon name="boxes" size={18} />
            <strong>Create a project first</strong>
            <span>The skill will be synced into it automatically.</span>
          </div>
        ) : (
          <div className="cowork-project-picker__list" aria-label="Projects">
            {projects.map((project) => (
              <button
                type="button"
                key={project.id}
                disabled={
                  busyId !== null ||
                  project.status === "deleting" ||
                  project.status === "deleted" ||
                  project.status === "needs_attention" ||
                  project.status === "error"
                }
                onClick={() => choose(project.id)}
              >
                <span
                  className={`project-status-dot is-${projectStatusTone(project.status)}`}
                  aria-hidden="true"
                />
                <span>
                  <strong>{project.name}</strong>
                  <small>
                    {projectStatusLabel(project.status)} ·{" "}
                    {project.sessionCount} sessions · updated{" "}
                    {relativeTime(project.updatedAt)}
                  </small>
                </span>
                {busyId === project.id ? (
                  <Icon name="loader" size={14} className="ls-spin" />
                ) : (
                  <Icon name="chevron-right" size={14} />
                )}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p className="project-inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="cowork-dialog__foot cowork-project-picker__foot">
        <button
          type="button"
          className="cds-btn cds-btn--ghost cds-btn--md"
          disabled={busyId !== null}
          onClick={dismiss}
        >
          Cancel
        </button>
        <button
          type="button"
          className="cds-btn cds-btn--secondary cds-btn--md"
          disabled={
            loading ||
            loadError !== null ||
            busyId !== null ||
            runtime?.available !== true
          }
          onClick={() => {
            dismiss();
            router.push(
              `/projects?new=1&skill=${encodeURIComponent(skillSlug)}`,
            );
          }}
        >
          <Icon name="plus" size={14} />
          New project
        </button>
      </footer>
    </CoworkDialog>
  );
}
