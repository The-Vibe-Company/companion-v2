import { describe, expect, it } from "vitest";
import {
  authorizationUsesRemoteAgentJwks,
  canonicalAgentAuthHeaders,
  canonicalizeAgentAuthRequest,
  guardAgentAuthRemoteKeys,
  isAgentAuthProtocolPath,
} from "./agent-auth-origin";

const publicOrigin = "https://companion.example.com";

describe("Agent Auth canonical public origin", () => {
  it("accepts only the configured direct host", () => {
    const canonical = canonicalAgentAuthHeaders(new Headers({ host: "companion.example.com" }), publicOrigin);
    expect(canonical?.get("host")).toBe("companion.example.com");

    expect(canonicalAgentAuthHeaders(new Headers({ host: "attacker.example" }), publicOrigin)).toBeNull();
  });

  it("accepts an internal proxy host only with exact single-valued public forwarding headers", () => {
    const canonical = canonicalAgentAuthHeaders(new Headers({
      host: "api.internal:8080",
      "x-forwarded-host": "companion.example.com",
      "x-forwarded-proto": "https",
      "x-forwarded-port": "443",
      "x-forwarded-for": "192.0.2.10",
    }), publicOrigin);
    expect(canonical?.get("host")).toBe("companion.example.com");
    expect(canonical?.get("x-forwarded-host")).toBeNull();
    expect(canonical?.get("x-forwarded-proto")).toBeNull();
    expect(canonical?.get("x-forwarded-port")).toBeNull();
    expect(canonical?.get("x-forwarded-for")).toBe("192.0.2.10");

    expect(canonicalAgentAuthHeaders(new Headers({
      host: "api.internal:8080",
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "https",
    }), publicOrigin)).toBeNull();
    expect(canonicalAgentAuthHeaders(new Headers({
      host: "api.internal:8080",
      "x-forwarded-host": "companion.example.com, attacker.example",
      "x-forwarded-proto": "https",
    }), publicOrigin)).toBeNull();
    expect(canonicalAgentAuthHeaders(new Headers({
      host: "api.internal:8080",
      "x-forwarded-host": "companion.example.com",
      "x-forwarded-proto": "http",
    }), publicOrigin)).toBeNull();
  });

  it("accepts the fixed public-origin marker from a proxy that rewrites forwarding headers", () => {
    const canonical = canonicalAgentAuthHeaders(new Headers({
      host: "api.internal:8080",
      "x-forwarded-host": "railway.internal",
      "x-forwarded-proto": "https",
      "x-companion-agent-auth-origin": publicOrigin,
    }), publicOrigin);
    expect(canonical?.get("host")).toBe("companion.example.com");
    expect(canonical?.get("x-companion-agent-auth-origin")).toBeNull();

    expect(canonicalAgentAuthHeaders(new Headers({
      host: "api.internal:8080",
      "x-companion-agent-auth-origin": "https://attacker.example",
    }), publicOrigin)).toBeNull();
    expect(canonicalAgentAuthHeaders(new Headers({
      host: "api.internal:8080",
      "x-companion-agent-auth-origin": `${publicOrigin}, https://attacker.example`,
    }), publicOrigin)).toBeNull();
  });

  it("canonicalizes only Agent Auth protocol routes and preserves request bodies", async () => {
    expect(isAgentAuthProtocolPath("/auth/agent/register")).toBe(true);
    expect(isAgentAuthProtocolPath("/auth/host/update")).toBe(true);
    expect(isAgentAuthProtocolPath("/auth/capability/execute")).toBe(true);
    expect(isAgentAuthProtocolPath("/auth/sign-in/email")).toBe(false);

    const original = new Request("https://companion.example.com/auth/agent/register", {
      method: "POST",
      headers: { host: "companion.example.com", "content-type": "application/json" },
      body: JSON.stringify({ name: "Codex" }),
    });
    const canonical = canonicalizeAgentAuthRequest(original, publicOrigin);
    expect(canonical).not.toBeNull();
    expect(await canonical?.json()).toEqual({ name: "Codex" });
  });

  it("rejects remote JWKS claims and host fields while allowing inline public keys", async () => {
    const jwt = (payload: Record<string, unknown>) => [
      Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "host+jwt" })).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "signature",
    ].join(".");

    expect(authorizationUsesRemoteAgentJwks(`Bearer ${jwt({ host_jwks_url: "https://keys.example/jwks" })}`))
      .toBe(true);
    expect(authorizationUsesRemoteAgentJwks(`Bearer ${jwt({ agent_jwks_url: "https://keys.example/jwks" })}`))
      .toBe(true);
    expect(authorizationUsesRemoteAgentJwks(`Bearer ${jwt({ host_public_key: { kty: "OKP", x: "key" } })}`))
      .toBe(false);

    const remoteBody = new Request("https://companion.example.com/auth/host/create/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jwks_url: "https://keys.example/jwks" }),
    });
    await expect(guardAgentAuthRemoteKeys(remoteBody)).resolves.toBe("remote-jwks");

    const inlineBody = new Request("https://companion.example.com/auth/host/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_key: { kty: "OKP", crv: "Ed25519", x: "key" } }),
    });
    await expect(guardAgentAuthRemoteKeys(inlineBody)).resolves.toBe("allowed");
  });
});
