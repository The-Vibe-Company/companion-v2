import { describe, expect, it } from "vitest";
import {
  isAllowedOrgLogoFile,
  orgSettingsResponseSchema,
  ORG_LOGO_FILE_ACCEPT,
  resolveOrgLogoContentType,
  updateOrgInputSchema,
} from "../src/orgSettings";

const org = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  kind: "team" as const,
  plan: "team" as const,
  createdAt: "2026-06-01T12:00:00.000Z",
  domain: null,
  domainAutoJoin: false,
  accessDomains: [],
  color: null,
  logoUrl: null,
};

const domainJoin = {
  actorDomain: "example.com",
  actorDomainIsPersonal: false,
};

// Teams were removed product-wide (Org → User): the org-settings payload is org + members +
// invitations only, with no team blocks.
const validPayload = {
  org,
  domainJoin,
  members: [
    {
      userId: "user_1",
      role: "owner",
      joined: "2026-06-08T12:00:00.000Z",
      pending: false,
      name: "Stan Girard",
      email: "stan@example.com",
      initials: "SG",
      avatarUrl: null,
    },
  ],
  invitations: [],
};

describe("orgSettingsResponseSchema", () => {
  it("parses a valid full payload unchanged", () => {
    expect(orgSettingsResponseSchema.parse(validPayload)).toEqual(validPayload);
  });

  it("defaults missing members and invitations to empty arrays", () => {
    const parsed = orgSettingsResponseSchema.parse({ org, domainJoin });
    expect(parsed.members).toEqual([]);
    expect(parsed.invitations).toEqual([]);
  });

  it("has no teams field on the response shape", () => {
    const parsed = orgSettingsResponseSchema.parse(validPayload);
    expect("teams" in parsed).toBe(false);
  });

  it("safeParse succeeds on a payload with org, members, and invitations", () => {
    const result = orgSettingsResponseSchema.safeParse({
      org,
      domainJoin,
      members: validPayload.members,
      invitations: [
        {
          id: "invite_1",
          email: "newbie@example.com",
          role: "developer",
          token: "tok_abc123",
          status: "pending",
          createdAt: "2026-06-08T12:00:00.000Z",
          expiresAt: "2026-06-22T12:00:00.000Z",
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.invitations[0]?.email).toBe("newbie@example.com");
  });

  it("rejects a payload missing the org identity", () => {
    expect(() => orgSettingsResponseSchema.parse({ members: validPayload.members })).toThrow();
  });

  it("rejects a non-array members field", () => {
    expect(() => orgSettingsResponseSchema.parse({ org, domainJoin, members: {} })).toThrow();
  });
});

describe("updateOrgInputSchema (workspace branding survives; team brand colors reused)", () => {
  it("rejects arbitrary CSS in color", () => {
    expect(() => updateOrgInputSchema.parse({ color: "url(https://evil.test/x.png)" })).toThrow();
  });

  it("accepts a palette color", () => {
    expect(updateOrgInputSchema.parse({ color: "oklch(0.56 0.13 250)" })).toMatchObject({
      color: "oklch(0.56 0.13 250)",
    });
  });

  it("requires at least one field to update", () => {
    expect(() => updateOrgInputSchema.parse({})).toThrow();
  });
});

describe("org logo file accept", () => {
  it("includes logo extensions for native file pickers", () => {
    expect(ORG_LOGO_FILE_ACCEPT).toBe(".png,.jpg,.jpeg,.webp,.gif");
    expect(ORG_LOGO_FILE_ACCEPT).not.toContain("image/");
  });

  it("resolves MIME type from extension when the browser omits file.type", () => {
    expect(resolveOrgLogoContentType({ type: "", name: "logo.PNG" })).toBe("image/png");
    expect(resolveOrgLogoContentType({ type: "application/octet-stream", name: "brand.webp" })).toBe("image/webp");
  });

  it("rejects unsupported files", () => {
    expect(isAllowedOrgLogoFile({ type: "application/pdf", name: "logo.pdf" })).toBe(false);
    expect(isAllowedOrgLogoFile({ type: "image/svg+xml", name: "logo.svg" })).toBe(false);
  });
});
