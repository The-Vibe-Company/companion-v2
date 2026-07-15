import { describe, expect, it } from "vitest";
import {
  parseLastEventId,
  parseRunEventNotification,
  runDrainAction,
  runEventFrame,
  runReadyFrame,
} from "./runEvents";

describe("run event SSE helpers", () => {
  it("accepts only safe non-negative integer replay cursors", () => {
    expect(parseLastEventId(undefined)).toBe(0);
    expect(parseLastEventId("17")).toBe(17);
    expect(parseLastEventId("-1")).toBe(0);
    expect(parseLastEventId("1.5")).toBe(0);
    expect(parseLastEventId("9007199254740992")).toBe(0);
  });

  it("formats a replayable frame with an id", () => {
    expect(
      runEventFrame({
        sequence: 4,
        event: { type: "status", state: "busy", attempt: null, message: null },
        created_at: "2026-07-13T12:00:00.000Z",
      }),
    ).toBe('id: 4\nevent: message\ndata: {"type":"status","state":"busy","attempt":null,"message":null}\n\n');
  });

  it("rejects malformed notification payloads", () => {
    expect(parseRunEventNotification('{"run_id":"run-1","sequence":5}')).toEqual({ runId: "run-1", sequence: 5 });
    expect(parseRunEventNotification('{"run_id":"run-1","sequence":0}')).toBeNull();
    expect(parseRunEventNotification("not-json")).toBeNull();
  });

  it("emits ready after an empty caught-up replay, even when the cursor is already current", () => {
    expect(runDrainAction({ eventCount: 0, pageSize: 500, notified: false, terminal: false, terminalObserved: false, readySent: false })).toBe("ready");
    expect(runReadyFrame()).toBe('event: message\ndata: {"type":"ready","session_id":""}\n\n');
    expect(runDrainAction({ eventCount: 0, pageSize: 500, notified: false, terminal: false, terminalObserved: false, readySent: true })).toBe("wait");
  });

  it("drains notifications before ready and closes a caught-up terminal stream", () => {
    expect(runDrainAction({ eventCount: 500, pageSize: 500, notified: false, terminal: false, terminalObserved: false, readySent: false })).toBe("continue");
    expect(runDrainAction({ eventCount: 0, pageSize: 500, notified: true, terminal: false, terminalObserved: false, readySent: false })).toBe("continue");
    expect(runDrainAction({ eventCount: 0, pageSize: 500, notified: false, terminal: true, terminalObserved: false, readySent: false })).toBe("continue");
    expect(runDrainAction({ eventCount: 0, pageSize: 500, notified: false, terminal: true, terminalObserved: true, readySent: false })).toBe("close");
  });
});
