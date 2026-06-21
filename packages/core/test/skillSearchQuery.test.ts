import { describe, expect, it } from "vitest";
import { toPrefixTsQuery } from "../src/services";

// The skill content search builds its `to_tsquery` input from raw user text. It must (a) enable prefix
// matching so "depl" finds "deploy", and (b) never let user input carry tsquery operators — otherwise a
// query like "a & b" or "foo:*!" would raise a Postgres syntax error at runtime.
describe("toPrefixTsQuery", () => {
  it("turns each term into a prefix-matched AND query", () => {
    expect(toPrefixTsQuery("deploy kube")).toBe("deploy:* & kube:*");
  });

  it("lowercases and collapses arbitrary whitespace", () => {
    expect(toPrefixTsQuery("  Deploy   Kube ")).toBe("deploy:* & kube:*");
  });

  it("strips tsquery operators and punctuation so input can never be a syntax injection", () => {
    expect(toPrefixTsQuery("a & b | c:*! (d)")).toBe("a:* & b:* & c:* & d:*");
    expect(toPrefixTsQuery("foo-bar.baz")).toBe("foo:* & bar:* & baz:*");
  });

  it("keeps digits as searchable terms", () => {
    expect(toPrefixTsQuery("v2 log4j")).toBe("v2:* & log4j:*");
  });

  it("returns null when there is no usable term (empty / whitespace / punctuation only)", () => {
    expect(toPrefixTsQuery("")).toBeNull();
    expect(toPrefixTsQuery("   ")).toBeNull();
    expect(toPrefixTsQuery("###")).toBeNull();
  });
});
