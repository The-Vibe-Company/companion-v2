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

type SidebarProps = ComponentProps<typeof Sidebar>;

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
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
    localActive: false,
    localUpdateCount: 0,
    archivedActive: false,
    archivedCount: 0,
    mobileOpen: false,
    onToggleMobile: noop,
    onCloseMobile: noop,
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(Sidebar, props));
}

const companions = [
  {
    id: "companion-1",
    name: "Luna",
    status: "Online",
    tone: "ok" as const,
    preview: "Drafted the launch note.",
    previewAt: "2026-08-14T09:05:00.000Z",
    unread: true,
  },
  {
    id: "companion-2",
    name: "Milo",
    status: "Asleep",
    tone: "unknown" as const,
    preview: null,
    previewAt: null,
    unread: false,
  },
];

describe("Sidebar Companions feature gate", () => {
  it("does not expose Companions navigation when disabled", () => {
    const markup = renderSidebar({ companionsEnabled: false });

    expect(markup).not.toContain("Companions");
    expect(markup).not.toContain("modeseg");
    expect(markup).toContain("My Skills");
  });

  it("shows the Skills | Companions mode segment when enabled", () => {
    const markup = renderSidebar({ companionsEnabled: true });

    expect(markup).toContain("Workspace mode");
    expect(markup).toContain(">Skills</span>");
    expect(markup).toContain(">Companions</span>");
    expect(markup).toContain("My Skills");
  });

  it("replaces the Skills libraries with the Companion list in Companions mode", () => {
    const markup = renderSidebar({ companionsEnabled: true, mode: "companions", companions });

    expect(markup).toContain("Luna");
    expect(markup).toContain("Milo");
    // Presence is never colour alone: the word is in the row's accessible name and in text a
    // screen reader reaches, beside the dot.
    expect(markup).toContain("cmprow__statusword sr-only");
    expect(markup).toContain("Online, Unread");
    // The row carries no aria-label: one would override its content and hide the preview, the
    // relative time, and the status and unread words from a screen reader.
    expect(markup).not.toContain('aria-label="Luna — Online"');
    expect(markup).toContain("cmprow__dot--ok");
    // Each row reads as a conversation: the last line said, and when.
    expect(markup).toContain("Drafted the launch note.");
    expect(markup).toContain("cmprow__unread");
    // A thread nobody has written in says so rather than showing an empty line.
    expect(markup).toContain("No messages yet");
    expect(markup).not.toContain("My Skills");
    expect(markup).not.toContain("Organization");
    expect(markup).not.toContain("Companion skills");
  });

  it("puts the Companions destinations where the Skills ones sit, rather than beside them", () => {
    // The foot of the sidebar holds whichever pair the current mode can actually reach. Secrets and
    // Archived are Skills destinations, so offering them to a Companion reader is an archive of
    // something they are not looking at.
    const companionsMarkup = renderSidebar({
      companionsEnabled: true,
      mode: "companions",
      companions,
      onOpenPlugins: () => {},
      onOpenProviders: () => {},
    });

    expect(companionsMarkup).toContain(">Providers</span>");
    expect(companionsMarkup).toContain(">Plugins</span>");
    expect(companionsMarkup).not.toContain(">Secrets</span>");
    expect(companionsMarkup).not.toContain(">Archived</span>");

    // Skills keeps its own pair, and is never offered the Companions ones.
    const skillsMarkup = renderSidebar({ companionsEnabled: true, mode: "skills" });

    expect(skillsMarkup).toContain(">Secrets</span>");
    expect(skillsMarkup).toContain(">Archived</span>");
    expect(skillsMarkup).not.toContain(">Providers</span>");
    expect(skillsMarkup).not.toContain(">Plugins</span>");
  });

  it("offers Providers only to a member who can manage them", () => {
    // The caller withholds the handler for a member the surface itself would refuse, so the entry
    // is absent rather than present and then denied.
    const markup = renderSidebar({
      companionsEnabled: true,
      mode: "companions",
      companions,
      onOpenPlugins: () => {},
    });

    expect(markup).not.toContain(">Providers</span>");
    expect(markup).toContain(">Plugins</span>");
  });

  it("keeps the Companions mode list honest when the workspace has none", () => {
    const markup = renderSidebar({ companionsEnabled: true, mode: "companions", companions: [] });

    expect(markup).toContain("No Companions yet");
  });

  it("ignores Companions mode when the flag is off", () => {
    const markup = renderSidebar({ companionsEnabled: false, mode: "companions", companions });

    expect(markup).not.toContain("Luna");
    expect(markup).toContain("My Skills");
  });
});
