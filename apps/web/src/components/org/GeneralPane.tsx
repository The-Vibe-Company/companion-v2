"use client";

import type { CSSProperties } from "react";
import { RoleDot } from "./primitives";
import { orgRole } from "./roles";
import type { OrgCtx, OrgFull } from "./model";

const ROW: CSSProperties = { gridTemplateColumns: "180px 1fr" };
const LABEL: CSSProperties = { color: "var(--color-muted)" };

export function GeneralPane({ org, ctx }: { org: OrgFull; ctx: OrgCtx }) {
  return (
    <div className="og-pane__inner">
      <div className="og-pane__head">
        <h2 className="og-pane__title">General</h2>
        <p className="og-pane__desc">Workspace identity and your role.</p>
      </div>
      <div className="og-mlist">
        <div className="og-mrow" style={ROW}>
          <span className="og-memail" style={LABEL}>Name</span>
          <span className="og-mname">{org.name}</span>
        </div>
        <div className="og-mrow" style={ROW}>
          <span className="og-memail" style={LABEL}>URL</span>
          <span className="og-memail">companion.dev/{org.slug}</span>
        </div>
        <div className="og-mrow" style={ROW}>
          <span className="og-memail" style={LABEL}>Plan</span>
          <span className="og-mname" style={{ fontWeight: 400, textTransform: "capitalize" }}>{org.plan}</span>
        </div>
        <div className="og-mrow" style={ROW}>
          <span className="og-memail" style={LABEL}>Type</span>
          <span className="og-mname" style={{ fontWeight: 400 }}>
            {org.kind === "personal" ? "Personal workspace" : "Team organization"}
          </span>
        </div>
        <div className="og-mrow" style={ROW}>
          <span className="og-memail" style={LABEL}>Your role</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
            <RoleDot role={ctx.myRole} />
            <span className="og-mname" style={{ fontWeight: 400 }}>{orgRole(ctx.myRole).label}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
