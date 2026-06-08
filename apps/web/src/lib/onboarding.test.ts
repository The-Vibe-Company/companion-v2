import { describe, expect, it } from "vitest";
import { brandIconCandidates, faviconUrl, firstLoadableBrandIconCandidate, normalizeWebsiteDomain } from "./onboarding";

describe("onboarding brand icon helpers", () => {
  it("normalizes website input to a host", () => {
    expect(normalizeWebsiteDomain("https://Quivr.app/path?utm=1")).toBe("quivr.app");
    expect(normalizeWebsiteDomain("  http://www.Quivr.app/#home  ")).toBe("www.quivr.app");
    expect(normalizeWebsiteDomain("/quivr.app/docs")).toBe("quivr.app");
  });

  it("keeps faviconUrl pointed at icon.horse for the normalized host", () => {
    expect(faviconUrl("https://Quivr.app/docs")).toBe("https://icon.horse/icon/quivr.app");
  });

  it("tries the entered host before the www fallback", () => {
    expect(brandIconCandidates("quivr.app")).toEqual([
      { domain: "quivr.app", url: "https://icon.horse/icon/quivr.app" },
      { domain: "www.quivr.app", url: "https://icon.horse/icon/www.quivr.app" },
    ]);
  });

  it("tries the www host before the naked fallback when www was entered", () => {
    expect(brandIconCandidates("www.quivr.app")).toEqual([
      { domain: "www.quivr.app", url: "https://icon.horse/icon/www.quivr.app" },
      { domain: "quivr.app", url: "https://icon.horse/icon/quivr.app" },
    ]);
  });

  it("returns the first icon candidate that loads", async () => {
    const candidates = brandIconCandidates("quivr.app");
    const attempts: string[] = [];

    await expect(
      firstLoadableBrandIconCandidate(candidates, async (candidate) => {
        attempts.push(candidate.domain);
        return candidate.domain === "www.quivr.app";
      }),
    ).resolves.toEqual({ domain: "www.quivr.app", url: "https://icon.horse/icon/www.quivr.app" });

    expect(attempts).toEqual(["quivr.app", "www.quivr.app"]);
  });

  it("returns null when no icon candidate loads", async () => {
    await expect(firstLoadableBrandIconCandidate(brandIconCandidates("quivr.app"), async () => false)).resolves.toBeNull();
  });
});
