import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ViewTab } from "./ViewTab";
import type { ViewDef } from "./filters";

const noop = vi.fn();

function render(view: ViewDef, active = false) {
  return renderToString(
    React.createElement(ViewTab, {
      view,
      active,
      count: 3,
      onSelect: noop,
      onRename: noop,
      onDelete: noop,
    }),
  );
}

const customView: ViewDef = {
  id: "view-1",
  name: "My Team Skills",
  icon: "bookmark",
  custom: true,
  filters: [{ type: "visibility", value: "team" }],
};

const allView: ViewDef = { id: "all", name: "All", icon: "layers", filters: [] };

describe("ViewTab", () => {
  it("renders a custom view as a menu-bearing tab", () => {
    const html = render(customView, true);
    expect(html).toContain('role="tab"');
    expect(html).toContain("My Team Skills");
    expect(html).toContain("vtab--custom");
    // Custom tabs advertise the right-click / keyboard context menu.
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-selected="true"');
    // The menu itself is closed until opened, so its actions are absent.
    expect(html).not.toContain("Rename");
    expect(html).not.toContain("Delete");
  });

  it("renders the built-in All view without a context menu", () => {
    const html = render(allView);
    expect(html).toContain("All");
    expect(html).not.toContain("vtab--custom");
    expect(html).not.toContain("aria-haspopup");
    expect(html).not.toContain("aria-expanded");
  });
});
