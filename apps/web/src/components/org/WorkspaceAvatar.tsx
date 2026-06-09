import type { CSSProperties } from "react";
import { hashColor, initialsOf } from "@/lib/settingsViewModel";

export interface WorkspaceAvatarOrg {
  kind: "personal" | "team";
  name: string;
  color: string | null;
  logoUrl: string | null;
}

/** Workspace brand chip — logo image, or initials on the org color (matches OrgSwitcher). */
export function WorkspaceAvatar({
  org,
  className,
  size = 20,
}: {
  org: WorkspaceAvatarOrg;
  className: string;
  size?: number;
}) {
  const personal = org.kind === "personal";
  const style: CSSProperties = {
    width: size,
    height: size,
    fontSize: Math.max(8, Math.round(size * 0.48)),
  };
  if (org.logoUrl) {
    style.background = "var(--color-surface-raised)";
  } else if (!personal) {
    style.background = org.color ?? hashColor(org.name);
    style.color = "#fff";
  }

  return (
    <span className={className} style={style}>
      {org.logoUrl ? <img src={org.logoUrl} alt="" /> : initialsOf(org.name)}
    </span>
  );
}
