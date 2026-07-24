import {
  createElement,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CoworkDialog } from "./ProjectDialogs";

describe("CoworkDialog", () => {
  it("defers its portal until hydration so deep-linked dialogs can render on the server", () => {
    const ServerDialog = CoworkDialog as ComponentType<
      Omit<ComponentProps<typeof CoworkDialog>, "children"> & {
        children?: ReactNode;
      }
    >;
    expect(() =>
      renderToString(
        createElement(
          ServerDialog,
          {
            title: "New project",
            description: "Create a persistent project.",
            onClose: vi.fn(),
          },
          createElement("button", { type: "button" }, "Create"),
        ),
      ),
    ).not.toThrow();
  });
});
