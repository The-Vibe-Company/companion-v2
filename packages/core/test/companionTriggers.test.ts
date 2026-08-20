import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMPANION_TRIGGER_PAYLOAD_EXCERPT_MAX_CHARACTERS,
  COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS,
} from "@companion/contracts";
import { ROUTINE_FIRE_NAMESPACE, routineFireMessageId } from "../src/companionRoutineFireId";
import { TRIGGER_FIRE_NAMESPACE, triggerFireMessageId } from "../src/companionTriggerFireId";
import {
  COMPANION_TRIGGER_PAYLOAD_HEADER,
  composeTriggerPrompt,
  extractTriggerDeliveryId,
  generateCompanionTriggerSecret,
} from "../src/companionTriggersApi";

const TRIGGER = "22222222-2222-4222-8222-222222222222";
const OTHER_TRIGGER = "33333333-3333-4333-8333-333333333333";
const FRAMING_LENGTH = `\n\n${COMPANION_TRIGGER_PAYLOAD_HEADER}\n`.length;

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

describe("composeTriggerPrompt", () => {
  it("appends the payload under the untrusted header when it fits whole", () => {
    const composed = composeTriggerPrompt("Triage the ticket.", '{"action":"opened"}');
    expect(composed).toBe(
      `Triage the ticket.\n\n${COMPANION_TRIGGER_PAYLOAD_HEADER}\n{"action":"opened"}`,
    );
  });

  it("truncates the payload to the 4096-character excerpt cap", () => {
    const body = "x".repeat(COMPANION_TRIGGER_PAYLOAD_EXCERPT_MAX_CHARACTERS + 1000);
    const composed = composeTriggerPrompt("p", body);
    expect(composed.endsWith("x".repeat(10))).toBe(true);
    expect(composed.length).toBe(
      1 + FRAMING_LENGTH + COMPANION_TRIGGER_PAYLOAD_EXCERPT_MAX_CHARACTERS,
    );
  });

  it("shrinks the excerpt so the whole prompt stays under the enqueue cap", () => {
    const prompt = "p".repeat(COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS - FRAMING_LENGTH - 100);
    const composed = composeTriggerPrompt(prompt, "y".repeat(10_000));
    expect(composed.length).toBe(COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS);
    expect(composed.endsWith("y".repeat(100))).toBe(true);
  });

  it("returns the prompt unchanged when the prompt leaves no budget", () => {
    const prompt = "p".repeat(COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS - FRAMING_LENGTH);
    expect(composeTriggerPrompt(prompt, "payload")).toBe(prompt);
    const oversize = "p".repeat(COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS);
    expect(composeTriggerPrompt(oversize, "payload")).toBe(oversize);
  });

  it("returns the prompt unchanged when the body is empty", () => {
    expect(composeTriggerPrompt("Triage the ticket.", "")).toBe("Triage the ticket.");
  });

  it("never exceeds the enqueue cap and never strands half a surrogate pair", () => {
    for (const promptLength of [1, 8_000, 12_000, COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS - FRAMING_LENGTH - 1]) {
      const composed = composeTriggerPrompt("p".repeat(promptLength), "😀".repeat(5_000));
      expect(composed.length).toBeLessThanOrEqual(COMPANION_TRIGGER_PROMPT_MAX_CHARACTERS);
      const last = composed.charCodeAt(composed.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});

describe("triggerFireMessageId", () => {
  it("stamps a stable uuidv5 for the same trigger and delivery id", () => {
    const first = triggerFireMessageId({ triggerId: TRIGGER, deliveryId: "delivery-1" });
    expect(first).toBe(triggerFireMessageId({ triggerId: TRIGGER, deliveryId: "delivery-1" }));
    expect(first).toBe("18317525-e26f-52e3-9c05-51291602c13c");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(TRIGGER_FIRE_NAMESPACE).toMatch(/^[0-9a-f-]{36}$/);
    expect(TRIGGER_FIRE_NAMESPACE).not.toBe(ROUTINE_FIRE_NAMESPACE);
  });

  it("differs across triggers and across deliveries", () => {
    const first = triggerFireMessageId({ triggerId: TRIGGER, deliveryId: "delivery-1" });
    expect(triggerFireMessageId({ triggerId: OTHER_TRIGGER, deliveryId: "delivery-1" }))
      .not.toBe(first);
    expect(triggerFireMessageId({ triggerId: TRIGGER, deliveryId: "delivery-2" }))
      .not.toBe(first);
  });

  it("leaves the shared uuidv5 helper bit-identical for routine fires", () => {
    expect(routineFireMessageId({
      routineId: "11111111-1111-4111-8111-111111111111",
      scheduledFor: new Date("2026-08-19T09:00:00.000Z"),
    })).toBe("1c25ac3c-e2a8-5950-99c5-c416bb572d13");
  });
});

describe("extractTriggerDeliveryId", () => {
  it("prefers the GitHub header, then Linear, then the generic one", () => {
    expect(extractTriggerDeliveryId(headers({
      "x-github-delivery": "gh-1",
      "linear-delivery": "ln-1",
      "x-companion-delivery": "cp-1",
    }), "body")).toBe("gh-1");
    expect(extractTriggerDeliveryId(headers({
      "linear-delivery": "ln-1",
      "x-companion-delivery": "cp-1",
    }), "body")).toBe("ln-1");
    expect(extractTriggerDeliveryId(headers({ "x-companion-delivery": "cp-1" }), "body"))
      .toBe("cp-1");
  });

  it("sanitizes header values: strips CRLF, trims, and caps at 200 characters", () => {
    expect(extractTriggerDeliveryId(headers({ "x-github-delivery": "  gh\r\n-1  " }), "body"))
      .toBe("gh-1");
    expect(extractTriggerDeliveryId(headers({ "x-github-delivery": "a".repeat(500) }), "body"))
      .toBe("a".repeat(200));
  });

  it("falls back to the body digest when headers are absent or blank", () => {
    const digest = createHash("sha256").update("payload-bytes").digest("hex");
    expect(extractTriggerDeliveryId(headers({}), "payload-bytes")).toBe(digest);
    expect(extractTriggerDeliveryId(headers({ "x-github-delivery": "  \r\n " }), "payload-bytes"))
      .toBe(digest);
    expect(extractTriggerDeliveryId(headers({}), "other-bytes")).not.toBe(digest);
  });
});

describe("generateCompanionTriggerSecret", () => {
  it("mints 64 lowercase hex characters, fresh every time", () => {
    const first = generateCompanionTriggerSecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(generateCompanionTriggerSecret()).not.toBe(first);
  });
});
