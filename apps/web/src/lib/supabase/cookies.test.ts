import { describe, expect, it } from "vitest";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const { authCookieName } = await import("./cookies");

describe("authCookieName", () => {
  it("isolates local Supabase sessions by API port", () => {
    expect(authCookieName("http://127.0.0.1:55031")).toBe("companion-auth-127-0-0-1-55031");
    expect(authCookieName("http://127.0.0.1:55041")).toBe("companion-auth-127-0-0-1-55041");
  });

  it("sanitizes hostnames for cookie storage keys", () => {
    expect(authCookieName("https://project-ref.supabase.co")).toBe("companion-auth-project-ref-supabase-co");
  });

  it("uses a stable fallback when the Supabase URL is absent or invalid", () => {
    expect(authCookieName("")).toBe("companion-auth-local");
    expect(authCookieName("not a url")).toBe("companion-auth-local");
  });
});
