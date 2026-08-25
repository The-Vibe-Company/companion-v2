import { describe, expect, it } from "vitest";

import {
  companionDirectTransportMode,
  parseHostedAgentEndpoint,
} from "./boxCompanionRuntime";

describe("companionDirectTransportMode", () => {
  it("defaults to off and accepts the three rollout values case-insensitively", () => {
    expect(companionDirectTransportMode({})).toBe("off");
    expect(companionDirectTransportMode({ COMPANION_DIRECT_TRANSPORT: "" })).toBe("off");
    expect(companionDirectTransportMode({ COMPANION_DIRECT_TRANSPORT: "off" })).toBe("off");
    expect(companionDirectTransportMode({ COMPANION_DIRECT_TRANSPORT: " Shadow " })).toBe("shadow");
    expect(companionDirectTransportMode({ COMPANION_DIRECT_TRANSPORT: "ON" })).toBe("on");
  });

  it("refuses a misspelled rollout value instead of silently staying off", () => {
    expect(() => companionDirectTransportMode({ COMPANION_DIRECT_TRANSPORT: "enabled" }))
      .toThrowError(/must be off, shadow, or on/);
  });
});

describe("parseHostedAgentEndpoint", () => {
  const token = "f".repeat(64);

  it("splits a provider-hosted URL into a token-free locator and the proxy token", () => {
    expect(parseHostedAgentEndpoint(`https://abc-8790.on.ascii.dev?_token=${token}`)).toEqual({
      hostedUrl: "https://abc-8790.on.ascii.dev",
      proxyToken: token,
    });
    expect(parseHostedAgentEndpoint(`https://abc-8790.on.ascii.dev/?_token=${token}`)).toEqual({
      hostedUrl: "https://abc-8790.on.ascii.dev",
      proxyToken: token,
    });
    // The plain-HTTP path-carrying form exists only for the deterministic Box simulator.
    expect(parseHostedAgentEndpoint(`http://127.0.0.1:13401/boxes/bx_23456789?_token=${token}`))
      .toEqual({
        hostedUrl: "http://127.0.0.1:13401/boxes/bx_23456789",
        proxyToken: token,
      });
  });

  it("rejects anything that is not a tokened provider URL", () => {
    expect(parseHostedAgentEndpoint(undefined)).toBeNull();
    expect(parseHostedAgentEndpoint("not a url")).toBeNull();
    expect(parseHostedAgentEndpoint("https://abc-8790.on.ascii.dev")).toBeNull();
    expect(parseHostedAgentEndpoint("https://abc-8790.on.ascii.dev?_token=short")).toBeNull();
    expect(parseHostedAgentEndpoint(`ftp://abc.on.ascii.dev?_token=${token}`)).toBeNull();
    expect(parseHostedAgentEndpoint(`https://user:pass@abc.on.ascii.dev?_token=${token}`)).toBeNull();
    expect(parseHostedAgentEndpoint(`https://abc.on.ascii.dev?_token=${token}#frag`)).toBeNull();
    expect(parseHostedAgentEndpoint(`https://abc.on.ascii.dev?_token=${"g!".repeat(20)}`)).toBeNull();
  });
});
