import { describe, expect, it } from "vitest";
import {
  deleteSkillArchive,
  headSkillArchive,
  isStoragePreconditionFailure,
  putSkillArchive,
  skillArchiveKey,
} from "../src";

describe("skillArchiveKey", () => {
  it("uses the stable tenant/slug/version path", () => {
    expect(skillArchiveKey({ orgId: "org-1", slug: "pdf-extract", version: "1.2.3" })).toBe(
      "org-1/pdf-extract/1.2.3.tar.gz",
    );
  });
});

describe("putSkillArchive", () => {
  it("can send a conditional put to preserve immutable version keys", async () => {
    const sent: unknown[] = [];
    const client = {
      send: async (command: { input: unknown }) => {
        sent.push(command.input);
        return { ETag: '"etag-1"' };
      },
    };

    await putSkillArchive({
      key: "org-1/pdf-extract/1.2.3.tar.gz",
      body: new Uint8Array([1, 2, 3]),
      preventOverwrite: true,
      client: client as never,
      config: {
        endpoint: "http://127.0.0.1:9000",
        region: "us-east-1",
        accessKeyId: "companion",
        secretAccessKey: "companion-secret",
        bucket: "skill-archives",
        forcePathStyle: true,
      },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ IfNoneMatch: "*" });
  });

  it("supports ETag compare-and-swap and forwards cancellation", async () => {
    const sent: Array<{ input: unknown; signal: AbortSignal | undefined }> = [];
    const controller = new AbortController();
    const client = {
      send: async (command: { input: unknown }, options?: { abortSignal?: AbortSignal }) => {
        sent.push({ input: command.input, signal: options?.abortSignal });
        return { ETag: '"etag-2"' };
      },
    };
    const config = {
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      accessKeyId: "companion",
      secretAccessKey: "companion-secret",
      bucket: "skill-archives",
      forcePathStyle: true,
    };

    await expect(putSkillArchive({
      key: "org-1/run-artifacts/run-1/artifact-1",
      body: new Uint8Array([1]),
      ifMatch: '"etag-1"',
      signal: controller.signal,
      client: client as never,
      config,
    })).resolves.toBe('"etag-2"');

    expect(sent[0]).toMatchObject({ input: { IfMatch: '"etag-1"' }, signal: controller.signal });
  });
});

describe("headSkillArchive", () => {
  it("returns the current ETag and treats a missing key as absent", async () => {
    const config = {
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      accessKeyId: "companion",
      secretAccessKey: "companion-secret",
      bucket: "skill-archives",
      forcePathStyle: true,
    };
    await expect(headSkillArchive({
      key: "key",
      client: { send: async () => ({ ETag: '"etag"' }) } as never,
      config,
    })).resolves.toEqual({ etag: '"etag"' });
    await expect(headSkillArchive({
      key: "missing",
      client: { send: async () => { throw Object.assign(new Error("missing"), { name: "NotFound" }); } } as never,
      config,
    })).resolves.toBeNull();
  });

  it("recognizes S3 precondition failures", () => {
    expect(isStoragePreconditionFailure(Object.assign(new Error("collision"), { name: "PreconditionFailed" }))).toBe(true);
    expect(isStoragePreconditionFailure({ $metadata: { httpStatusCode: 412 } })).toBe(true);
    expect(isStoragePreconditionFailure(new Error("other"))).toBe(false);
  });
});

describe("deleteSkillArchive", () => {
  it("forwards an ETag precondition and abort signal", async () => {
    const sent: Array<{ input: unknown; signal?: AbortSignal }> = [];
    const controller = new AbortController();
    await deleteSkillArchive({
      key: "org/run-artifacts/run/artifact",
      ifMatch: '"old-etag"',
      signal: controller.signal,
      client: {
        send: async (command: { input: unknown }, options?: { abortSignal?: AbortSignal }) => {
          sent.push({ input: command.input, signal: options?.abortSignal });
          return {};
        },
      } as never,
      config: {
        endpoint: "http://127.0.0.1:9000",
        region: "us-east-1",
        accessKeyId: "companion",
        secretAccessKey: "companion-secret",
        bucket: "skill-archives",
        forcePathStyle: true,
      },
    });
    expect(sent).toEqual([{
      input: expect.objectContaining({ IfMatch: '"old-etag"' }),
      signal: controller.signal,
    }]);
  });
});
