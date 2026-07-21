import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { canonicalAliasRedirect, middleware } from "./middleware";

describe("canonical host middleware", () => {
  it("redirects www to the configured apex while preserving path and query", () => {
    const request = new NextRequest("https://www.thecompanion.sh/skills?lib=mine&skill=demo");

    const destination = canonicalAliasRedirect(request, "https://thecompanion.sh");
    expect(destination?.toString()).toBe("https://thecompanion.sh/skills?lib=mine&skill=demo");
  });

  it("does not redirect requests already using the canonical host", () => {
    const request = new NextRequest("https://thecompanion.sh/skills?lib=mine");

    expect(canonicalAliasRedirect(request, "https://thecompanion.sh")).toBeNull();
  });

  it("returns a permanent redirect response for the alias", () => {
    const previous = process.env.COMPANION_WEB_URL;
    process.env.COMPANION_WEB_URL = "https://thecompanion.sh";
    try {
      const response = middleware(new NextRequest("https://www.thecompanion.sh/login?next=%2Fskills"));
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("https://thecompanion.sh/login?next=%2Fskills");
    } finally {
      if (previous === undefined) delete process.env.COMPANION_WEB_URL;
      else process.env.COMPANION_WEB_URL = previous;
    }
  });
});
