import { describe, expect, it } from "vitest";
import { classifyEmailDomain, isCorporateDomain } from "../src/email-domains";

describe("classifyEmailDomain", () => {
  it("flags well-known free providers as personal", () => {
    expect(classifyEmailDomain("alex@gmail.com")).toEqual({ domain: "gmail.com", isPersonal: true });
    expect(classifyEmailDomain("alex@outlook.com").isPersonal).toBe(true);
    expect(classifyEmailDomain("alex@yahoo.com").isPersonal).toBe(true);
    expect(classifyEmailDomain("alex@proton.me").isPersonal).toBe(true);
  });

  it("treats a corporate domain as not personal", () => {
    expect(classifyEmailDomain("alex@acme.com")).toEqual({ domain: "acme.com", isPersonal: false });
    expect(classifyEmailDomain("dev@northwind.io").isPersonal).toBe(false);
  });

  it("normalizes case and a trailing dot", () => {
    expect(classifyEmailDomain("Alex@GMail.Com")).toEqual({ domain: "gmail.com", isPersonal: true });
    expect(classifyEmailDomain("alex@outlook.com.")).toEqual({ domain: "outlook.com", isPersonal: true });
  });

  it("uses the last @ to find the domain", () => {
    expect(classifyEmailDomain("weird@name@example.com")).toEqual({ domain: "example.com", isPersonal: false });
  });

  it("does not match vanity subdomains of free providers (documented limitation)", () => {
    expect(classifyEmailDomain("you@mail.gmail.com").isPersonal).toBe(false);
  });

  it("returns null for malformed addresses", () => {
    expect(classifyEmailDomain("no-at-sign")).toEqual({ domain: null, isPersonal: false });
    expect(classifyEmailDomain("trailing@")).toEqual({ domain: null, isPersonal: false });
    expect(classifyEmailDomain("")).toEqual({ domain: null, isPersonal: false });
  });
});

describe("isCorporateDomain", () => {
  it("is true only for non-free, well-formed domains", () => {
    expect(isCorporateDomain("alex@acme.com")).toBe(true);
    expect(isCorporateDomain("alex@gmail.com")).toBe(false);
    expect(isCorporateDomain("no-at-sign")).toBe(false);
  });
});
