import { describe, expect, it } from "vitest";
import { publishRunArtifact, vanishBlockedExtension, VanishError } from "../src/vanish";

function stubFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (url: unknown, init?: unknown) => handler(String(url), (init ?? {}) as RequestInit)) as typeof fetch;
}

describe("publishRunArtifact", () => {
  it("POSTs raw bytes with Bearer auth, X-Filename and Idempotency-Key, and parses the result", async () => {
    let seen: { url: string; headers: Record<string, string>; body: Uint8Array } | null = null;
    const fetcher = stubFetch((url, init) => {
      seen = {
        url,
        headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
        body: init.body as Uint8Array,
      };
      return new Response(JSON.stringify({ url: "https://vanish.sh/f/abc123", id: "abc123", expiresAt: "2026-07-14T00:00:00Z" }), {
        status: 200,
      });
    });

    const result = await publishRunArtifact({
      apiKey: "vk_test",
      filename: "reports/report.html",
      bytes: Buffer.from("<h1>hi</h1>"),
      idempotencyKey: "run-1:reports/report.html:11",
      apiUrl: "https://vanish.example",
      fetcher,
    });

    expect(seen!.url).toBe("https://vanish.example/upload");
    expect(seen!.headers["authorization"]).toBe("Bearer vk_test");
    expect(seen!.headers["content-type"]).toBe("application/octet-stream");
    // X-Filename is the basename only — sandbox-relative paths never leak into Vanish metadata.
    expect(seen!.headers["x-filename"]).toBe("report.html");
    expect(seen!.headers["idempotency-key"]).toBe("run-1:reports/report.html:11");
    expect(Buffer.from(seen!.body).toString("utf8")).toBe("<h1>hi</h1>");
    expect(result).toEqual({ url: "https://vanish.sh/f/abc123", id: "abc123", expiresAt: "2026-07-14T00:00:00Z" });
  });

  it("normalizes response field aliases (public_url / upload_id / expires_at)", async () => {
    const fetcher = stubFetch(() =>
      new Response(JSON.stringify({ public_url: "https://vanish.sh/f/x", upload_id: "x", expires_at: "2026-08-01T00:00:00Z" }), {
        status: 200,
      }),
    );
    const result = await publishRunArtifact({ apiKey: "k", filename: "a.txt", bytes: Buffer.from("a"), fetcher });
    expect(result).toEqual({ url: "https://vanish.sh/f/x", id: "x", expiresAt: "2026-08-01T00:00:00Z" });
  });

  it("throws a structured VanishError on API errors (code, hint, upgradeRequired)", async () => {
    const fetcher = stubFetch(
      () =>
        new Response(
          JSON.stringify({ code: "quota_exceeded", message: "Monthly quota exceeded", hint: "Upgrade your plan", upgradeRequired: true }),
          { status: 402 },
        ),
    );
    const error = await publishRunArtifact({ apiKey: "k", filename: "a.txt", bytes: Buffer.from("a"), fetcher }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(VanishError);
    expect(error.message).toBe("Monthly quota exceeded");
    expect(error.code).toBe("quota_exceeded");
    expect(error.hint).toBe("Upgrade your plan");
    expect(error.upgradeRequired).toBe(true);
  });

  it("throws when the response is OK but carries no url", async () => {
    const fetcher = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await expect(publishRunArtifact({ apiKey: "k", filename: "a.txt", bytes: Buffer.from("a"), fetcher })).rejects.toThrow(
      /returned no url/,
    );
  });

  it("rejects unsafe public URL schemes and credentials", async () => {
    for (const url of ["javascript:alert(1)", "http://example.com/file", "https://user:pass@example.com/file"]) {
      const fetcher = stubFetch(() => new Response(JSON.stringify({ url }), { status: 200 }));
      await expect(
        publishRunArtifact({ apiKey: "k", filename: "a.txt", bytes: Buffer.from("a"), fetcher }),
      ).rejects.toThrow(/invalid public url/);
    }
  });

  it("wraps network failures in VanishError", async () => {
    const fetcher = (async () => {
      throw new Error("socket hang up");
    }) as typeof fetch;
    await expect(publishRunArtifact({ apiKey: "k", filename: "a.txt", bytes: Buffer.from("a"), fetcher })).rejects.toThrow(
      /vanish upload failed: socket hang up/,
    );
  });
});

describe("vanishBlockedExtension", () => {
  it("blocks executables/scripts and allows deliverables", () => {
    expect(vanishBlockedExtension("run.sh")).toBe(true);
    expect(vanishBlockedExtension("Setup.EXE")).toBe(true);
    expect(vanishBlockedExtension("deploy.ps1")).toBe(true);
    expect(vanishBlockedExtension("report.html")).toBe(false);
    expect(vanishBlockedExtension("chart.png")).toBe(false);
  });
});
