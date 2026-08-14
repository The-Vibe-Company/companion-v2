import { describe, expect, it } from "vitest";
import {
  companionPluginOAuthStartInputSchema,
  companionPluginOAuthServerNameSchema,
} from "../src/companionRegistry";

describe("Companion plugin OAuth contracts", () => {
  it("allows only curated catalog pins and requires a label", () => {
    expect(companionPluginOAuthStartInputSchema.parse({
      server_name: "app.linear/linear",
      label: "  work  ",
    })).toEqual({ server_name: "app.linear/linear", label: "work" });
    expect(companionPluginOAuthServerNameSchema.safeParse(
      "io.github.github/github-mcp-server",
    ).success).toBe(true);
    expect(companionPluginOAuthServerNameSchema.safeParse("io.example/custom").success).toBe(false);
    expect(companionPluginOAuthStartInputSchema.safeParse({
      server_name: "com.notion/mcp",
      label: " ",
    }).success).toBe(false);
  });
});
