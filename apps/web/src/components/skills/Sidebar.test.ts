import React, { type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./Sidebar";

const noop = () => {};
const org = {
  id: "org-1",
  name: "Acme",
  slug: "acme",
  kind: "team" as const,
  myRole: "owner" as const,
  color: null,
  logoUrl: null,
};

function renderSidebar(companionsEnabled: boolean) {
  const props: ComponentProps<typeof Sidebar> = {
    orgs: [org],
    currentOrg: org,
    onSwitchOrg: noop,
    onOnboard: noop,
    onOpenSettings: noop,
    onWarmSettings: noop,
    mineTreeRows: [],
    orgTreeRows: [],
    expanded: new Set(),
    onToggleExpand: noop,
    selection: { lib: "mine", kind: "all" },
    mineCount: 0,
    orgCount: 0,
    installedCount: 0,
    installedUpdateCount: 0,
    onOpenPalette: noop,
    onSelectMineAll: noop,
    onSelectOrgAll: noop,
    onSelectInstalled: noop,
    onSelectLabel: noop,
    onCreateLabel: noop,
    onSetLabelColor: noop,
    onSetLabelIcon: noop,
    onRenameLabel: noop,
    onDeleteLabel: noop,
    drag: null,
    hovered: null,
    openPendingPath: null,
    dropDone: null,
    onReparentLabel: noop,
    onLabelStartDrag: noop,
    onSelectLocal: noop,
    onSelectArchived: noop,
    onSelectSecrets: noop,
    onSelectCompanions: noop,
    companionsEnabled,
    localActive: false,
    localUpdateCount: 0,
    archivedActive: false,
    archivedCount: 0,
    mobileOpen: false,
    onToggleMobile: noop,
    onCloseMobile: noop,
  };
  return renderToStaticMarkup(React.createElement(Sidebar, props));
}

describe("Sidebar Companions feature gate", () => {
  it("does not expose Companions navigation when disabled", () => {
    expect(renderSidebar(false)).not.toContain("Companions");
  });

  it("shows Companions navigation when enabled", () => {
    expect(renderSidebar(true)).toContain("Companions");
  });
});
