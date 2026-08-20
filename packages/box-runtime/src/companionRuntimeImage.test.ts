import { describe, expect, it } from "vitest";

import {
  companionPiLayoutIdentity,
  companionRuntimeImageName,
  isCompanionRuntimeImageName,
  parseCompanionPiLayoutRefresh,
} from "./companionRuntimeImage";

describe("companion runtime image identity", () => {
  it("names the golden snapshot from the full layout marker, not a new layout version", () => {
    const identity = companionPiLayoutIdentity({
      layoutVersion: 14,
      packages: ["npm:pi-mcp-adapter@2.12.1", "npm:pi-web-access@0.24.0"],
      qmdPackage: "@tobilu/qmd@2.8.3",
      minimumPiVersion: "0.84.2",
    });

    expect(identity.baseMarker).toBe(
      "14:npm:pi-mcp-adapter@2.12.1,npm:pi-web-access@0.24.0:qmd=@tobilu/qmd@2.8.3:pi>=0.84.2:skill=none:boot=1",
    );
    expect(identity.fullMarker).toBe(`${identity.baseMarker}:overlay=${identity.overlayMarker}`);
    expect(identity.imageName).toBe(companionRuntimeImageName(identity.fullMarker, 14));
    expect(isCompanionRuntimeImageName(identity.imageName)).toBe(true);
    expect(identity.imageName).toMatch(/^companion-l14-[a-f0-9]{12}$/);
  });

  it("keeps overlay changes off the package marker so a broker bump does not reinstall Pi", () => {
    const packages = ["npm:pi-mcp-adapter@2.12.1"];
    const base = companionPiLayoutIdentity({
      layoutVersion: 14,
      packages,
      qmdPackage: "@tobilu/qmd@2.8.3",
      minimumPiVersion: "0.84.2",
      overlayRevision: 1,
    });
    const overlay = companionPiLayoutIdentity({
      layoutVersion: 14,
      packages,
      qmdPackage: "@tobilu/qmd@2.8.3",
      minimumPiVersion: "0.84.2",
      overlayRevision: 2,
    });

    expect(overlay.baseMarker).toBe(base.baseMarker);
    expect(overlay.overlayMarker).not.toBe(base.overlayMarker);
    expect(overlay.imageName).not.toBe(base.imageName);
  });

  it("reads the layout script's last label, and treats unlabeled success as a full install", () => {
    expect(parseCompanionPiLayoutRefresh("companion-layout-unchanged\n")).toBe("none");
    expect(parseCompanionPiLayoutRefresh("noise\ncompanion-layout-overlay\n")).toBe("overlay");
    expect(parseCompanionPiLayoutRefresh("companion-layout-base\n")).toBe("base");
    expect(parseCompanionPiLayoutRefresh("companion-box-runnable\n")).toBe("base");
  });
});
