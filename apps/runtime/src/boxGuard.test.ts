import { describe, expect, it, vi } from "vitest";

import { preventImplicitBoxCreate } from "./boxGuard";

describe("runtime Box staging guard", () => {
  it("forces every broad start call to refuse implicit Box creation", async () => {
    const start = vi.fn(async (input: Record<string, unknown>) => input);
    const original = { marker: 7, start };
    const guarded = preventImplicitBoxCreate(original);
    const callerInput = { boxId: "bx_23456789", allowBoxCreate: true };

    await expect(guarded.start(callerInput)).resolves.toEqual({
      boxId: "bx_23456789",
      allowBoxCreate: false,
    });
    expect(callerInput.allowBoxCreate).toBe(true);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ allowBoxCreate: false }));
  });

  it("binds other methods to adapters that use private fields", () => {
    class Adapter {
      readonly #value = "bound";
      start(): Promise<void> { return Promise.resolve(); }
      status(): string { return this.#value; }
    }
    const guarded = preventImplicitBoxCreate(new Adapter());
    expect(guarded.status()).toBe("bound");
  });
});
