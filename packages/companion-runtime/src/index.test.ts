import { describe, expect, it } from "vitest";
import { createRuntimeKernel } from "./index";

describe("createRuntimeKernel", () => {
  it("refuses to enable claims without a credential-aware projection redactor", () => {
    expect(() => createRuntimeKernel({
      store: {} as never,
      box: {} as never,
      pi: {} as never,
      resourceStager: {} as never,
      executorId: "executor-test",
      claimsEnabled: true,
    })).toThrow("Runtime claims require a credential-aware projection redactor");
  });
});
