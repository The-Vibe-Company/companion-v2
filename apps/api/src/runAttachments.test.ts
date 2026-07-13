import { describe, expect, it, vi } from "vitest";
import {
  cleanupUnreferencedRunAttachments,
  deterministicRunAttachmentId,
  putRunAttachmentOnce,
} from "./runAttachments";

describe("idempotent run attachments", () => {
  it("derives stable ids from the complete uploaded file payload", () => {
    const base = {
      orgId: "org",
      actorId: "user",
      idempotencyKey: "request-key",
      index: 0,
      fileName: "input.txt",
      contentType: "text/plain",
      bytes: Buffer.from("one"),
    };
    expect(deterministicRunAttachmentId(base)).toBe(deterministicRunAttachmentId(base));
    expect(deterministicRunAttachmentId(base)).not.toBe(
      deterministicRunAttachmentId({ ...base, bytes: Buffer.from("two") }),
    );
    expect(deterministicRunAttachmentId(base)).not.toBe(
      deterministicRunAttachmentId({ ...base, contentType: "application/octet-stream" }),
    );
  });

  it("marks only newly-created objects for cleanup across replay and partial conflict", async () => {
    const objects = new Set<string>();
    const put = vi.fn(async ({ key }: { key: string }) => {
      if (objects.has(key)) {
        const error = new Error("already exists") as Error & { name: string; $metadata: { httpStatusCode: number } };
        error.name = "PreconditionFailed";
        error.$metadata = { httpStatusCode: 412 };
        throw error;
      }
      objects.add(key);
    });
    const createdKeys: string[] = [];
    const store = async (key: string) => {
      const result = await putRunAttachmentOnce({
        key,
        body: Buffer.from(key),
        contentType: "text/plain",
        put: put as never,
      });
      if (result === "created") createdKeys.push(key);
      return result;
    };

    expect(await store("shared")).toBe("created");
    createdKeys.length = 0; // the first request committed and owns no cleanup work
    expect(await store("shared")).toBe("existing");
    expect(await store("conflicting-new-file")).toBe("created");

    for (const key of createdKeys) objects.delete(key);
    expect(objects.has("shared")).toBe(true);
    expect(objects.has("conflicting-new-file")).toBe(false);
  });

  it("deletes only newly-created keys durably proven unreferenced", async () => {
    const deleteObject = vi.fn(async () => undefined);
    const findReferencedKeys = vi.fn(async () => ["committed"]);

    await cleanupUnreferencedRunAttachments({
      storageKeys: ["committed", "orphan", "orphan"],
      findReferencedKeys,
      deleteObject,
    });

    expect(findReferencedKeys).toHaveBeenCalledWith(["committed", "orphan"]);
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith("orphan");
  });

  it("retains every object when durable reference verification fails", async () => {
    const deleteObject = vi.fn(async () => undefined);

    await expect(
      cleanupUnreferencedRunAttachments({
        storageKeys: ["possibly-committed"],
        findReferencedKeys: async () => {
          throw new Error("database outcome unknown");
        },
        deleteObject,
      }),
    ).resolves.toBeUndefined();

    expect(deleteObject).not.toHaveBeenCalled();
  });
});
