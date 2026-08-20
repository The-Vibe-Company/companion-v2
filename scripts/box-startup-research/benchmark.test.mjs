import assert from "node:assert/strict";
import test from "node:test";

import { validateLeaseGrant } from "./benchmark.mjs";
import { leaseTokenHash, resourcePrefix } from "./contracts.mjs";

const RUN_ID = "bsr-20260820-aaaaaa";
const CANDIDATE_ID = "w1-c1";
const TREE_SHA = "a".repeat(40);
const TOKEN = "b".repeat(32);
const NOW = Date.parse("2026-08-20T12:00:00.000Z");

function rawLease(overrides = {}) {
  return {
    runId: RUN_ID,
    candidateId: CANDIDATE_ID,
    phase: "quick",
    resourcePrefix: resourcePrefix(RUN_ID, CANDIDATE_ID),
    expiresAt: new Date(NOW + 45 * 60_000).toISOString(),
    cycles: 3,
    treeSha: TREE_SHA,
    ...overrides,
  };
}

function verification(overrides = {}) {
  return {
    token: TOKEN,
    tokenHash: leaseTokenHash(TOKEN),
    actualTreeSha: TREE_SHA,
    now: NOW,
    ...overrides,
  };
}

test("accepts only the exact granted benchmark identity", () => {
  const lease = validateLeaseGrant(rawLease(), verification());
  assert.equal(lease.resourcePrefix, resourcePrefix(RUN_ID, CANDIDATE_ID));
});

test("rejects a benchmark without a grant or with a bad token", () => {
  assert.throws(() => validateLeaseGrant(rawLease(), verification({ tokenHash: undefined })), /token hash/);
  assert.throws(() => validateLeaseGrant(rawLease(), verification({ token: "c".repeat(32) })), /token is invalid/);
});

test("rejects a valid-shaped prefix outside the lease", () => {
  assert.throws(() => validateLeaseGrant(
    rawLease({ resourcePrefix: "box-startup-0123456789abcdef" }),
    verification(),
  ), /outside the lease/);
});

test("rejects expired, overlong, and cross-tree leases", () => {
  assert.throws(() => validateLeaseGrant(
    rawLease({ expiresAt: new Date(NOW).toISOString() }),
    verification(),
  ), /expired/);
  assert.throws(() => validateLeaseGrant(
    rawLease({ expiresAt: new Date(NOW + 61 * 60_000).toISOString() }),
    verification(),
  ), /expired/);
  assert.throws(() => validateLeaseGrant(
    rawLease(),
    verification({ actualTreeSha: "d".repeat(40) }),
  ), /tree does not match/);
});
