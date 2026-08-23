import { describe, expect, it } from "vitest";
import { expo } from "@better-auth/expo";

import { mobileAuthOrigins } from "./mobile-auth";

describe("mobile auth origins", () => {
  it("trusts only the production app scheme in production", () => {
    expect(mobileAuthOrigins("production")).toEqual([
      "dev.companion.mobile://",
      "dev.companion.mobile://*",
    ]);
  });

  it("adds the isolated development app scheme outside production", () => {
    expect(mobileAuthOrigins("development")).toEqual([
      "dev.companion.mobile://",
      "dev.companion.mobile://*",
      "dev.companion.mobile.dev://",
      "dev.companion.mobile.dev://*",
    ]);
  });

  it("mounts the Expo authorization proxy under the existing auth base path", () => {
    expect(expo().endpoints.expoAuthorizationProxy.path).toBe("/expo-authorization-proxy");
  });
});
