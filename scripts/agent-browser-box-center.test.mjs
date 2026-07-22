import assert from "node:assert/strict";
import test from "node:test";
import { boxCenterFromAgentBrowserPayload } from "./agent-browser-box-center.mjs";

test("reads the nested box shape returned by current agent-browser releases", () => {
  assert.deepEqual(boxCenterFromAgentBrowserPayload({
    success: true,
    data: { box: { x: 10, y: 20, width: 100, height: 50 } },
  }), [60, 45]);
});

test("keeps compatibility with the legacy flat data shape", () => {
  assert.deepEqual(boxCenterFromAgentBrowserPayload({
    data: { x: 4, y: 8, width: 11, height: 7 },
  }), [10, 12]);
});

test("rejects malformed bounding boxes before issuing mouse commands", () => {
  assert.throws(
    () => boxCenterFromAgentBrowserPayload({ success: true, data: { box: null } }),
    /invalid bounding box/,
  );
});
