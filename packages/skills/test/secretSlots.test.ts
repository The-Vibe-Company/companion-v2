import { describe, expect, it } from "vitest";
import { deterministicSecretSlotId, withSecretSlotIds } from "../src/manifest";

describe("secret slot normalization", () => {
  const skillId = "84d8bee1-5ad3-4676-8c16-730e2a15ba70";

  it("derives stable UUIDs from skill identity and env key", () => {
    const left = deterministicSecretSlotId(skillId, "LINEAR_API_KEY");
    const right = deterministicSecretSlotId(skillId, "LINEAR_API_KEY");
    expect(left).toBe(right);
    expect(left).toBe("c8868fb3-c654-5615-b477-ce8d807ab722");
    expect(left).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deterministicSecretSlotId(skillId, "OTHER_KEY")).not.toBe(left);
  });

  it("preserves explicit slot ids across env-key renames", () => {
    const slotId = "df80d275-30c9-5f0d-9a46-d77e6fca8448";
    const environment = withSecretSlotIds(
      {
        env: {},
        secrets: { RENAMED_KEY: { slotId, required: true, description: "Renamed only." } },
      },
      skillId,
    );
    expect(environment.secrets.RENAMED_KEY?.slotId).toBe(slotId);
  });
});
