"use client";

import Link from "next/link";
import { Icon } from "../Icon";

export function SpaceSwitch({
  active,
  onNavigate,
  projectsEnabled = true,
}: {
  active: "skills" | "projects";
  onNavigate?: () => void;
  projectsEnabled?: boolean;
}) {
  if (!projectsEnabled) return null;
  return (
    <nav className="space-switch" aria-label="Workspace space">
      <Link
        href="/skills"
        aria-current={active === "skills" ? "page" : undefined}
        className={active === "skills" ? "is-active" : undefined}
        onClick={onNavigate}
      >
        <Icon name="package" size={14} />
        Skills
      </Link>
      <Link
        href="/projects"
        aria-current={active === "projects" ? "page" : undefined}
        className={active === "projects" ? "is-active" : undefined}
        onClick={onNavigate}
      >
        <Icon name="boxes" size={14} />
        Projects
      </Link>
    </nav>
  );
}
