import { describe, expect, it } from "vitest";
import { hasInternalProductAccess } from "../src/internalProductAccess";

describe("hasInternalProductAccess", () => {
  it("allows only the exact internal domain, case-insensitively", () => {
    expect(hasInternalProductAccess("stan@thevibecompany.co")).toBe(true);
    expect(hasInternalProductAccess("Stan@THEVIBECOMPANY.CO")).toBe(true);
    expect(hasInternalProductAccess("first.last+pilot@thevibecompany.co")).toBe(true);
  });

  it("rejects subdomains and suffix lookalikes", () => {
    expect(hasInternalProductAccess("stan@team.thevibecompany.co")).toBe(false);
    expect(hasInternalProductAccess("stan@thevibecompany.co.evil.test")).toBe(false);
    expect(hasInternalProductAccess("stan@evilthevibecompany.co")).toBe(false);
    expect(hasInternalProductAccess("stan@thevibecompany.com")).toBe(false);
  });

  it("fails closed for malformed addresses", () => {
    for (const email of [
      null,
      undefined,
      "",
      "thevibecompany.co",
      "@thevibecompany.co",
      "stan@",
      "stan@@thevibecompany.co",
      "stan @thevibecompany.co",
      " stan@thevibecompany.co",
      "stan@thevibecompany.co ",
      ".stan@thevibecompany.co",
      "stan.@thevibecompany.co",
      "st..an@thevibecompany.co",
    ]) {
      expect(hasInternalProductAccess(email)).toBe(false);
    }
  });
});
